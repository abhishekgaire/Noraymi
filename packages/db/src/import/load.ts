import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  businessDate,
  isBalanced,
  openingJournal,
  type Journal,
  type Promotable,
} from "@west4/rules";
import { insertMenuRow, menuPromotionRefusals, patchMenuRow, queueMenuPdf } from "../menu.js";
import { emitEvent } from "../events.js";
import { publishBarLayout, type LayoutResult } from "./layout.js";
import { Temporal } from "@west4/shared";
import {
  insertLegacyDeposit,
  LIVE_STATUSES,
  manageToken,
  placeBooking,
  refundCutoff,
  sha256,
} from "./bookings.js";
import { consentOutcome, storedKind } from "./consents.js";
import type { Kind } from "./mapping.js";
import type { Prepared, Problem } from "./prepare.js";

/**
 * Loading prepared records into one venue, as the audited migration role
 * (app_migrator) behind the restore_wall policies, so nothing can land in
 * another venue. Every row is audited with app.request_id = 'import:<run>'.
 *
 * A live run commits in batches and is idempotent on each record's legacy
 * reference (import_refs): a second run adds only records it hasn't seen,
 * and a record that changed in the old system since is reported, not
 * applied. A dry run does the same work in one transaction, writes the
 * reconciliation report from what it loaded, then rolls everything back and
 * keeps only the run's report.
 */
export interface Venue {
  readonly id: string;
  readonly timeZone: string;
  readonly cutover: string;
}

type RefKind =
  | "guest"
  | "person"
  | "menu_category"
  | "menu_item"
  | "menu_variant"
  | "modifier_group"
  | "menu_option"
  | "package"
  | "policy"
  | "booking"
  | "consent"
  | "nightly_total";

export interface KindTally {
  in_files: number;
  loaded: number;
  already: number;
  changed: number;
  /** Cents in the files, where the kind carries money (bookings: deposits; menu: prices; totals: net sales). */
  cents_in_files?: number;
  /** Cents in the database for every record of the files (loaded now or before). */
  cents_in_db?: number;
  /** Records of the files found in the database (loaded now or before). */
  in_db: number;
  by?: Record<string, number>;
}

export interface ImportReport {
  readonly run_id: string;
  readonly mode: "dry_run" | "live";
  readonly venue_id: string;
  readonly mapping: { source: string; version: number };
  readonly files: Prepared["files"];
  readonly kinds: Partial<Record<Kind, KindTally>>;
  /** Changed records: in an earlier run with different values. Listed for a manager, never applied. */
  readonly changed: readonly { kind: Kind; file: string; line: number; legacy_ref: string }[];
  /**
   * The deposits of the bookings still to come that this run loaded (M9-02): held for the guests
   * as `external` payments, or with the booking on the manager's list; the opening journal puts
   * all of them in customer deposits on the cutover date.
   */
  readonly deposits: {
    readonly cutover_date: string;
    readonly held_cents: number;
    readonly payments_cents: number;
    readonly on_list_cents: number;
  };
  readonly opening_journal: Journal;
  /** Bookings still to come that fit no room: on the manager's list, never dropped. */
  readonly no_room: readonly { legacy_ref: string; file: string; line: number }[];
  /**
   * The consents in the files by what they became (M9-03): marketing opt-ins with their proof,
   * opt-outs (honored at once), service-text opt-ins, and marketing opt-ins dropped for lack of
   * proof, which are listed with what's missing and never imported as consent.
   */
  readonly consents: {
    readonly marketing_with_proof: number;
    readonly opt_outs: number;
    readonly service: number;
    readonly dropped_no_proof: number;
    readonly dropped: readonly {
      file: string;
      line: number;
      legacy_ref: string;
      missing: string[];
    }[];
  };
  /** Imported with a value left out, for a manager to see (a phone number that isn't +1). */
  readonly listed: Prepared["listed"];
  /** The bar grid version the menu import published (M9-04), or null when the menu didn't change. */
  readonly layout: LayoutResult | null;
  /** True when every kind's records and cents in the files are in the database. */
  readonly reconciles: boolean;
}

export class ImportInvalid extends Error {
  constructor(readonly problems: readonly Problem[]) {
    super(
      `${problems.length} problem(s), nothing loaded:\n` +
        problems.map((p) => `  ${p.file}:${p.line} ${p.message}`).join("\n"),
    );
  }
}

export async function resolveVenue(c: pg.ClientBase, ref: string): Promise<Venue> {
  const r = await c.query<{ id: string; time_zone: string; cutover: string }>(
    `select id, time_zone, to_char(day_cutover, 'HH24:MI') as cutover from venues
      where id::text = $1 or slug = $1`,
    [ref],
  );
  const v = r.rows[0];
  if (!v || r.rows.length > 1) throw new Error(`no single venue "${ref}"`);
  return { id: v.id, timeZone: v.time_zone, cutover: v.cutover };
}

