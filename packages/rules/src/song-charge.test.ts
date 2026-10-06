import { describe, expect, it } from "vitest";
import { prepaidCreditValue, songCharge } from "./song-queue.js";

/** What Started charges (M6-19): the seed's singers at West 4 (no song price) and a $5.00 test venue. */
describe("songCharge", () => {
  const drink = { source: "drink" as const, valueCents: 0 };
  it("Luis M. on a drink credit with a tab: a $0.00 line", () => {
    expect(songCharge({ credit: drink, songPriceCents: null, hasTab: true })).toEqual({
      kind: "charge",
      paidWith: "drink_credit",
      amountCents: 0,
      postsLine: true,
    });
  });
  it("Kira on a drink credit with no tab: the credit is spent and no line posts", () => {
    expect(songCharge({ credit: drink, songPriceCents: null, hasTab: false })).toMatchObject({
      kind: "charge",
      paidWith: "drink_credit",
      postsLine: false,
    });
  });
  it("Sofia R. with no credit and no song price: Needs a drink credit, tab or not", () => {
    for (const hasTab of [true, false])
      expect(songCharge({ credit: null, songPriceCents: null, hasTab })).toEqual({
        kind: "refused",
        reason: "needs_drink_credit",
      });
  });
  it("a $5.00 song price with no credit: $5.00 on the tab, or a tab first", () => {
    expect(songCharge({ credit: null, songPriceCents: 500, hasTab: true })).toEqual({
      kind: "charge",
      paidWith: "price",
      amountCents: 500,
      postsLine: true,
    });
    expect(songCharge({ credit: null, songPriceCents: 500, hasTab: false })).toEqual({
      kind: "refused",
      reason: "needs_tab",
    });
  });
  it("a credit always wins over the price; a prepaid credit posts what was paid for it", () => {
    expect(songCharge({ credit: drink, songPriceCents: 500, hasTab: true })).toMatchObject({
      paidWith: "drink_credit",
      amountCents: 0,
    });
    expect(
      songCharge({
        credit: { source: "prepaid", valueCents: 500 },
        songPriceCents: 700,
        hasTab: true,
      }),
    ).toMatchObject({ paidWith: "prepaid_credit", amountCents: 500, postsLine: true });
  });
  it("a prepaid credit's value is its purchase over the credits it gave, in whole cents", () => {
    expect(prepaidCreditValue(1000, 2)).toBe(500);
    expect(prepaidCreditValue(500, 1)).toBe(500);
    expect(prepaidCreditValue(0, 0)).toBe(0);
  });
});
