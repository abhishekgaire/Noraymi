import type { Temporal } from "@west4/shared";
import type { Queryable } from "./tenancy.js";

/**
 * Closed nights and posting dates (M7-02; Money rules 2 and 16; Data model ·
 * night_closes). A night closes once, with the next Z number, and never
 * reopens: the database refuses any row dated to it (SQLSTATE W4N01), so every
 * money, shift and drawer row is stamped through posting_business_date(),
 * which moves a closed night's date to the next open one.
 */
export const NIGHT_CLOSED_SQLSTATE = "W4N01";

export interface NightClose {
  readonly id: string;
  readonly business_date: string;
  readonly z_number: number;
  readonly closed_at: string;
  /** The owner or manager who closed it; null when our staff closed it on the emergency path (M8-11). */
  readonly closed_by: string | null;
  readonly closed_by_support: string | null;
  readonly totals: Record<string, unknown>;
  readonly export_id: string | null;
}

/** The business date of `at`, moved forward past any closed night. */
export async function postingDate(
  c: Queryable,
  venueId: string,
  at: Temporal.Instant | string,
): Promise<string> {
  const r = await c.query<{ d: string }>("select posting_business_date($1, $2)::text as d", [
    venueId,
    at.toString(),
  ]);
  return r.rows[0]!.d;
}

/**
 * A row that belongs to `night` (a slip tip, a refund of its check, a no-show charge, a kept deposit, money
 * collected for a capture_failed tab), written at `at`: it posts to the posting date, pointing back at its
 * night when that's earlier.
 */
export async function latePostingAt(
  c: Queryable,
  venueId: string,
  night: string,
  at: Temporal.Instant | string,
): Promise<{ businessDate: string; adjustsBusinessDate: string | null }> {
  const posting = await postingDate(c, venueId, at);
  return posting > night
    ? { businessDate: posting, adjustsBusinessDate: night }
    : { businessDate: night, adjustsBusinessDate: null };
}

export async function nightClose(
  c: Queryable,
  venueId: string,
  businessDate: string,
): Promise<NightClose | null> {
  const r = await c.query<NightClose>(
    `select id, business_date::text, z_number::int as z_number,
            to_json(closed_at) #>> '{}' as closed_at, closed_by, closed_by_support, totals, export_id
       from night_closes where venue_id = $1 and business_date = $2`,
    [venueId, businessDate],
  );
  return r.rows[0] ?? null;
}

export async function isNightClosed(
  c: Queryable,
  venueId: string,
  businessDate: string,
): Promise<boolean> {
  return (await nightClose(c, venueId, businessDate)) !== null;
}

/** Where money that belongs to `businessDate` goes once that night is over: the first open date after it, or later. */
export async function latePostsTo(
  c: Queryable,
  venueId: string,
  businessDate: string,
  now: Temporal.Instant | string,
): Promise<string> {
  const r = await c.query<{ d: string }>(
    `select greatest(open_business_date($1, $2::date + 1), posting_business_date($1, $3))::text as d`,
    [venueId, businessDate, now.toString()],
  );
  return r.rows[0]!.d;
}

/** A night with a pulled tray still uncounted can't close (M7-07). */
export class UncountedTrays extends Error {
  constructor() {
    super("a pulled tray is still uncounted");
  }
}

/**
 * Close a night (Close the night, M7-12, calls this inside its transaction): the next Z number from
 * `venue_counters` and the `night_closes` row. From here the database refuses any row dated to it.
 */
export async function recordNightClose(
  c: Queryable,
  venueId: string,
  input: {
    businessDate: string;
    closedAt: string;
    closedBy: string | null;
    /** Our staff member, when the night closes on the emergency path (M8-11). */
    closedBySupport?: string | null;
    totals?: Record<string, unknown>;
    exportId?: string | null;
  },
): Promise<NightClose> {
  // A pulled tray is counted before the night closes (M7-07; Money rules 15).
  const trays = await c.query(
    "select 1 from drawer_sessions where venue_id = $1 and business_date = $2::date and state = 'pulled'",
    [venueId, input.businessDate],
  );
  if ((trays.rowCount ?? 0) > 0) throw new UncountedTrays();
  await c.query(
    "insert into venue_counters (venue_id, name, next) values ($1, 'z_report', 1) on conflict (venue_id, name) do nothing",
    [venueId],
  );
  const z = await c.query<{ number: string }>(
    "update venue_counters set next = next + 1 where venue_id = $1 and name = 'z_report' returning next - 1 as number",
    [venueId],
  );
  await c.query(
    `insert into night_closes (venue_id, business_date, z_number, closed_at, closed_by, totals, export_id, closed_by_support)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      venueId,
      input.businessDate,
      Number(z.rows[0]!.number),
      input.closedAt,
      input.closedBy,
      JSON.stringify(input.totals ?? {}),
      input.exportId ?? null,
      input.closedBySupport ?? null,
    ],
  );
  return (await nightClose(c, venueId, input.businessDate))!;
}
