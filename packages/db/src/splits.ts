import type { Queryable } from "./tenancy.js";

/** Splits and their shares (M4-14; Money rules 13). Inside a venue transaction. */
export interface ShareRow {
  readonly id: string;
  readonly share_no: number;
  readonly kind: "even" | "items";
  readonly amount_cents: number;
  readonly tax_cents: number;
  readonly gratuity_cents: number;
  readonly line_ids: number[];
  readonly room_guest_id: string | null;
  readonly state: "open" | "paying" | "paid";
}

export interface SplitRow {
  readonly id: string;
  readonly check_id: string;
  readonly share_count: number;
  readonly base_cents: number;
  readonly ended_at: string | null;
  readonly shares: ShareRow[];
}

const SHARE_COLS = `id, share_no, kind, amount_cents::int, tax_cents::int, gratuity_cents::int,
  (select coalesce(array_agg(x::int), '{}') from unnest(line_ids) x) as line_ids, room_guest_id, state`;

export async function openSplit(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<SplitRow | null> {
  const r = await c.query<Omit<SplitRow, "shares">>(
    `select id, check_id, share_count, base_cents::int, to_json(ended_at) #>> '{}' as ended_at
       from check_splits where venue_id = $1 and check_id = $2 and ended_at is null`,
    [venueId, checkId],
  );
  const split = r.rows[0];
  if (!split) return null;
  const shares = await c.query<ShareRow>(
    `select ${SHARE_COLS} from split_shares where venue_id = $1 and split_id = $2 order by share_no`,
    [venueId, split.id],
  );
  return { ...split, shares: shares.rows };
}

export async function insertSplit(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    baseCents: number;
    createdBy: string;
    at: string;
    shares: {
      kind: "even" | "items";
      amountCents: number;
      taxCents: number;
      gratuityCents: number;
      lineIds?: number[];
      roomGuestId?: string | null;
    }[];
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into check_splits (venue_id, check_id, share_count, base_cents, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [venueId, input.checkId, input.shares.length, input.baseCents, input.createdBy, input.at],
  );
  const splitId = r.rows[0]!.id;
  for (const [i, s] of input.shares.entries())
    await c.query(
      `insert into split_shares (venue_id, split_id, share_no, kind, amount_cents, tax_cents, gratuity_cents, line_ids,
         room_guest_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        venueId,
        splitId,
        i + 1,
        s.kind,
        s.amountCents,
        s.taxCents,
        s.gratuityCents,
        s.lineIds ?? [],
        s.roomGuestId ?? null,
      ],
    );
  return splitId;
}

/** A share of an open split on this check, locked while a payment takes it. */
export async function shareOf(
  c: Queryable,
  venueId: string,
  checkId: string,
  shareId: string,
): Promise<(ShareRow & { split_id: string }) | null> {
  const r = await c.query<ShareRow & { split_id: string }>(
    `select s.id, s.share_no, s.kind, s.amount_cents::int, s.tax_cents::int, s.gratuity_cents::int,
            (select coalesce(array_agg(x::int), '{}') from unnest(s.line_ids) x) as line_ids, s.room_guest_id, s.state,
            s.split_id
       from split_shares s join check_splits k on k.venue_id = s.venue_id and k.id = s.split_id
      where s.venue_id = $1 and s.id = $2 and k.check_id = $3 and k.ended_at is null
      for update of s`,
    [venueId, shareId, checkId],
  );
  return r.rows[0] ?? null;
}

export async function setShareState(
  c: Queryable,
  venueId: string,
  shareId: string,
  state: ShareRow["state"],
): Promise<void> {
  await c.query("update split_shares set state = $3 where venue_id = $1 and id = $2", [
    venueId,
    shareId,
    state,
  ]);
}

/** The shares a payment pays (through its allocations). */
export async function sharesOfPayment(
  c: Queryable,
  venueId: string,
  paymentId: string,
): Promise<string[]> {
  const r = await c.query<{ share_id: string }>(
    "select distinct share_id from payment_allocations where venue_id = $1 and payment_id = $2 and share_id is not null",
    [venueId, paymentId],
  );
  return r.rows.map((x) => x.share_id);
}

export async function endSplit(
  c: Queryable,
  venueId: string,
  splitId: string,
  by: string,
  at: string,
): Promise<boolean> {
  const r = await c.query(
    "update check_splits set ended_by = $3, ended_at = $4 where venue_id = $1 and id = $2 and ended_at is null",
    [venueId, splitId, by, at],
  );
  return (r.rowCount ?? 0) > 0;
}
