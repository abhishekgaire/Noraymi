import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkCount, drawerTotals, moveSign, type DrawerMoveKind } from "./drawer.js";

const KINDS: DrawerMoveKind[] = ["sale", "refund", "paid_out", "drop", "no_sale", "tip_out"];

describe("what a drawer should hold", () => {
  it("adds sales and drops and takes off refunds, paid-outs and tip-outs; a no-sale moves nothing", () => {
    const t = drawerTotals(30_000, [
      { kind: "sale", amountCents: 4_800 },
      { kind: "sale", amountCents: 2_200 },
      { kind: "drop", amountCents: 6_000 },
      { kind: "refund", amountCents: 1_200 },
      { kind: "paid_out", amountCents: 2_500 },
      { kind: "tip_out", amountCents: 1_000 },
      { kind: "no_sale", amountCents: 0 },
    ]);
    expect(t).toEqual({
      openingCents: 30_000,
      cashTakenCents: 7_000,
      dropsCents: 6_000,
      refundsCents: 1_200,
      paidOutsCents: 2_500,
      tipOutsCents: 1_000,
      noSales: 1,
      expectedCents: 30_000 + 7_000 + 6_000 - 1_200 - 2_500 - 1_000,
    });
  });

  it("is always the opening plus the signed sum of the moves", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(
          fc.record({
            kind: fc.constantFrom(...KINDS),
            amountCents: fc.integer({ min: 0, max: 500_000 }),
          }),
          { maxLength: 60 },
        ),
        (opening, moves) => {
          const t = drawerTotals(opening, moves);
          const signed = moves.reduce((s, m) => s + moveSign(m.kind) * m.amountCents, 0);
          expect(t.expectedCents).toBe(opening + signed);
          expect(Number.isInteger(t.expectedCents)).toBe(true);
          expect(t.expectedCents).toBe(
            t.openingCents +
              t.cashTakenCents +
              t.dropsCents -
              t.refundsCents -
              t.paidOutsCents -
              t.tipOutsCents,
          );
        },
      ),
    );
  });
});

describe("what a count needs", () => {
  const limit = { noteOverCents: 2_000 };
  it("needs a note only past the limit, and a second counter on whenOff only then", () => {
    expect(
      checkCount({
        countedCents: 27_500,
        expectedCents: 30_000,
        ...limit,
        secondCounter: "whenOff",
      }),
    ).toEqual({ overShortCents: -2_500, needsNote: true, needsWitness: true });
    expect(
      checkCount({
        countedCents: 28_000,
        expectedCents: 30_000,
        ...limit,
        secondCounter: "whenOff",
      }),
    ).toEqual({ overShortCents: -2_000, needsNote: false, needsWitness: false });
    expect(
      checkCount({
        countedCents: 30_000,
        expectedCents: 30_000,
        ...limit,
        secondCounter: "always",
      }),
    ).toEqual({ overShortCents: 0, needsNote: false, needsWitness: true });
    expect(
      checkCount({ countedCents: 33_000, expectedCents: 30_000, ...limit, secondCounter: "never" }),
    ).toEqual({ overShortCents: 3_000, needsNote: true, needsWitness: false });
  });
});
