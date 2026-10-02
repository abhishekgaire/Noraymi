import { cents, type Cents } from "@west4/shared";

/**
 * The cash panel's arithmetic (M4-13; Payment flows · Cash): Exact, then
 * the next $5, $10 and $20 above what's owed, each shown once; and the change
 * due on what was handed over.
 */
export interface CashOffer {
  readonly kind: "exact" | "next5" | "next10" | "next20";
  readonly cents: Cents;
}

const nextMultiple = (amount: number, step: number) => Math.ceil(amount / step) * step;

/** Exact, and the next $5, $10 and $20 (rounded up to that note), dropping any that repeat an earlier one. */
export function cashOffers(owedCents: number): CashOffer[] {
  const offers: CashOffer[] = [{ kind: "exact", cents: cents(owedCents) }];
  for (const [kind, step] of [
    ["next5", 500],
    ["next10", 1000],
    ["next20", 2000],
  ] as const) {
    const amount = nextMultiple(owedCents, step);
    if (!offers.some((o) => o.cents === amount)) offers.push({ kind, cents: cents(amount) });
  }
  return offers;
}

/** The change due on cash handed over for the amount and any cash tip; never negative (null when short). */
export function changeDue(input: {
  owedCents: number;
  tipCents?: number;
  tenderedCents: number;
}): Cents | null {
  const change = input.tenderedCents - input.owedCents - (input.tipCents ?? 0);
  return change < 0 ? null : cents(change);
}
