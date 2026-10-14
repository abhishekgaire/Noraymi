import type { Queryable } from "@west4/db";
import type { CheckDiscountSpec } from "@west4/rules";
import { cents, formatMoney } from "@west4/shared";

/** The discount standing on a check (P-02), as stored: one at a time, until it's removed. */
export interface StandingDiscount {
  readonly id: string;
  readonly mode: "pct" | "amount";
  /** The percent as text ("10", "12.5"), exactly as given. */
  readonly pct: string | null;
  readonly amount_cents: number | null;
  readonly reason: string;
  readonly counted_cents: number;
  readonly added_by: string;
  readonly added_by_name: string | null;
  readonly approved_by_name: string | null;
  readonly added_at: string;
}

export async function standingDiscount(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<StandingDiscount | null> {
  const r = await c.query<StandingDiscount>(
    `select d.id, d.mode, trim_scale(d.pct)::text as pct, d.amount_cents::int as amount_cents, d.reason,
            d.counted_cents::int as counted_cents, d.added_by, u.name as added_by_name,
            a.name as approved_by_name, to_json(d.added_at) #>> '{}' as added_at
       from check_discounts d
       left join users u on u.id = d.added_by
       left join users a on a.id = d.approved_by
      where d.venue_id = $1 and d.check_id = $2 and d.removed_at is null`,
    [venueId, checkId],
  );
  return r.rows[0] ?? null;
}

export const specOf = (d: {
  mode: "pct" | "amount";
  pct: string | null;
  amount_cents: number | null;
}): CheckDiscountSpec =>
  d.mode === "pct"
    ? { mode: "pct", pct: d.pct! }
    : { mode: "amount", amountCents: d.amount_cents! };

export async function standingDiscountSpec(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<CheckDiscountSpec | null> {
  const d = await standingDiscount(c, venueId, checkId);
  return d ? specOf(d) : null;
}

/** What a discount is, in the stored line's words: "Discount 10%" or "Discount $5.00". */
export const discountWords = (spec: CheckDiscountSpec): string =>
  spec.mode === "pct"
    ? `Discount ${String(spec.pct)}%`
    : `Discount ${formatMoney("en", cents(spec.amountCents))}`;