/** One transaction as app_migrator, walled to the venue and named as the import run. */
async function asImport<T>(
  pool: pg.Pool,
  venueId: string,
  runId: string,
  work: (c: pg.PoolClient) => Promise<T>,
  options: { rollback?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role app_migrator");
    await client.query("select set_config('app.venue_id', $1, true)", [venueId]);
    await client.query("select set_config('app.request_id', $1, true)", [`import:${runId}`]);
    const out = await work(client);
    await client.query(options.rollback ? "rollback" : "commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Checks against the venue's own rows: rooms by name, guests known from an earlier run. */
async function preflight(c: pg.ClientBase, p: Prepared): Promise<Problem[]> {
  const problems: Problem[] = [];
  const rooms = await c.query<{ name: string }>(
    "select lower(name) as name from rooms where archived_at is null",
  );
  const roomNames = new Set(rooms.rows.map((r) => r.name));
  const earlier = await c.query<{ legacy_ref: string }>(
    "select legacy_ref from import_refs where kind = 'guest'",
  );
  const guestRefs = new Set([
    ...p.guests.map((g) => g.legacyRef),
    ...earlier.rows.map((r) => r.legacy_ref),
  ]);
  for (const b of p.bookings) {
    if (!roomNames.has(b.room.toLowerCase())) {
      problems.push({
        file: b.file,
        line: b.line,
        message: `room "${b.room}" isn't one of the venue's rooms`,
      });
    }
    if (!guestRefs.has(b.guestRef)) {
      problems.push({
        file: b.file,
        line: b.line,
        message: `guest "${b.guestRef}" isn't in the guests file`,
      });
    }
    if (b.policyRef !== null && !p.policies.some((x) => x.legacyRef === b.policyRef)) {
      problems.push({
        file: b.file,
        line: b.line,
        message: `terms "${b.policyRef}" aren't in the policies file`,
      });
    }
  }
  // The menu (M9-04): one item's rows agree on the item, one category's on its tax category, and
  // every choice and package names an item the import knows.
  const items = new Map<string, Prepared["menu"][number]>();
  const categories = new Map<string, string>();
  for (const m of p.menu) {
    const first = items.get(m.itemRef);
    if (first && itemHash(first) !== itemHash(m))
      problems.push({
        file: m.file,
        line: m.line,
        message: `item "${m.itemRef}" differs from line ${first.line} (name, category, alcohol, button name, station or grid section)`,
      });
    else if (!first) items.set(m.itemRef, m);
    const tax = categories.get(m.category.toLowerCase());
    if (tax !== undefined && tax !== m.taxCategory)
      problems.push({
        file: m.file,
        line: m.line,
        message: `category "${m.category}" has tax category ${tax} on another line`,
      });
    else categories.set(m.category.toLowerCase(), m.taxCategory);
  }
  const earlierItems = await c.query<{ legacy_ref: string }>(
    "select legacy_ref from import_refs where kind = 'menu_item'",
  );
  const itemRefs = new Set([...items.keys(), ...earlierItems.rows.map((r) => r.legacy_ref)]);
  const groups = new Map<string, string>();
  for (const x of p.modifiers) {
    if (!itemRefs.has(x.itemRef))
      problems.push({
        file: x.file,
        line: x.line,
        message: `item "${x.itemRef}" isn't in the menu file`,
      });
    const key = `${x.itemRef}|${x.group.toLowerCase()}`;
    const shape = [x.required, x.minChoices, x.maxChoices].join("|");
    if (groups.has(key) && groups.get(key) !== shape)
      problems.push({
        file: x.file,
        line: x.line,
        message: `choice group "${x.group}" is required or counted differently on another line`,
      });
    else groups.set(key, shape);
  }
  for (const x of p.packages)
    for (const k of x.contents)
      if (!itemRefs.has(k.itemRef))
        problems.push({
          file: x.file,
          line: x.line,
          message: `item "${k.itemRef}" isn't in the menu file`,
        });
  for (const x of p.consents) {
    if (!guestRefs.has(x.guestRef)) {
      problems.push({
        file: x.file,
        line: x.line,
        message: `guest "${x.guestRef}" isn't in the guests file`,
      });
    }
  }
  return problems;
}

/** The import run's ref, inserted first: false when an earlier run already has this record. */
async function claim(
  c: pg.ClientBase,
  venueId: string,
  runId: string,
  kind: RefKind,
  legacyRef: string,
  table: string,
  targetId: string,
  hash: string,
): Promise<"new" | "already" | "changed"> {
  const r = await c.query(
    `insert into import_refs (venue_id, kind, legacy_ref, target_table, target_id, row_hash, run_id)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
    [venueId, kind, legacyRef, table, targetId, hash, runId],
  );
  if (r.rowCount === 1) return "new";
  const old = await c.query<{ row_hash: string }>(
    "select row_hash from import_refs where kind = $1 and legacy_ref = $2",
    [kind, legacyRef],
  );
  return old.rows[0]?.row_hash === hash ? "already" : "changed";
}

async function refId(c: pg.ClientBase, kind: RefKind, legacyRef: string): Promise<string> {
  const r = await c.query<{ target_id: string }>(
    "select target_id from import_refs where kind = $1 and legacy_ref = $2",
    [kind, legacyRef],
  );
  const id = r.rows[0]?.target_id;
  if (!id) throw new Error(`no imported ${kind} "${legacyRef}"`);
  return id;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The PIN's length a role sets (spec 02 · PINs): the same rule as an invite from Admin → Team. */
export const pinDigitsFor = (role: string): 4 | 6 =>
  role === "owner" || role === "manager" ? 6 : 4;

const MENU_KINDS: ReadonlySet<Kind> = new Set(["menu", "modifiers", "packages"]);

/** An item's own values: rows of one item must agree on them, and a re-run compares them. */
const itemHash = (m: Prepared["menu"][number]) =>
  sha256(JSON.stringify([m.name, m.category, m.alcohol, m.buttonName, m.station, m.posSection]));

const KIND_OF: Record<Kind, RefKind> = {
  guests: "guest",
  people: "person",
  menu: "menu_variant",
  modifiers: "menu_option",
  packages: "package",
  policies: "policy",
  bookings: "booking",
  consents: "consent",
  nightly_totals: "nightly_total",
};

export interface RunOptions {
  readonly pool: pg.Pool;
  readonly venue: Venue;
  readonly prepared: Prepared;
  readonly dryRun: boolean;
  readonly batchSize?: number;
  readonly log?: (line: string) => void;
  /** The cutover's business date: imported deposits are recorded and journaled on it. Defaults to today's. */
  readonly cutoverDate?: string;
  /** The time the import runs at (the clock in tests); the bar grid's new version starts the business date after it. */
  readonly now?: Temporal.Instant;
}

/** A live run's result: the report, and each imported booking's manage link token (never stored or logged). */
export interface ImportResult extends ImportReport {
  readonly manage_links: readonly { legacy_ref: string; token: string }[];
}

/** Validates against the venue, loads (or rehearses) the records, and returns the reconciliation report. */
export async function runImport(o: RunOptions): Promise<ImportResult> {
  const { pool, venue } = o;
  // A marketing opt-in without its proof never becomes consent: it's set aside and listed.
  const consentTally = { marketing_with_proof: 0, opt_outs: 0, service: 0, dropped_no_proof: 0 };
  const dropped: ImportReport["consents"]["dropped"][number][] = [];
  const kept = o.prepared.consents.filter((x) => {
    const { outcome, missing } = consentOutcome(x);
    if (outcome === "opt_out") consentTally.opt_outs += 1;
    else if (outcome === "service") consentTally.service += 1;
    else if (outcome === "marketing_with_proof") consentTally.marketing_with_proof += 1;
    else {
      consentTally.dropped_no_proof += 1;
      dropped.push({ file: x.file, line: x.line, legacy_ref: x.legacyRef, missing });
      return false;
    }
    return true;
  });
  const p: Prepared = { ...o.prepared, consents: kept };
  const log = o.log ?? (() => {});
  const runId = randomUUID();
  const now = o.now ?? Temporal.Now.instant();
  const cutoverDate =
    o.cutoverDate ?? businessDate(now, venue.timeZone, venue.cutover).businessDate.toString();
  const deposits = { held_cents: 0, payments_cents: 0, on_list_cents: 0 };
  const noRoom: { legacy_ref: string; file: string; line: number }[] = [];
  const links: { legacy_ref: string; token: string }[] = [];
  const placed: Record<string, number> = {};
  const policyById = new Map(p.policies.map((x) => [x.legacyRef, x]));
  // The menu (M9-04): items new in this run, for the bar grid; whether the menu changed at all.
  let newItems: { itemId: string; posSection: string | null; category: string }[] = [];
  let menuChanged = false;
  /** True while the menu is tried out before a live run: nothing is counted. */
  let rehearsing = false;
  const today = Temporal.PlainDate.from(cutoverDate);
  /** The save path's promotion checks on one thing; a refusal stops the import, naming the row. */
  const promote = async (
    c: pg.ClientBase,
    at: { file: string; line: number },
    thing: Promotable,
  ): Promise<string> => {
    const r = await menuPromotionRefusals(c, venue.id, [thing], today);
    if (r.refusals.length > 0)
      throw new ImportInvalid(
        r.refusals.map((x) => ({
          file: at.file,
          line: at.line,
          message: `the rule pack's promotion checks refuse "${"name" in thing ? thing.name : thing.kind}": ${x.message}`,
        })),
      );
    return r.packVersion ?? "unchecked";
  };
  const problems = [
    ...p.problems,
    ...(await asImport(pool, venue.id, runId, (c) => preflight(c, p), { rollback: true })),
  ];
  if (problems.length > 0) throw new ImportInvalid(problems);

  const tallies: Partial<Record<Kind, KindTally>> = {};
  const changed: { kind: Kind; file: string; line: number; legacy_ref: string }[] = [];
  for (const f of p.files)
    tallies[f.kind] = { in_files: 0, loaded: 0, already: 0, changed: 0, in_db: 0 };
  const count = (kind: Kind, rec: { file: string; line: number; legacyRef: string }, s: string) => {
    if (rehearsing) return;
    const t = tallies[kind]!;
    t.in_files += 1;
    if (s === "new") t.loaded += 1;
    else if (s === "already") t.already += 1;
    else {
      t.changed += 1;
      changed.push({ kind, file: rec.file, line: rec.line, legacy_ref: rec.legacyRef });
    }
  };

  const insertRun = (c: pg.ClientBase, mode: "dry_run" | "live") =>
    c.query(
      `insert into import_runs (id, venue_id, mode, mapping_source, mapping_version, files)
       values ($1, $2, $3, $4, $5, $6)`,
      [runId, venue.id, mode, p.mapping.source, p.mapping.mapping_version, JSON.stringify(p.files)],
    );

  // Each step loads one kind's batch inside the transaction it's given.
  const steps: {
    kind: Kind;
    rows: readonly unknown[];
    load: (c: pg.ClientBase, rows: unknown[]) => Promise<void>;
  }[] = [
    {
      kind: "guests",
      rows: p.guests,
      load: async (c, rows) => {
        for (const g of rows as Prepared["guests"][number][]) {
          const id = randomUUID();
          const s = await claim(c, venue.id, runId, "guest", g.legacyRef, "guests", id, g.hash);
          if (s === "new") {
            await c.query(
              "insert into guests (id, venue_id, name, phone_e164, email, locale) values ($1, $2, $3, $4, $5, coalesce($6, 'en'))",
              [id, venue.id, g.name, g.phone, g.email, g.locale],
            );
          }
          count("guests", g, s);
        }
      },
    },
    {
      kind: "people",
      rows: p.people,
      load: async (c, rows) => {
        for (const x of rows as Prepared["people"][number][]) {
          // People and roles only: an invited membership with no PIN and no badge. A person
          // whose email is already a user is linked to that user; one already on this venue's
          // team keeps the membership they have, untouched.
          let userId: string | undefined;
          if (x.email) {
            const u = await c.query<{ id: string }>(
              "select id from users where lower(email) = lower($1)",
              [x.email],
            );
            userId = u.rows[0]?.id;
          }
          const existing = userId
            ? (
                await c.query<{ id: string }>("select id from memberships where user_id = $1", [
                  userId,
                ])
              ).rows[0]?.id
            : undefined;
          const membershipId = existing ?? randomUUID();
          const s = await claim(
            c,
            venue.id,
            runId,
            "person",
            x.legacyRef,
            "memberships",
            membershipId,
            x.hash,
          );
          if (s === "new" && !existing) {
            if (!userId) {
              userId = randomUUID();
              await c.query(
                "insert into users (id, name, email, phone_e164) values ($1, $2, $3, $4)",
                [userId, x.name, x.email, x.phone],
              );
            }
            // As an invite from Admin → Team: invited, the PIN's length for the role (6 digits for
            // owners and managers, 4 for the rest) and no PIN, which the person chooses on their
            // own phone from their invite (M9-08). No badge. Tip eligibility stays the owner's to
            // set in Admin → Team, as for anyone invited there.
            await c.query(
              `insert into memberships (id, venue_id, user_id, role, status, pin_digits, locale)
               values ($1, $2, $3, $4, 'invited', $5, coalesce($6, 'en'))`,
              [membershipId, venue.id, userId, x.role, pinDigitsFor(x.role), x.locale],
            );
          }
          count("people", x, s);
        }
      },
    },
    {
      kind: "menu",
      rows: p.menu,
      load: async (c, rows) => {
        // Through Admin → Menu's save path (M9-04): the same row inserts, then the promotion
        // checks on every item this batch touched; a refusal stops the import with the reason.
        const touched = new Map<string, { file: string; line: number }>();
        for (const m of rows as Prepared["menu"][number][]) {
          const categoryId = randomUUID();
          const cat = await claim(
            c,
            venue.id,
            runId,
            "menu_category",
            m.category.toLowerCase(),
            "menu_categories",
            categoryId,
            m.taxCategory,
          );
          if (cat === "new") {
            const sort = await c.query<{ n: number }>(
              "select count(*)::int as n from menu_categories",
            );
            await insertMenuRow(c, "menu_categories", venue.id, {
              id: categoryId,
              name: m.category,
              sort: sort.rows[0]!.n,
              tax_category: m.taxCategory,
            });
          }
          const itemId = randomUUID();
          const item = await claim(
            c,
            venue.id,
            runId,
            "menu_item",
            m.itemRef,
            "menu_items",
            itemId,
            itemHash(m),
          );
          if (item === "new") {
            await insertMenuRow(c, "menu_items", venue.id, {
              id: itemId,
              category_id: await refId(c, "menu_category", m.category.toLowerCase()),
              name: m.name,
              button_name: m.buttonName,
              alcohol: m.alcohol,
              station: m.station,
              sort: m.sort,
            });
            newItems.push({ itemId, posSection: m.posSection, category: m.category });
          }
          const variantId = randomUUID();
          const s = await claim(
            c,
            venue.id,
            runId,
            "menu_variant",
            m.legacyRef,
            "menu_variants",
            variantId,
            m.hash,
          );
          if (s === "new") {
            const forItem = await refId(c, "menu_item", m.itemRef);
            await insertMenuRow(c, "menu_variants", venue.id, {
              id: variantId,
              item_id: forItem,
              name: m.variant,
              price_cents: m.priceCents,
              sort: m.sort,
            });
            if (!touched.has(forItem)) touched.set(forItem, { file: m.file, line: m.line });
          }
          count("menu", m, s);
        }
        for (const [itemId, at] of touched) {
          const r = await c.query<{ name: string; alcohol: boolean; prices: number[] }>(
            `select i.name, i.alcohol, array_agg(v.price_cents order by v.sort, v.id) as prices
               from menu_items i join menu_variants v on v.venue_id = i.venue_id and v.item_id = i.id
              where i.venue_id = $1 and i.id = $2 group by i.id`,
            [venue.id, itemId],
          );
          const x = r.rows[0]!;
          await promote(c, at, {
            kind: "menuItem",
            name: x.name,
            alcohol: x.alcohol,
            priceCents: x.prices.map(Number),
          });
        }
        if (touched.size > 0) menuChanged = true;
      },
    },
    {
      kind: "modifiers",
      rows: p.modifiers,
      load: async (c, rows) => {
        for (const x of rows as Prepared["modifiers"][number][]) {
          const key = `${x.itemRef}|${x.group.toLowerCase()}`;
          const groupId = randomUUID();
          const g = await claim(
            c,
            venue.id,
            runId,
            "modifier_group",
            key,
            "modifier_groups",
            groupId,
            [x.required, x.minChoices, x.maxChoices].join("|"),
          );
          const itemId = await refId(c, "menu_item", x.itemRef);
          if (g === "new") {
            await insertMenuRow(c, "modifier_groups", venue.id, {
              id: groupId,
              item_id: itemId,
              name: x.group,
              required: x.required,
              min_choices: x.minChoices,
              max_choices: x.maxChoices,
              sort: x.sort,
            });
          }
          const optionId = randomUUID();
          const s = await claim(
            c,
            venue.id,
            runId,
            "menu_option",
            x.legacyRef,
            "menu_options",
            optionId,
            x.hash,
          );
          if (s === "new") {
            await insertMenuRow(c, "menu_options", venue.id, {
              id: optionId,
              item_id: itemId,
              group_id: await refId(c, "modifier_group", key),
              name: x.name,
              price_delta_cents: x.priceDeltaCents,
              is_default: x.isDefault,
              sort: x.sort,
            });
            menuChanged = true;
          }
          count("modifiers", x, s);
        }
      },
    },
    {
      kind: "packages",
      rows: p.packages,
      load: async (c, rows) => {
        for (const x of rows as Prepared["packages"][number][]) {
          const id = randomUUID();
          const s = await claim(c, venue.id, runId, "package", x.legacyRef, "packages", id, x.hash);
          if (s === "new") {
            const contents = [];
            for (const k of x.contents)
              contents.push({ item_id: await refId(c, "menu_item", k.itemRef), qty: k.qty });
            await insertMenuRow(c, "packages", venue.id, {
              id,
              name: x.name,
              price_cents: x.priceCents,
              hourly: x.hourly,
              contents,
              private_function_only: x.privateFunctionOnly,
              shown: x.shown,
              checked_pack_version: "unchecked",
            });
            const version = await promote(c, x, {
              kind: "package",
              name: x.name,
              priceCents: x.priceCents,
              hourly: x.hourly,
              privateFunctionOnly: x.privateFunctionOnly,
              contents: contents.map((k) => ({ itemId: k.item_id, qty: k.qty })),
            });
            await patchMenuRow(c, "packages", venue.id, id, { checked_pack_version: version });
            menuChanged = true;
          }
          count("packages", x, s);
        }
      },
    },
    {
      kind: "policies",
      rows: p.policies,
      load: async (c, rows) => {
        for (const x of rows as Prepared["policies"][number][]) {
          // The words each guest accepted on the old site, kept as they were (kind imported_terms):
          // never the venue's own deposit policy, which only the owner publishes.
          const id = randomUUID();
          const s = await claim(
            c,
            venue.id,
            runId,
            "policy",
            x.legacyRef,
            "policy_versions",
            id,
            x.hash,
          );
          if (s === "new") {
            await c.query(
              `insert into policy_versions (id, venue_id, kind, version, text, hash, published_at)
               select $1, $2, 'imported_terms', coalesce(max(version), 0) + 1, $3, $4, coalesce($5::timestamptz, now())
                 from policy_versions where venue_id = $2 and kind = 'imported_terms'`,
              [id, venue.id, x.text, sha256(x.text), x.publishedAt],
            );
          }
          count("policies", x, s);
        }
      },
    },
    {
      kind: "bookings",
      rows: p.bookings,
      load: async (c, rows) => {
        for (const b of rows as Prepared["bookings"][number][]) {
          const earlier = await c.query<{ row_hash: string }>(
            "select row_hash from import_refs where kind = 'booking' and legacy_ref = $1",
            [b.legacyRef],
          );
          if (earlier.rows[0]) {
            count("bookings", b, earlier.rows[0].row_hash === b.hash ? "already" : "changed");
            continue;
          }
          const id = randomUUID();
          const guestId = await refId(c, "guest", b.guestRef);
          const date = businessDate(
            b.startsAt,
            venue.timeZone,
            venue.cutover,
          ).businessDate.toString();
          const live = LIVE_STATUSES.has(b.status);
          if (!live) {
            // History (seated, finished, cancelled or a no-show in the old system): kept as it was, in
            // the room it named, with no block, no payment and no link.
            const room = await c.query<{ id: string; size_tier: string }>(
              "select id, size_tier from rooms where lower(name) = lower($1) and archived_at is null",
              [b.room],
            );
            await c.query(
              `insert into bookings (id, venue_id, guest_id, room_id, size_tier, party_size, starts_at, ends_at,
                 business_date, status, source, legacy_ref, deposit_legacy_cents)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'import', $11, $12)`,
              [
                id,
                venue.id,
                guestId,
                room.rows[0]!.id,
                room.rows[0]!.size_tier,
                b.partySize,
                b.startsAt,
                b.endsAt,
                date,
                b.status,
                b.legacyRef,
                b.depositCents,
              ],
            );
            await claim(c, venue.id, runId, "booking", b.legacyRef, "bookings", id, b.hash);
            placed["history"] = (placed["history"] ?? 0) + 1;
            count("bookings", b, "new");
            continue;
          }
          const room = await placeBooking(c, venue.id, {
            id,
            party: b.partySize,
            from: Temporal.Instant.from(b.startsAt),
            to: Temporal.Instant.from(b.endsAt),
            roomName: b.room,
            businessDate: date,
          });
          deposits.held_cents += b.depositCents;
          if (!room) {
            await c.query(
              `insert into import_unplaced (id, venue_id, run_id, legacy_ref, guest_id, room_named, party_size,
                 starts_at, ends_at, business_date, deposit_legacy_cents, reason)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'no_room')`,
              [
                id,
                venue.id,
                runId,
                b.legacyRef,
                guestId,
                b.room,
                b.partySize,
                b.startsAt,
                b.endsAt,
                date,
                b.depositCents,
              ],
            );
            await claim(c, venue.id, runId, "booking", b.legacyRef, "import_unplaced", id, b.hash);
            deposits.on_list_cents += b.depositCents;
            noRoom.push({ legacy_ref: b.legacyRef, file: b.file, line: b.line });
            placed["no_room"] = (placed["no_room"] ?? 0) + 1;
            count("bookings", b, "new");
            continue;
          }
          const policy = b.policyRef === null ? undefined : policyById.get(b.policyRef);
          const policyId = policy ? await refId(c, "policy", policy.legacyRef) : null;
          const link = manageToken();
          await c.query(
            `insert into bookings (id, venue_id, guest_id, room_id, size_tier, party_size, starts_at, ends_at,
               business_date, status, source, legacy_ref, deposit_cents, deposit_legacy_cents, policy_version_id,
               accepted_at, refund_cutoff_at, manage_token_hash)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'import', $11, $12, $12, $13, $14, $15, $16)`,
            [
              id,
              venue.id,
              guestId,
              room.roomId,
              room.sizeTier,
              b.partySize,
              b.startsAt,
              b.endsAt,
              date,
              b.status,
              b.legacyRef,
              b.depositCents,
              policyId,
              b.acceptedAt,
              policy && b.depositCents > 0 ? refundCutoff(b.startsAt, policy.refundHours) : null,
              link.hash,
            ],
          );
          if (b.depositCents > 0) {
            await insertLegacyDeposit(c, venue.id, {
              bookingId: id,
              amountCents: b.depositCents,
              businessDate: cutoverDate,
            });
            deposits.payments_cents += b.depositCents;
          }
          await claim(c, venue.id, runId, "booking", b.legacyRef, "bookings", id, b.hash);
          links.push({ legacy_ref: b.legacyRef, token: link.token });
          const how = room.moved ? "another_room" : "named_room";
          placed[how] = (placed[how] ?? 0) + 1;
          count("bookings", b, "new");
        }
      },
    },
    {
      kind: "consents",
      rows: p.consents,
      load: async (c, rows) => {
        for (const x of rows as Prepared["consents"][number][]) {
          const id = randomUUID();
          const s = await claim(c, venue.id, runId, "consent", x.legacyRef, "consents", id, x.hash);
          if (s === "new") {
            const guestId = await refId(c, "guest", x.guestRef);
            await c.query(
              `insert into consents (id, venue_id, guest_id, phone_e164, channel, kind, given_at, revoked_at,
                 revoked_via, source, text_version, ip)
               select $1, $2, g.id, g.phone_e164, $4, $5, $6, $7, $8, $9, $10, $11 from guests g where g.id = $3`,
              [
                id,
                venue.id,
                guestId,
                x.channel,
                storedKind(x),
                x.givenAt,
                x.revokedAt,
                x.revokedVia,
                x.source,
                x.textVersion,
                x.ip,
              ],
            );
          }
          count("consents", x, s);
        }
      },
    },
    {
      kind: "nightly_totals",
      rows: p.nightlyTotals,
      load: async (c, rows) => {
        for (const n of rows as Prepared["nightlyTotals"][number][]) {
          const s = await claim(
            c,
            venue.id,
            runId,
            "nightly_total",
            n.legacyRef,
            "legacy_nightly_totals",
            n.businessDate,
            n.hash,
          );
          if (s === "new") {
            await c.query(
              `insert into legacy_nightly_totals (venue_id, business_date, net_sales_cents, rooms_cents, bar_cents)
               values ($1, $2, $3, $4, $5)`,
              [venue.id, n.businessDate, n.netSalesCents, n.roomsCents, n.barCents],
            );
          }
          count("nightly_totals", n, s);
        }
      },
    },
  ];

  /**
   * After the menu loads (M9-04), as after a save in Admin → Menu: menu.changed goes out, the menu
   * PDF re-renders, and the bar's grid gets a new version with the new items, from the next
   * business date.
   */
  let layout: LayoutResult | null = null;
  const afterMenu = async (c: pg.ClientBase) => {
    if (!menuChanged) return;
    await emitEvent(c, { venueId: venue.id, type: "menu.changed", entityId: venue.id });
    await queueMenuPdf(c, venue.id, now.add({ seconds: 5 }).toString());
    layout = await publishBarLayout(c, venue, newItems, now);
  };

  const tallyDb = async (c: pg.ClientBase) => {
    for (const f of p.files) {
      const t = tallies[f.kind]!;
      const kind = KIND_OF[f.kind];
      const refs = (
        f.kind === "nightly_totals"
          ? p.nightlyTotals
          : (p[f.kind] as readonly { legacyRef: string }[])
      ).map((r) => r.legacyRef);
      const sql: Record<Kind, string> = {
        guests:
          "select count(*)::int as n, 0::bigint as cents, null::text as by from guests x where x.id::text = r.target_id",
        people:
          "select count(*)::int as n, 0::bigint as cents, x.role as by from memberships x where x.id::text = r.target_id group by x.role",
        menu: `select count(*)::int as n, coalesce(sum(x.price_cents), 0)::bigint as cents, null::text as by
                 from menu_variants x where x.id::text = r.target_id`,
        modifiers:
          "select count(*)::int as n, 0::bigint as cents, null::text as by from menu_options x where x.id::text = r.target_id",
        packages:
          "select count(*)::int as n, coalesce(sum(x.price_cents), 0)::bigint as cents, null::text as by from packages x where x.id::text = r.target_id",
        policies:
          "select count(*)::int as n, 0::bigint as cents, null::text as by from policy_versions x where x.id::text = r.target_id",
        // A booking that fit no room is on the manager's list (import_unplaced), with its deposit.
        bookings: `select count(*)::int as n, coalesce(sum(x.cents), 0)::bigint as cents, null::text as by
                     from (select deposit_legacy_cents as cents from bookings where id::text = r.target_id
                           union all
                           select deposit_legacy_cents from import_unplaced where id::text = r.target_id) x`,
        consents: `select count(*)::int as n, 0::bigint as cents,
                     x.kind || ' ' || x.channel || case when x.revoked_at is null then ' given' else ' revoked' end as by
                   from consents x where x.id::text = r.target_id group by 3`,
        nightly_totals:
          "select count(*)::int as n, coalesce(sum(x.net_sales_cents), 0)::bigint as cents, null::text as by from legacy_nightly_totals x where x.business_date::text = r.target_id",
      };
      const r = await c.query<{ n: number; cents: string; by: string | null }>(
        `select q.by, sum(q.n)::int as n, sum(q.cents)::bigint as cents
           from import_refs r cross join lateral (${sql[f.kind]}) q
          where r.kind = $1 and r.legacy_ref = any($2::text[])
          group by q.by`,
        [kind, refs],
      );
      t.in_db = r.rows.reduce((a, x) => a + x.n, 0);
      if (f.kind === "bookings") t.by = { ...placed };
      if (f.kind === "people" || f.kind === "consents") {
        t.by = Object.fromEntries(r.rows.filter((x) => x.by).map((x) => [x.by!, x.n]));
      }
      if (
        f.kind === "bookings" ||
        f.kind === "menu" ||
        f.kind === "packages" ||
        f.kind === "nightly_totals"
      ) {
        t.cents_in_db = r.rows.reduce((a, x) => a + Number(x.cents), 0);
        t.cents_in_files =
          f.kind === "bookings"
            ? p.bookings.reduce((a, b) => a + b.depositCents, 0)
            : f.kind === "menu"
              ? p.menu.reduce((a, m) => a + m.priceCents, 0)
              : f.kind === "packages"
                ? p.packages.reduce((a, m) => a + m.priceCents, 0)
                : p.nightlyTotals.reduce((a, n) => a + n.netSalesCents, 0);
      }
    }
  };

  const report = (): ImportReport => {
    const journal = openingJournal({
      date: cutoverDate,
      ref: `Opening deposits · import ${runId}`,
      deposits_cents: deposits.held_cents,
    });
    return {
      run_id: runId,
      mode: o.dryRun ? "dry_run" : "live",
      venue_id: venue.id,
      mapping: { source: p.mapping.source, version: p.mapping.mapping_version },
      files: p.files,
      kinds: tallies,
      changed,
      deposits: { cutover_date: cutoverDate, ...deposits },
      opening_journal: journal,
      no_room: noRoom,
      consents: { ...consentTally, dropped },
      layout,
      listed: p.listed,
      reconciles:
        Object.values(tallies).every(
          (t) => t.changed === 0 && t.in_db === t.in_files && t.cents_in_db === t.cents_in_files,
        ) &&
        deposits.payments_cents + deposits.on_list_cents === deposits.held_cents &&
        isBalanced(journal),
    };
  };
  const finish = (c: pg.ClientBase, r: ImportReport) =>
    c.query(
      `update import_runs set state = 'done', report = $2, cutover_date = $3, opening_journal = $4,
              finished_at = now() where id = $1`,
      [runId, JSON.stringify(r), r.deposits.cutover_date, JSON.stringify(r.opening_journal)],
    );

  if (o.dryRun) {
    // Everything in one transaction that is rolled back: the venue is left as it was.
    const out = await asImport(
      pool,
      venue.id,
      runId,
      async (c) => {
        await insertRun(c, "dry_run");
        for (const step of steps) await step.load(c, [...step.rows]);
        await afterMenu(c);
        await tallyDb(c);
        return report();
      },
      { rollback: true },
    );
    await asImport(pool, venue.id, runId, async (c) => {
      await insertRun(c, "dry_run");
      await finish(c, out);
    });
    log(`dry run ${runId}: rolled back, report kept`);
    // A dry run's links were rolled back with everything else: none to hand out.
    return { ...out, manage_links: [] };
  }

  // The menu is tried out whole first, in a transaction that's rolled back: an item or package
  // the promotion checks refuse stops the import before any batch commits (M9-04).
  if (p.menu.length + p.modifiers.length + p.packages.length > 0) {
    rehearsing = true;
    try {
      await asImport(
        pool,
        venue.id,
        runId,
        async (c) => {
          await insertRun(c, "live");
          for (const step of steps.filter((s) => MENU_KINDS.has(s.kind)))
            await step.load(c, [...step.rows]);
        },
        { rollback: true },
      );
    } finally {
      rehearsing = false;
      newItems = [];
      menuChanged = false;
    }
  }

  await asImport(pool, venue.id, runId, (c) => insertRun(c, "live"));
  try {
    const size = o.batchSize ?? 500;
    for (const step of steps) {
      for (const batch of chunks(step.rows, size)) {
        await asImport(pool, venue.id, runId, (c) => step.load(c, batch));
      }
      if (step.rows.length > 0) log(`${step.kind}: ${step.rows.length} record(s) read`);
    }
    await asImport(pool, venue.id, runId, afterMenu);
    const out = await asImport(pool, venue.id, runId, async (c) => {
      await tallyDb(c);
      const r = report();
      await finish(c, r);
      return r;
    });
    return { ...out, manage_links: links };
  } catch (e) {
    await asImport(pool, venue.id, runId, (c) =>
      c.query(
        "update import_runs set state = 'failed', failure = $2, finished_at = now() where id = $1",
        [runId, (e as Error).message.slice(0, 500)],
      ),
    ).catch(() => {});
    throw e;
  }
}

