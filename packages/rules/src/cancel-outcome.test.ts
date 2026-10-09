import { describe, expect, it } from "vitest";
import { cancelOutcome, noShowOutcome } from "./cancel-outcome.js";

/**
 * M5-12 (Payment flows · Deposit when booking online, steps 4 and 6; Money
 * rules 11), written before the code: a cancel before the refund cut-off
 * refunds the deposit; after it the accepted policy keeps it, refunds half or
 * refunds it; a no-show keeps it, charges up to the first hour in total, or
 * (the flagged cautious default) refunds it; the venue cancelling refunds in full.
 */
describe("cancelOutcome", () => {
  it("Jae cancels Thu 10:00 PM, before Thu 11:00 PM: $50.00 back", () => {
    expect(cancelOutcome({ heldCents: 5000, beforeCutoff: true, late: "keep" })).toEqual({
      refundCents: 5000,
      keptCents: 0,
    });
  });
  it("Jae cancels Fri 10:41 PM, after the cut-off, under keep: the $50.00 is kept", () => {
    expect(cancelOutcome({ heldCents: 5000, beforeCutoff: false, late: "keep" })).toEqual({
      refundCents: 0,
      keptCents: 5000,
    });
  });
  it("half: half back, rounded half up to the cent, and the parts add up", () => {
    expect(cancelOutcome({ heldCents: 5000, beforeCutoff: false, late: "half" })).toEqual({
      refundCents: 2500,
      keptCents: 2500,
    });
    expect(cancelOutcome({ heldCents: 2501, beforeCutoff: false, late: "half" })).toEqual({
      refundCents: 1251,
      keptCents: 1250,
    });
  });
  it("refund: all of it back even after the cut-off", () => {
    expect(cancelOutcome({ heldCents: 5000, beforeCutoff: false, late: "refund" })).toEqual({
      refundCents: 5000,
      keptCents: 0,
    });
  });
  it("the venue cancelling always refunds in full", () => {
    expect(
      cancelOutcome({ heldCents: 6000, beforeCutoff: false, late: "keep", byVenue: true }),
    ).toEqual({ refundCents: 6000, keptCents: 0 });
  });
  it("nothing held, nothing moves", () => {
    expect(cancelOutcome({ heldCents: 0, beforeCutoff: false, late: "keep" })).toEqual({
      refundCents: 0,
      keptCents: 0,
    });
  });
});

describe("noShowOutcome", () => {
  it("the Nguyens under keep: their $60.00 is kept", () => {
    expect(noShowOutcome({ heldCents: 6000, noShow: "keep", firstHourCents: 6000 })).toEqual({
      refundCents: 0,
      keptCents: 6000,
      chargeCents: 0,
    });
  });
  it("firstHour with a deposit short of it: kept, and the rest charged off-session", () => {
    expect(noShowOutcome({ heldCents: 4000, noShow: "firstHour", firstHourCents: 6000 })).toEqual({
      refundCents: 0,
      keptCents: 4000,
      chargeCents: 2000,
    });
  });
  it("firstHour with more than the first hour held: the first hour kept, the rest back", () => {
    expect(noShowOutcome({ heldCents: 6000, noShow: "firstHour", firstHourCents: 4000 })).toEqual({
      refundCents: 2000,
      keptCents: 4000,
      chargeCents: 0,
    });
  });
  it("nothing: the cautious default refunds the deposit and charges nothing", () => {
    expect(noShowOutcome({ heldCents: 6000, noShow: "nothing", firstHourCents: 6000 })).toEqual({
      refundCents: 6000,
      keptCents: 0,
      chargeCents: 0,
    });
  });
});
