import type pg from "pg";
import type { Queryable } from "./tenancy.js";

/**
 * Restoring one venue from a scratch copy (M8-20; spec 13 · Backups and
 * restore). The cluster is restored, at a point in time, to a scratch copy;
 * this reads one venue's rows from that copy and puts back the ones
 * production is missing, without touching any other venue:
 *
 *   - every read and every write runs as app_migrator with app.venue_id set,
 *     so the restore_wall policies (0122) confine both sides to the venue;
 *   - money rows, and every other row, are only inserted, never overwritten
 *     (insert … on conflict do nothing);
 *   - the menu comes back as new versions of its rows (an audited update);
 *   - settings come back as new versions: a key whose current value differs
 *     gets one more version, taking effect on the given business date;
 *   - each batch is its own short transaction, so nothing is held open while
 *     the other venues keep working, and every restored row is audited under
 *     the request id `restore:<id>`.
 *
 * Never restored: the audit log (production keeps its own hash chain, and the
 * restore's inserts are audited there), the realtime feed (venue_events: old
 * events would reach screens again), the job queue (old jobs would text and
 * charge again; the pull after the restore does that work through the usual
 * paths) and the restore log itself.
 */

export const RESTORE_EXCLUDED: ReadonlySet<string> = new Set([
  "audit_log",
  "venue_events",
  "jobs",
  "restores",
]);

/** The menu (0043): its rows come back as new versions. */
export const RESTORE_MENU_TABLES: ReadonlySet<string> = new Set([
  "menu_categories",
  "menu_items",
  "menu_variants",
  "modifier_groups",
  "menu_options",
  "packages",
  "price_rules",
]);

/** Triggers that never step aside for a restore, or belong to a table it never writes. */
const TRIGGERS_ALLOWED = new Set(["audit_row", "truncate_alert", "venue_events_notify"]);

export type RestoreMode = "insert" | "menu" | "settings";

export interface RestoreTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly identityAlways: boolean;
  readonly mode: RestoreMode;
}

export interface RestoreCounts {
  inserted: Record<string, number>;
  updated: Record<string, number>;
  settingsVersions: number;
  /** Rows the copy had that production refused, by table, with the first reason. */
  skipped: Record<string, { rows: number; reason: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Every venue table (a venue_id column), with the restore's mode. */
async function venueTables(c: Queryable): Promise<RestoreTable[]> {
  const r = await c.query<{ name: string; columns: string[]; identity_always: boolean }>(
    `select c.relname as name,
            array_agg(a.attname::text order by a.attnum) filter (where a.attgenerated = '') as columns,
            bool_or(a.attidentity = 'a') as identity_always
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and exists (select 1 from pg_attribute v where v.attrelid = c.oid and v.attname = 'venue_id' and not v.attisdropped)
      group by c.relname
      order by c.relname`,
  );
  return r.rows.map((t) => ({
    name: t.name,
    columns: t.columns,
    identityAlways: t.identity_always,
    mode:
      t.name === "venue_settings"
        ? "settings"
        : RESTORE_MENU_TABLES.has(t.name)
          ? "menu"
          : "insert",
  }));
}

/**
 * The venue tables the restore writes, parents before children (foreign keys
 * between venue tables). Tables in a cycle come last, in name order; their
 * rows that need a parent first are retried after everything else.
 */
export async function restorePlan(c: Queryable): Promise<RestoreTable[]> {
  const tables = (await venueTables(c)).filter((t) => !RESTORE_EXCLUDED.has(t.name));
  const names = new Set(tables.map((t) => t.name));
  const fks = await c.query<{ child: string; parent: string }>(
    `select distinct ch.relname as child, pa.relname as parent
       from pg_constraint k
       join pg_class ch on ch.oid = k.conrelid
       join pg_class pa on pa.oid = k.confrelid
       join pg_namespace n on n.oid = ch.relnamespace
      where k.contype = 'f' and n.nspname = 'public' and ch.oid <> pa.oid`,
  );
  const parents = new Map<string, Set<string>>(tables.map((t) => [t.name, new Set<string>()]));
  for (const fk of fks.rows)
    if (names.has(fk.child) && names.has(fk.parent)) parents.get(fk.child)!.add(fk.parent);
  const ordered: RestoreTable[] = [];
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of tables) {
      if (done.has(t.name)) continue;
      if ([...parents.get(t.name)!].every((p) => done.has(p))) {
        ordered.push(t);
        done.add(t.name);
        progress = true;
      }
    }
  }
  for (const t of tables) if (!done.has(t.name)) ordered.push(t);
  return ordered;
}

