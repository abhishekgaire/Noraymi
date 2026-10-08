import type pg from "pg";
import { Temporal } from "@west4/shared";
import { alertVoidAfterCash } from "./owner-alerts.js";
import { withVenue } from "./tenancy.js";
import type { Queryable } from "./tenancy.js";

/**
 * Checks and their lines (M2-08; spec 04 · the money core). A check number
 * comes from `venue_counters` in its own short transaction, before anything
 * else, so a slow call never holds the counter and no number is used twice.
 */
export type CheckKind = "room" | "bar" | "quick" | "fee";

/** The next check number for a venue, in its own transaction (training checks count separately). */
export async function nextCheckNumber(
  pool: pg.Pool,
  venueId: string,
  options: { training?: boolean; startAt?: number } = {},
): Promise<number> {
  const name = options.training ? "check_training" : "check";
  return withVenue(pool, { venueId, requestId: "counter:check" }, async (c) => {
    await c.query(
      "insert into venue_counters (venue_id, name, next) values ($1, $2, $3) on conflict (venue_id, name) do nothing",
      [venueId, name, options.startAt ?? 1],
    );
    const r = await c.query<{ number: string }>(
      "update venue_counters set next = next + 1 where venue_id = $1 and name = $2 returning next - 1 as number",
      [venueId, name],
    );
    return Number(r.rows[0]!.number);
  });
}

/** Is this a practice check (training mode, M7-03)? An unknown check is not. */
export async function checkIsTraining(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<boolean> {
  const r = await c.query<{ training: boolean }>(
    "select training from checks where venue_id = $1 and id = $2",
    [venueId, checkId],
  );
  return r.rows[0]?.training ?? false;
}

export async function insertCheck(
  c: Queryable,
  input: {
    venueId: string;
    number: number;
    kind: CheckKind;
    businessDate: string;
    roomSessionId?: string | null;
    bookingId?: string | null;
    openedBy: string;
    openedAt?: string;
    training?: boolean;
    id?: string;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into checks (id, venue_id, number, kind, business_date, room_session_id, booking_id, opened_by, opened_at, training)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, open_business_date($2, $5::date), $6, $7, $8, coalesce($9::timestamptz, now()), $10)
       returning id`,
    [
      input.id ?? null,
      input.venueId,
      input.number,
      input.kind,
      input.businessDate,
      input.roomSessionId ?? null,
      input.bookingId ?? null,
      input.openedBy,
      input.openedAt ?? null,
      input.training ?? false,
    ],
  );
  return r.rows[0]!.id;
}

export interface LineInput {
  readonly kind: string;
  readonly description: string;
  readonly qty: number;
  readonly unitCents: number;
  readonly amountCents: number;
  readonly taxCategory: string | null;
  readonly businessDate: string;
  readonly reversesId?: number | null;
  readonly made?: boolean | null;
  readonly reason?: string | null;
  readonly addedBy?: string | null;
  readonly approvedBy?: string | null;
  readonly addedAt?: string | null;
  readonly sourceId?: string | null;
  /** The photo a damage line needs (M2-21). */
  readonly fileId?: string | null;
  /** A moved line (M6-13): the check on the other side of the move. */
  readonly movedCheckId?: string | null;
}

/** Adds a line; the check's version goes up with it. Returns the line's id. */
export async function addCheckLine(
  c: Queryable,
  venueId: string,
  checkId: string,
  line: LineInput,
): Promise<number> {
  const r = await c.query<{ id: string; business_date: string }>(
    `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category,
       business_date, adjusts_business_date, reverses_id, made, reason, added_by, added_at, source_id, approved_by,
       file_id, moved_check_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, open_business_date($1, $9::date), nullif($9::date, open_business_date($1, $9::date)), $10, $11, $12, $13, coalesce($14::timestamptz, now()), $15, $16, $17, $18)
     returning id, business_date::text`,
    [
      venueId,
      checkId,
      line.kind,
      line.description,
      line.qty,
      line.unitCents,
      line.amountCents,
      line.taxCategory,
      line.businessDate,
      line.reversesId ?? null,
      line.made ?? null,
      line.reason ?? null,
      line.addedBy ?? null,
      line.addedAt ?? null,
      line.sourceId ?? null,
      line.approvedBy ?? null,
      line.fileId ?? null,
      line.movedCheckId ?? null,
    ],
  );
  await c.query("update checks set version = version + 1 where venue_id = $1 and id = $2", [
    venueId,
    checkId,
  ]);
  const id = Number(r.rows[0]!.id);
  // A void after cash was paid on the check alerts the owner (M8-19), whichever path wrote it.
  if (line.kind === "void")
    await alertVoidAfterCash(c, venueId, {
      lineId: id,
      checkId,
      amountCents: Number(line.amountCents),
      businessDate: r.rows[0]!.business_date,
      at: line.addedAt ?? Temporal.Now.instant().toString(),
      addedBy: line.addedBy ?? null,
    });
  return id;
}

export interface CheckRow {
  readonly id: string;
  readonly number: number;
  readonly kind: CheckKind;
  readonly business_date: string;
  readonly room_session_id: string | null;
  readonly booking_id: string | null;
  readonly status: string;
  readonly revision: number;
  readonly version: number;
  readonly training: boolean;
  readonly opened_at: string;
}

export interface CheckLineRow {
  readonly id: number;
  readonly kind: string;
  readonly description: string;
  readonly qty: number;
  readonly unit_cents: number;
  readonly amount_cents: number;
  readonly tax_category: string | null;
  readonly reverses_id: number | null;
  readonly reason: string | null;
  readonly added_at: string;
  /** A damage line's photo (M2-21). */
  readonly file_id: string | null;
  /** Computed lines (room time, tax, gratuity) belong to a revision (M4-07). */
  readonly revision: number | null;
  /** On tax lines: the rate, the base and the rule-pack version (M4-07). */
  readonly tax_rate: string | null;
  readonly taxable_base_cents: number | null;
  readonly rule_pack_version: string | null;
}

export async function checkById(c: Queryable, venueId: string, id: string) {
  const r = await c.query<CheckRow & { number: string }>(
    `select id, number, kind, business_date::text, room_session_id, booking_id, status, revision, version, training,
            to_json(opened_at) #>> '{}' as opened_at
       from checks where venue_id = $1 and id = $2`,
    [venueId, id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const lines = await c.query<
    CheckLineRow & {
      id: string;
      qty: string;
      unit_cents: string;
      amount_cents: string;
      reverses_id: string | null;
    }
  >(
    `select id, kind, description, qty, unit_cents, amount_cents, tax_category, reverses_id, reason,
            to_json(added_at) #>> '{}' as added_at, file_id, revision, tax_rate::text,
            taxable_base_cents::int, rule_pack_version
       from check_lines where venue_id = $1 and check_id = $2 order by id`,
    [venueId, id],
  );
  return {
    check: { ...row, number: Number(row.number) } as CheckRow,
    lines: lines.rows.map((l): CheckLineRow => ({
      ...l,
      id: Number(l.id),
      qty: Number(l.qty),
      unit_cents: Number(l.unit_cents),
      amount_cents: Number(l.amount_cents),
      reverses_id: l.reverses_id === null ? null : Number(l.reverses_id),
    })),
  };
}
