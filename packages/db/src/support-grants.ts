import type pg from "pg";
import { runInTransactionScope } from "./outside-calls.js";
import { setContext, type Queryable } from "./tenancy.js";

/**
 * Support grants (M8-10; spec 02 · Support access). Our staff request one in
 * the Console; only the venue's owner approves it. While it's open, a support
 * session reads through the masked views in a read-only transaction as
 * app_support (withSupport); a write grant spends its one named action once
 * (spendSupportAction), in an ordinary transaction that carries
 * app.support_grant_id, so every audit row names both our staff member
 * (actor) and the grant.
 */
export type SupportScope = "read" | "write";
export type SupportGrantStatus = "requested" | "approved" | "declined" | "revoked";

export interface SupportGrantRow {
  readonly id: string;
  readonly venue_id: string;
  readonly staff_id: string;
  readonly staff_name: string | null;
  readonly requested_by: string;
  readonly reason: string;
  readonly scope: SupportScope;
  readonly action: string | null;
  readonly minutes: number;
  readonly status: SupportGrantStatus;
  readonly approved_by: string | null;
  readonly second_approver: string | null;
  readonly requested_at: string;
  readonly decided_at: string | null;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly revoked_at: string | null;
  readonly revoked_side: "venue" | "support" | null;
  readonly action_used_at: string | null;
}

const ts = (col: string) => `to_json(g.${col}) #>> '{}' as ${col}`;
const COLS = [
  "g.id",
  "g.venue_id",
  "g.staff_id",
  "s.name as staff_name",
  "g.requested_by",
  "g.reason",
  "g.scope",
  "g.action",
  "g.minutes::int as minutes",
  "g.status",
  "g.approved_by",
  "g.second_approver",
  ts("requested_at"),
  ts("decided_at"),
  ts("starts_at"),
  ts("ends_at"),
  ts("revoked_at"),
  "g.revoked_side",
  ts("action_used_at"),
].join(", ");
const FROM = "support_grants g left join console_staff s on s.id = g.staff_id";

/** Where a grant stands at a moment: waiting, open, ended (its time ran out), declined or revoked. */
export type SupportGrantState = "waiting" | "open" | "ended" | "declined" | "revoked";

export function supportGrantState(
  g: Pick<SupportGrantRow, "status" | "starts_at" | "ends_at">,
  atMs: number,
): SupportGrantState {
  if (g.status === "requested") return "waiting";
  if (g.status === "declined") return "declined";
  if (g.status === "revoked") return "revoked";
  const starts = Date.parse(g.starts_at ?? "");
  const ends = Date.parse(g.ends_at ?? "");
  return starts <= atMs && atMs < ends ? "open" : "ended";
}

export async function requestSupportGrant(
  c: Queryable,
  input: {
    venueId: string;
    staffId: string;
    reason: string;
    scope: SupportScope;
    action: string | null;
    minutes: number;
    at: string;
  },
): Promise<SupportGrantRow> {
  const r = await c.query<{ id: string }>(
    `insert into support_grants (venue_id, staff_id, requested_by, reason, scope, action, minutes, requested_at)
     values ($1, $2, $2, $3, $4, $5, $6, $7) returning id`,
    [
      input.venueId,
      input.staffId,
      input.reason,
      input.scope,
      input.action,
      input.minutes,
      input.at,
    ],
  );
  return (await supportGrant(c, input.venueId, r.rows[0]!.id))!;
}