/**
 * What stops a restore before it writes anything: a different schema on the
 * two sides, a scratch copy that is production itself, a venue missing from
 * either, a venue table without its wall, or a trigger that would fire on a
 * restored row without stepping aside.
 */
export async function restorePreflight(
  target: pg.Pool,
  scratch: pg.Pool,
  venueId: string,
): Promise<string[]> {
  const problems: string[] = [];
  const who = async (p: pg.Pool) =>
    (
      await p.query<{ db: string; sys: string }>(
        "select current_database() as db, coalesce(host(inet_server_addr()), 'local') || ':' || current_setting('port') as sys",
      )
    ).rows[0]!;
  const [t, s] = [await who(target), await who(scratch)];
  if (t.db === s.db && t.sys === s.sys)
    problems.push("the scratch copy is the production database itself");
  const migrations = async (p: pg.Pool) =>
    (await p.query<{ name: string }>("select name from schema_migrations order by name")).rows
      .map((r) => r.name)
      .join(",");
  if ((await migrations(target)) !== (await migrations(scratch)))
    problems.push(
      "the scratch copy's migrations differ from production's: run pnpm db:migrate on the scratch copy first",
    );
  for (const [side, p] of [
    ["production", target],
    ["the scratch copy", scratch],
  ] as const) {
    const v = await p.query("select 1 from venues where id = $1", [venueId]);
    if (v.rowCount === 0) problems.push(`the venue isn't in ${side}`);
  }
  const walls = await target.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'venue_id' and not a.attisdropped)
        and (not c.relforcerowsecurity
             or not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'restore_wall'))
      order by 1`,
  );
  for (const w of walls.rows) problems.push(`${w.name} has no restore wall`);
  const triggers = await target.query<{ name: string }>(
    `select c.relname || '.' || t.tgname as name
       from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc f on f.oid = t.tgfoid
       join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname = 'public' and t.tgname <> all($1::text[])
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'venue_id' and not a.attisdropped)
        and position('restoring()' in f.prosrc) = 0
      order by 1`,
    [[...TRIGGERS_ALLOWED]],
  );
  for (const tr of triggers.rows)
    problems.push(`the trigger ${tr.name} doesn't step aside for a restore (restoring())`);
  return problems;
}

export interface RestoreContext {
  readonly venueId: string;
  readonly restoreId: string;
}

