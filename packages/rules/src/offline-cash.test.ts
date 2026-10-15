import { describe, expect, it } from "vitest";
import { cashDiscount, checkTotals } from "./check-totals.js";
import { offlineCashSalePrice, type OfflineCashTerms } from "./offline-cash.js";

/**
 * A cash quick sale taken offline (U-16; D133; spec 09 · Cash quick sales while offline): the bar
 * computer prices it from the terms it kept, by the same rules the server uses when it makes the
 * sale on replay, so the replay lands to the cent.
 */
const NYC = {
  rate: 0.08875,
  taxedCategories: ["room_time", "drink", "food", "song", "damage", "fee"],
  surchargeTaxable: true,
  jurisdictionCode: "NY-NYC",
} as const;
const west4: OfflineCashTerms = { tax: NYC, gratuityPct: null, cashDiscount: null };
const singSing: OfflineCashTerms = {
  ...west4,
  cashDiscount: { pct: 3.38, taxRatePct: "8.875", foodIncludesFee: true },
};

describe("offlineCashSalePrice", () => {
  it("a Bud Light at West 4: $8.00 and 8.875% tax is $8.71, and cash pays the same", () => {
    const p = offlineCashSalePrice([{ qty: 1, unitCents: 800, taxCategory: "drink" }], west4);
    expect(p).toEqual({
      subtotalCents: 800,
      taxCents: 71,
      gratuityCents: 0,
      totalCents: 871,
      cashCents: 871,
    });
  });

  it("with Sing Sing's 3.38% cash discount, cash pays $8.39 for the same beer", () => {
    const p = offlineCashSalePrice([{ qty: 1, unitCents: 800, taxCategory: "drink" }], singSing);
    expect(p.totalCents).toBe(871);
    expect(p.cashCents).toBe(839);
  });

  it("matches checkTotals and cashDiscount on a bigger round, so it is the server's rule", () => {
    const lines = [
      { qty: 3, unitCents: 1200, taxCategory: "drink" as const },
      { qty: 2, unitCents: 800, taxCategory: "drink" as const },
    ];
    const totals = checkTotals(
      lines.map((l) => ({ kind: "item", taxCategory: l.taxCategory, cents: l.qty * l.unitCents })),
      { tax: { ...NYC, taxedCategories: [...NYC.taxedCategories] }, gratuityPct: null },
    );
    const cash = cashDiscount({
      amountCents: totals.totalCents,
      pct: 3.38,
      taxRatePct: "8.875",
      foodIncludesFee: true,
      foodWeightCents: 0,
      otherWeightCents: 0,
    }).cashPaysCents;
    const p = offlineCashSalePrice(lines, singSing);
    expect(p.totalCents).toBe(totals.totalCents);
    expect(p.cashCents).toBe(cash);
    expect(Number.isInteger(p.cashCents)).toBe(true);
  });

  it("an automatic gratuity on every check is added before tax, as the server does", () => {
    const p = offlineCashSalePrice([{ qty: 1, unitCents: 1000, taxCategory: "drink" }], {
      ...west4,
      gratuityPct: 20,
    });
    expect(p).toMatchObject({ taxCents: 89, gratuityCents: 200, totalCents: 1289 });
  });

  it("food is left out of the discount where food prices don't include the fee", () => {
    const p = offlineCashSalePrice(
      [
        { qty: 1, unitCents: 1000, taxCategory: "food" },
        { qty: 1, unitCents: 1000, taxCategory: "drink" },
      ],
      { ...singSing, cashDiscount: { ...singSing.cashDiscount!, foodIncludesFee: false } },
    );
    const expected = cashDiscount({
      amountCents: p.totalCents,
      pct: 3.38,
      taxRatePct: "8.875",
      foodIncludesFee: false,
      foodWeightCents: 1000,
      otherWeightCents: 1000,
    }).cashPaysCents;
    expect(p.cashCents).toBe(expected);
  });

  it("refuses a fraction of a cent or a negative price", () => {
    expect(() =>
      offlineCashSalePrice([{ qty: 1, unitCents: 8.5, taxCategory: "drink" }], west4),
    ).toThrow();
    expect(() =>
      offlineCashSalePrice([{ qty: 0, unitCents: 800, taxCategory: "drink" }], west4),
    ).toThrow();
  });
});
