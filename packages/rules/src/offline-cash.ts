import { cashDiscount, checkTotals, type SalesTaxRule, type TaxCategory } from "./check-totals.js";

/**
 * Cash quick sales while offline (U-16; D133; spec 09 · Cash quick sales while offline). With the
 * venue's switch on, the bar computer prices a cash quick sale from the terms it kept at its last
 * sync (the sales tax, an automatic gratuity on every check, and the cash discount), by the same
 * rules the server uses when the replay makes the sale: `checkTotals` for the check, then
 * `cashDiscount` on what's due. The replay compares its own price with this one, cent for cent.
 */
export interface OfflineCashTerms {
  readonly tax: SalesTaxRule;
  /** The gratuity on a quick check (only "on every check" reaches one), or null for none. */
  readonly gratuityPct: number | string | null;
  /** The cash discount (U-02) when it's on tonight, else null. */
  readonly cashDiscount: {
    readonly pct: number | string;
    readonly taxRatePct: number | string;
    readonly foodIncludesFee: boolean;
  } | null;
}

export interface OfflineCashLine {
  readonly qty: number;
  readonly unitCents: number;
  readonly taxCategory: TaxCategory | null;
}

export interface OfflineCashPrice {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly gratuityCents: number;
  /** What a card would pay: the check's total. */
  readonly totalCents: number;
  /** What cash pays: the total, less the cash discount and its tax where it's on. */
  readonly cashCents: number;
}

export function offlineCashSalePrice(
  lines: readonly OfflineCashLine[],
  terms: OfflineCashTerms,
): OfflineCashPrice {
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new RangeError("a quantity is a whole number");
    if (!Number.isInteger(l.unitCents) || l.unitCents < 0)
      throw new RangeError("a price is whole cents");
  }
  const net = lines.map((l) => ({
    kind: "item",
    taxCategory: l.taxCategory,
    cents: l.qty * l.unitCents,
  }));
  const totals = checkTotals(net, { tax: terms.tax, gratuityPct: terms.gratuityPct });
  const d = terms.cashDiscount;
  const sum = (food: boolean) =>
    net
      .filter((l) => l.taxCategory !== null && (l.taxCategory === "food") === food)
      .reduce((s, l) => s + l.cents, 0);
  const cash =
    d && totals.totalCents > 0
      ? cashDiscount({
          amountCents: totals.totalCents,
          pct: d.pct,
          taxRatePct: d.taxRatePct,
          foodIncludesFee: d.foodIncludesFee,
          // The server weighs the check's own lines only when food is left out of the discount.
          foodWeightCents: d.foodIncludesFee ? 0 : sum(true),
          otherWeightCents: d.foodIncludesFee ? 0 : sum(false),
        }).cashPaysCents
      : totals.totalCents;
  return {
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    gratuityCents: totals.gratuityCents,
    totalCents: totals.totalCents,
    cashCents: cash,
  };
}