/** One transaction on `pool` as app_migrator, walled to the venue and named as the restore. */
export async function asRestore<T>(
  pool: pg.Pool,
  ctx: RestoreContext,
  work: (c: pg.PoolClient) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      options.readOnly ? "begin isolation level repeatable read read only" : "begin",
    );
    await client.query("set local role app_migrator");
    await client.query("select set_config('app.venue_id', $1, true)", [ctx.venueId]);
    await client.query("select set_config('app.restore_id', $1, true)", [ctx.restoreId]);
    await client.query("select set_config('app.request_id', $1, true)", [
      `restore:${ctx.restoreId}`,
    ]);
    const out = await work(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function insertSql(t: RestoreTable): string {
  const cols = t.columns.map(ident).join(", ");
  const head = `insert into ${ident(t.name)} (${cols})${t.identityAlways ? " overriding system value" : ""}
    select ${cols} from jsonb_populate_recordset(null::${ident(t.name)}, $1::jsonb)`;
  if (t.mode === "menu") {
    const set = t.columns.filter((c) => c !== "id" && c !== "venue_id");
    return `${head}
      on conflict (id) do update set ${set.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}
      where (${set.map((c) => `${ident(t.name)}.${ident(c)}`).join(", ")}) is distinct from (${set
        .map((c) => `excluded.${ident(c)}`)
        .join(", ")})
      returning (xmax = 0) as inserted`;
  }
  return `${head} on conflict do nothing returning true as inserted`;
}

function tally(counts: RestoreCounts, table: string, rows: { inserted: boolean }[]): void {
  for (const r of rows) {
    const bucket = r.inserted ? counts.inserted : counts.updated;
    bucket[table] = (bucket[table] ?? 0) + 1;
  }
}

/** One batch, or row by row when the batch is refused; rows waiting on a parent come back. */
async function applyBatch(
  target: pg.Pool,
  ctx: RestoreContext,
  t: RestoreTable,
  rows: unknown[],
  counts: RestoreCounts,
  failed: Map<string, string>,
): Promise<unknown[]> {
  const sql = insertSql(t);
  try {
    const r = await asRestore(target, ctx, (c) =>
      c.query<{ inserted: boolean }>(sql, [JSON.stringify(rows)]),
    );
    tally(counts, t.name, r.rows);
    return [];
  } catch {
    // Row by row, each behind a savepoint; a missing parent (23503) waits for a later pass.
  }
  const waiting: unknown[] = [];
  await asRestore(target, ctx, async (c) => {
    for (const row of rows) {
      await c.query("savepoint r");
      try {
        const r = await c.query<{ inserted: boolean }>(sql, [JSON.stringify([row])]);
        tally(counts, t.name, r.rows);
        await c.query("release savepoint r");
      } catch (e) {
        await c.query("rollback to savepoint r");
        const err = e as { code?: string; message?: string };
        if (err.code === "23503") waiting.push(row);
        else if (!failed.has(t.name)) failed.set(t.name, `${err.code ?? "?"}: ${err.message ?? e}`);
        if (err.code !== "23503") {
          const s = (counts.skipped[t.name] ??= { rows: 0, reason: failed.get(t.name)! });
          s.rows += 1;
        }
      }
    }
  });
  return waiting;
}

/**
 * Settings: a key production lost comes back with its whole history as it
 * was (so past nights still read the settings they ran on); a key whose
 * current value differs from the copy's gets one more version, taking effect
 * on the given business date.
 */
async function applySettings(
  target: pg.Pool,
  scratch: pg.Pool,
  ctx: RestoreContext,
  businessDate: string,
  counts: RestoreCounts,
): Promise<void> {
  const copy = await asRestore(scratch, ctx, (c) =>
    c.query<{
      key: string;
      version: number;
      value: unknown;
      saved_by: string | null;
      saved_at: string;
      starts_on: string;
    }>(
      `select key, version, value, saved_by, saved_at, to_char(starts_on, 'YYYY-MM-DD') as starts_on
         from venue_settings where venue_id = $1 order by key, version`,
      [ctx.venueId],
    ),
  );
  const byKey = new Map<string, typeof copy.rows>();
  for (const row of copy.rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
  await asRestore(target, ctx, async (c) => {
    const now = await c.query<{ key: string; value: unknown }>(
      `select distinct on (key) key, value from venue_settings
        where venue_id = $1 order by key, version desc`,
      [ctx.venueId],
    );
    const current = new Map(now.rows.map((r) => [r.key, JSON.stringify(r.value)]));
    for (const [key, versions] of byKey) {
      const was = current.get(key);
      if (was === undefined) {
        for (const v of versions)
          await c.query(
            `insert into venue_settings (venue_id, key, version, value, saved_by, saved_at, starts_on)
             values ($1, $2, $3, $4::jsonb, $5, $6, $7::date) on conflict do nothing`,
            [
              ctx.venueId,
              key,
              v.version,
              JSON.stringify(v.value),
              v.saved_by,
              v.saved_at,
              v.starts_on,
            ],
          );
        counts.inserted["venue_settings"] =
          (counts.inserted["venue_settings"] ?? 0) + versions.length;
        continue;
      }
      const latest = versions[versions.length - 1]!;
      const same = await c.query<{ same: boolean }>("select $1::jsonb = $2::jsonb as same", [
        was,
        JSON.stringify(latest.value),
      ]);
      if (same.rows[0]!.same) continue;
      await c.query(
        `insert into venue_settings (venue_id, key, version, value, saved_by, starts_on)
         select $1, $2, coalesce(max(version), 0) + 1, $3::jsonb, null, $4::date
           from venue_settings where venue_id = $1 and key = $2`,
        [ctx.venueId, key, JSON.stringify(latest.value), businessDate],
      );
      counts.settingsVersions += 1;
    }
  });
}

export interface ApplyOptions {
  readonly target: pg.Pool;
  readonly scratch: pg.Pool;
  readonly venueId: string;
  readonly restoreId: string;
  /** The business date a settings version written by the restore takes effect. */
  readonly businessDate: string;
  readonly batchSize?: number;
  /** Called after each table (the drill's progress, and the tests' hook). */
  readonly afterTable?: (table: string, index: number, of: number) => Promise<void> | void;
}

/** Put back the venue's rows production is missing. Run restorePreflight first. */
export async function applyVenueRestore(options: ApplyOptions): Promise<RestoreCounts> {
  const { target, scratch, venueId, restoreId } = options;
  if (!UUID.test(venueId) || !UUID.test(restoreId)) throw new Error("not a venue or restore id");
  const ctx = { venueId, restoreId };
  const size = options.batchSize ?? 500;
  const plan = await restorePlan(target);
  const counts: RestoreCounts = { inserted: {}, updated: {}, settingsVersions: 0, skipped: {} };
  const failed = new Map<string, string>();
  const waiting: { table: RestoreTable; rows: unknown[] }[] = [];
  let index = 0;
  for (const t of plan) {
    index += 1;
    if (t.mode === "settings") {
      await applySettings(target, scratch, ctx, options.businessDate, counts);
    } else {
      // One read-only snapshot of the copy per table, read through a cursor in batches.
      await asRestore(
        scratch,
        ctx,
        async (c) => {
          await c.query(
            `declare rows no scroll cursor for select to_jsonb(t) as r from ${ident(t.name)} t
              where t.venue_id = '${venueId}'::uuid`,
          );
          for (;;) {
            const batch = await c.query<{ r: unknown }>(`fetch ${size} from rows`);
            if (batch.rows.length === 0) break;
            const left = await applyBatch(
              target,
              ctx,
              t,
              batch.rows.map((b) => b.r),
              counts,
              failed,
            );
            if (left.length) waiting.push({ table: t, rows: left });
          }
        },
        { readOnly: true },
      );
    }
    await options.afterTable?.(t.name, index, plan.length);
  }
  // Rows that waited on a parent: again, until a pass puts nothing back.
  let pending = waiting;
  for (let pass = 0; pass < 10 && pending.length; pass += 1) {
    const next: typeof waiting = [];
    let before = 0;
    let after = 0;
    for (const w of pending) {
      before += w.rows.length;
      const left = await applyBatch(target, ctx, w.table, w.rows, counts, failed);
      after += left.length;
      if (left.length) next.push({ table: w.table, rows: left });
    }
    pending = next;
    if (after === before) break;
  }
  for (const w of pending) {
    const s = (counts.skipped[w.table.name] ??= {
      rows: 0,
      reason: "23503: a parent row is missing from both sides",
    });
    s.rows += w.rows.length;
  }
  return counts;
}

/**
 * A fingerprint of one venue's rows, per table: an md5 over every row's md5,
 * in order. Read through the venue's own wall, so it sees nothing else.
 */
export async function venueRowHashes(
  pool: pg.Pool,
  venueId: string,
): Promise<Record<string, string>> {
  const tables = (await venueTables(pool)).map((t) => t.name);
  return asRestore(
    pool,
    { venueId, restoreId: "" },
    async (c) => {
      const out: Record<string, string> = {};
      for (const t of tables) {
        const r = await c.query<{ h: string | null }>(
          `select md5(string_agg(h, '' order by h)) as h
             from (select md5(to_jsonb(t)::text) as h from ${ident(t)} t where t.venue_id = $1) x`,
          [venueId],
        );
        out[t] = r.rows[0]?.h ?? "empty";
      }
      return out;
    },
    { readOnly: true },
  );
}

export interface RestoreRow {
  readonly id: string;
  readonly kind: "restore" | "drill";
  readonly restore_point: string;
  readonly state: string;
  readonly started_at: string;
  readonly applied_at: string | null;
  readonly finished_at: string | null;
}

export async function startRestoreRecord(
  target: pg.Pool,
  input: {
    venueId: string;
    restoreId: string;
    kind: "restore" | "drill";
    restorePoint: string;
    scratch: string;
    startedAt: string;
    rtoTargetS: number;
  },
): Promise<void> {
  await asRestore(target, input, (c) =>
    c.query(
      `insert into restores (id, venue_id, kind, restore_point, scratch, started_at, rto_target_s)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.restoreId,
        input.venueId,
        input.kind,
        input.restorePoint,
        input.scratch,
        input.startedAt,
        input.rtoTargetS,
      ],
    ),
  );
}

export async function updateRestoreRecord(
  target: pg.Pool,
  ctx: RestoreContext,
  fields: Partial<{
    state: "applying" | "pulling" | "done" | "failed";
    applied_at: string;
    finished_at: string;
    inserted: unknown;
    updated: unknown;
    settings_versions: number;
    skipped: unknown;
    pulled: unknown;
    erasures_reapplied: number;
    stripe_check: unknown;
    within_target: boolean;
    failure: string;
  }>,
): Promise<void> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (!keys.length) return;
  const json = new Set(["inserted", "updated", "skipped", "pulled", "stripe_check"]);
  const values = keys.map((k) => (json.has(k) ? JSON.stringify(fields[k]) : fields[k]));
  await asRestore(target, ctx, (c) =>
    c.query(
      `update restores set ${keys.map((k, i) => `${ident(k)} = $${i + 3}`).join(", ")}
        where venue_id = $1 and id = $2`,
      [ctx.venueId, ctx.restoreId, ...values],
    ),
  );
}