export async function supportGrant(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<SupportGrantRow | null> {
  const r = await c.query<SupportGrantRow>(
    `select ${COLS} from ${FROM} where g.venue_id = $1 and g.id = $2`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** The venue's grants, newest first (the last 50). */
export async function supportGrants(c: Queryable, venueId: string): Promise<SupportGrantRow[]> {
  const r = await c.query<SupportGrantRow>(
    `select ${COLS} from ${FROM} where g.venue_id = $1 order by g.requested_at desc limit 50`,
    [venueId],
  );
  return r.rows;
}

/** The owner's answer to a waiting request: approve opens it now for its minutes. */
export async function decideSupportGrant(
  c: Queryable,
  input: {
    venueId: string;
    id: string;
    decision: "approve" | "decline";
    userId: string;
    at: string;
  },
): Promise<SupportGrantRow | null> {
  const r =
    input.decision === "approve"
      ? await c.query(
          `update support_grants
              set status = 'approved', approved_by = $3, decided_at = $4,
                  starts_at = $4, ends_at = $4::timestamptz + make_interval(mins => minutes)
            where venue_id = $1 and id = $2 and status = 'requested'`,
          [input.venueId, input.id, input.userId, input.at],
        )
      : await c.query(
          `update support_grants set status = 'declined', approved_by = $3, decided_at = $4
            where venue_id = $1 and id = $2 and status = 'requested'`,
          [input.venueId, input.id, input.userId, input.at],
        );
  if (r.rowCount === 0) return null;
  return supportGrant(c, input.venueId, input.id);
}

/**
 * Ends a grant at once, from either side: a waiting request is withdrawn, an
 * open grant closes. A grant that already ended, or was declined, stays as it is.
 */
export async function revokeSupportGrant(
  c: Queryable,
  input: { venueId: string; id: string; by: string; side: "venue" | "support"; at: string },
): Promise<SupportGrantRow | null> {
  const r = await c.query(
    `update support_grants set status = 'revoked', revoked_at = $3, revoked_by = $4, revoked_side = $5
      where venue_id = $1 and id = $2
        and (status = 'requested' or (status = 'approved' and ends_at > $3::timestamptz))`,
    [input.venueId, input.id, input.at, input.by, input.side],
  );
  if (r.rowCount === 0) return null;
  return supportGrant(c, input.venueId, input.id);
}

/** The Console's authenticator: the venue of an open grant for this staff member, or null. */
export async function resolveSupportGrant(
  c: Queryable,
  input: { grantId: string; staffId: string; at: string },
): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(input.grantId)) return null;
  const r = await c.query<{ venue_id: string | null }>(
    "select resolve_support_grant($1, $2, $3) as venue_id",
    [input.grantId, input.staffId, input.at],
  );
  return r.rows[0]?.venue_id ?? null;
}

export class SupportGrantClosed extends Error {
  constructor() {
    super("the support grant isn't open");
  }
}

export interface SupportContext {
  readonly venueId: string;
  readonly staffId: string;
  readonly grantId: string;
  readonly requestId?: string | undefined;
  /** The server's clock (the simulated one in demos and tests). */
  readonly at: string;
}

async function setSupportContext(client: Queryable, context: SupportContext): Promise<void> {
  await setContext(client, {
    venueId: context.venueId,
    userId: context.staffId,
    requestId: context.requestId,
  });
  await client.query("select set_config('app.support_grant_id', $1, true)", [context.grantId]);
}

async function grantOpen(client: Queryable, context: SupportContext): Promise<boolean> {
  const r = await client.query(
    `select 1 from support_grants
      where venue_id = $1 and id = $2 and staff_id = $3 and status = 'approved'
        and starts_at <= $4::timestamptz and ends_at > $4::timestamptz`,
    [context.venueId, context.grantId, context.staffId, context.at],
  );
  return r.rowCount === 1;
}

/**
 * A support session's transaction: SET TRANSACTION READ ONLY, the grant
 * checked open at `at`, then the role switched to app_support, which may read
 * the masked views and nothing else. Every write inside fails as read-only.
 */
export async function withSupport<T>(
  pool: pg.Pool,
  context: SupportContext,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set transaction read only");
    await setSupportContext(client, context);
    if (!(await grantOpen(client, context))) throw new SupportGrantClosed();
    await client.query("set local role app_support");
    const result = await runInTransactionScope("support transaction", () => work(client));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A write grant's one named action, once: the grant is marked spent in the
 * same transaction as the action, so a second try (or another action) finds
 * nothing to spend. Runs as app_rw with the grant set, so every audit row the
 * action writes names our staff member and the grant.
 */
export async function withSupportAction<T>(
  pool: pg.Pool,
  context: SupportContext & { readonly action: string },
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await setSupportContext(client, context);
    const spent = await client.query(
      `update support_grants set action_used_at = $5
        where venue_id = $1 and id = $2 and staff_id = $3 and scope = 'write' and action = $4
          and action_used_at is null and status = 'approved'
          and starts_at <= $5::timestamptz and ends_at > $5::timestamptz`,
      [context.venueId, context.grantId, context.staffId, context.action, context.at],
    );
    if (spent.rowCount !== 1) throw new SupportGrantClosed();
    const result = await runInTransactionScope("support action transaction", () => work(client));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface SupportGuest {
  readonly id: string;
  readonly name: string;
  readonly phone_masked: string | null;
  readonly has_email: boolean;
  readonly last_seen_at: string | null;
}

export interface SupportCheck {
  readonly id: string;
  readonly number: string;
  readonly kind: string;
  readonly status: string;
  readonly business_date: string;
}

export interface SupportPrintJob {
  readonly id: string;
  readonly kind: string;
  readonly station: string;
  readonly status: string;
  readonly reprint_n: number;
  readonly failed_at: string | null;
}

/** What a support session reads: the masked views only. */
export async function supportSnapshot(c: Queryable): Promise<{
  guests: SupportGuest[];
  checks: SupportCheck[];
  print_jobs: SupportPrintJob[];
}> {
  const guests = await c.query<SupportGuest>(
    `select id, name, phone_masked, has_email, to_json(last_seen_at) #>> '{}' as last_seen_at
       from support_guests where erased_at is null order by last_seen_at desc nulls last, name limit 50`,
  );
  const checks = await c.query<SupportCheck>(
    `select id, number::text as number, kind, status, business_date::text as business_date
       from support_checks where not training order by opened_at desc limit 50`,
  );
  const jobs = await c.query<SupportPrintJob>(
    `select id, kind, station, status, reprint_n, to_json(failed_at) #>> '{}' as failed_at
       from support_print_jobs order by created_at desc limit 20`,
  );
  return { guests: guests.rows, checks: checks.rows, print_jobs: jobs.rows };
}
