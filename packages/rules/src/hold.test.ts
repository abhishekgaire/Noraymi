import { describe, expect, it } from "vitest";
import {
  INCREMENT_BUDGET,
  capCents,
  closePlan,
  holdDecision,
  holdLeftCents,
  holdNeededCents,
  holdTarget,
  overcaptureAllowanceCents,
  tipReserveCents,
  type HoldCard,
} from "./hold.js";

const card = (over: Partial<HoldCard> = {}): HoldCard => ({
  holdCents: 5000,
  incrementalSupported: true,
  overcaptureSupported: true,
  incrementsUsed: 0,
  ...over,
});

/** M6-07: the growing hold's step sizing, the tip reserve and the cap. */
describe("the growing hold", () => {
  it("Luis M.: his first round ($43.55, $40.00 of drinks) takes the hold from $50.00 to $80.00", () => {
    const need = holdNeededCents(4355, 4000);
    expect(need).toBe(5355);
    expect(holdDecision(card(), need)).toEqual({ kind: "raise", targetCents: 8000 });
  });

  it("Luis M.: at $63.15 ($58.00 of drinks) the $80.00 hold still fits, with $2.35 left", () => {
    const need = holdNeededCents(6315, 5800);
    expect(need).toBe(7765);
    expect(holdDecision(card({ holdCents: 8000, incrementsUsed: 1 }), need)).toEqual({
      kind: "fits",
      leftCents: 235,
      capped: false,
    });
    // The ticket's note, from the whole tab at once: max($77.65, $75.00) → $80.00.
    expect(holdTarget(5000, need)).toBe(8000);
  });

  it("the reserve is 25% of the drinks, half up; a step is at least 1.5 × the hold, to the next $10", () => {
    expect(tipReserveCents(1002)).toBe(251);
    expect(holdTarget(5000, 5001)).toBe(8000);
    expect(holdTarget(8000, 13000)).toBe(13000);
    expect(holdTarget(8000, 13001)).toBe(14000);
  });

  it("Jess P.: $32.66 with $7.50 reserved fits her $50.00 hold", () => {
    expect(holdDecision(card(), holdNeededCents(3266, 3000))).toEqual({
      kind: "fits",
      leftCents: 984,
      capped: false,
    });
  });

  it("a card that can't grow is capped at the hold plus the overcapture allowance", () => {
    expect(overcaptureAllowanceCents(5000, true)).toBe(5000);
    expect(overcaptureAllowanceCents(20000, true)).toBe(10000);
    expect(overcaptureAllowanceCents(5000, false)).toBe(0);
    const fixed = card({ incrementalSupported: false });
    expect(capCents(fixed)).toBe(10000);
    expect(holdDecision(fixed, 9400)).toEqual({ kind: "fits", leftCents: 600, capped: true });
    expect(holdLeftCents(fixed, 9400)).toBe(600);
    expect(holdDecision(fixed, 10100)).toEqual({ kind: "capped", leftCents: 0, overCents: 100 });
    const noOver = card({ incrementalSupported: false, overcaptureSupported: false });
    expect(holdDecision(noOver, 5001).kind).toBe("capped");
  });

  it("never uses more than 8 of Stripe's 10 attempts before the close, declines included", () => {
    // Rounds of every size, from a $9 beer to a $300 bottle, until the tab passes $5,000.
    for (const round of [900, 1800, 4000, 7000, 12000, 30000]) {
      let hold = card();
      let drinks = 0;
      while (drinks < 500_000) {
        drinks += round;
        const balance = drinks + Math.round((drinks * 8875) / 100000);
        const need = holdNeededCents(balance, drinks);
        const d = holdDecision(hold, need);
        if (d.kind === "raise") {
          expect(d.targetCents).toBeGreaterThanOrEqual(need);
          expect(d.targetCents).toBeGreaterThanOrEqual(Math.ceil(hold.holdCents * 1.5));
          hold = { ...hold, holdCents: d.targetCents, incrementsUsed: hold.incrementsUsed + 1 };
        }
        expect(hold.incrementsUsed).toBeLessThanOrEqual(INCREMENT_BUDGET);
        if (d.kind === "capped") break;
      }
      expect(hold.incrementsUsed).toBe(INCREMENT_BUDGET);
    }
    // Declines count: with 8 used, nothing more is asked of Stripe and the tab is capped.
    expect(holdDecision(card({ incrementsUsed: 8 }), 6000)).toEqual({
      kind: "fits",
      leftCents: 4000,
      capped: true,
    });
    expect(holdDecision(card({ incrementsUsed: 7 }), 6000).kind).toBe("raise");
  });
});

describe("closePlan · closing on the hold (M6-08)", () => {
  it("Luis M.: $63.15 with a 22% tip ($12.76) captures $75.91 on his $80.00 hold with no raise", () => {
    expect(closePlan(card({ holdCents: 8000, incrementsUsed: 1 }), 6315 + 1276)).toEqual({
      kind: "capture",
      captureCents: 7591,
    });
  });
  it("up to his hold plus $50 ($130.00) is captured without a raise; a cent over raises first", () => {
    const luis = card({ holdCents: 8000, incrementsUsed: 1 });
    expect(closePlan(luis, 13000).kind).toBe("capture");
    expect(closePlan(luis, 13001)).toEqual({
      kind: "raise",
      targetCents: 13001,
      captureCents: 13001,
    });
  });
  it("50% is the allowance on a hold over $100", () => {
    expect(closePlan(card({ holdCents: 20000 }), 30000).kind).toBe("capture");
    expect(closePlan(card({ holdCents: 20000 }), 30001).kind).toBe("raise");
  });
  it("closing may use the two attempts kept back, but never Stripe's eleventh", () => {
    expect(closePlan(card({ incrementsUsed: INCREMENT_BUDGET + 1 }), 20000).kind).toBe("raise");
    expect(closePlan(card({ incrementsUsed: 10 }), 20000)).toEqual({
      kind: "over",
      captureCents: 20000,
      overCents: 10000,
    });
  });
  it("a card that can't grow and is past its cap is over", () => {
    expect(closePlan(card({ incrementalSupported: false }), 10001)).toMatchObject({
      kind: "over",
      overCents: 1,
    });
  });
});