export const dollars = (cents: number) => {
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  const whole = Math.floor(a / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(a % 100).padStart(2, "0")}`;
};

/** The report as lines a person reads: counts and cents by kind. */
export function formatReport(r: ImportReport): string[] {
  const label: Record<Kind, string> = {
    guests: "guests",
    people: "people",
    menu: "menu lines",
    modifiers: "menu choices",
    packages: "packages",
    policies: "terms",
    bookings: "bookings",
    consents: "consents",
    nightly_totals: "nightly totals",
  };
  const money: Partial<Record<Kind, string>> = {
    bookings: "of deposits",
    menu: "of prices",
    packages: "of prices",
    nightly_totals: "of net sales",
  };
  const lines = [
    `${r.mode === "dry_run" ? "Dry run" : "Import"} ${r.run_id} · mapping ${r.mapping.source} v${r.mapping.version}`,
  ];
  for (const [kind, t] of Object.entries(r.kinds) as [Kind, KindTally][]) {
    let line = `${t.in_db} ${label[kind]}`;
    if (t.cents_in_db !== undefined) line += ` with ${dollars(t.cents_in_db)} ${money[kind]}`;
    line += ` (in files ${t.in_files}`;
    if (t.cents_in_files !== undefined) line += `, ${dollars(t.cents_in_files)}`;
    line += `; new ${t.loaded}, already ${t.already}, changed ${t.changed})`;
    if (t.by && Object.keys(t.by).length > 0) {
      line += ` · ${Object.entries(t.by)
        .sort()
        .map(([k, n]) => `${k} ${n}`)
        .join(", ")}`;
    }
    lines.push(line);
  }
  if (r.kinds.bookings) {
    lines.push(
      `Deposits of bookings still to come: ${dollars(r.deposits.held_cents)} into customer deposits on ${r.deposits.cutover_date} ` +
        `(${dollars(r.deposits.payments_cents)} held as old-system payments, ${dollars(r.deposits.on_list_cents)} with bookings on the manager's list)`,
    );
  }
  if (r.kinds.consents || r.consents.dropped_no_proof > 0) {
    const c = r.consents;
    lines.push(
      `Consents in the files: ${c.marketing_with_proof} marketing opt-in(s) with proof, ${c.opt_outs} opt-out(s), ` +
        `${c.service} service-text opt-in(s), ${c.dropped_no_proof} marketing opt-in(s) dropped for lack of proof`,
    );
  }
  for (const d of r.consents.dropped) {
    lines.push(
      `not imported as consent, no proof (missing ${d.missing.join(", ")}): ${d.file}:${d.line} ${d.legacy_ref}`,
    );
  }
  for (const l of r.listed) lines.push(`imported, listed: ${l.file}:${l.line} ${l.message}`);
  if (r.layout) {
    const l = r.layout;
    if (l.version !== null)
      lines.push(
        `Bar grid: version ${l.version} from ${l.starts_on}, ${l.placed} new item(s) placed`,
      );
    else if (l.skipped) lines.push(`Bar grid not published: ${l.skipped}`);
    for (const x of l.not_placed) lines.push(`not on the bar grid: ${x.item} (${x.why})`);
  }
  for (const x of r.no_room) {
    lines.push(`fits no room, on the manager's list: ${x.file}:${x.line} ${x.legacy_ref}`);
  }
  for (const ch of r.changed) {
    lines.push(
      `changed since the last import, not applied: ${ch.file}:${ch.line} ${ch.legacy_ref}`,
    );
  }
  lines.push(
    r.reconciles
      ? "Reconciles: every record and cent in the files is in the venue."
      : "Does NOT reconcile.",
  );
  return lines;
}
