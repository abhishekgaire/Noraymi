import { describe, expect, it } from "vitest";
import { unsentFood } from "./kitchen-unsent.js";

// Fri Sep 25, 2026, 11:36 PM in New York, the demo night's simulated clock.
const rung = "2026-09-26T03:36:00Z";
const at = (min: number) => Date.parse(rung) + min * 60_000;

describe("the Not sent reminder (K-05)", () => {
  it("counts unsent food items by quantity", () => {
    expect(
      unsentFood(
        [
          { qty: 2, rungAt: rung },
          { qty: 1, rungAt: rung },
        ],
        at(0),
        5,
      ).count,
    ).toBe(3);
    expect(unsentFood([], at(0), 5)).toEqual({ count: 0, warn: false });
  });
  it("leaves out food already taken off", () => {
    expect(unsentFood([{ qty: 0, rungAt: rung }], at(30), 5)).toEqual({ count: 0, warn: false });
  });
  it("shows after unsentWarnMin minutes on the venue's clock, not before", () => {
    expect(unsentFood([{ qty: 1, rungAt: rung }], at(4.98), 5).warn).toBe(false);
    expect(unsentFood([{ qty: 1, rungAt: rung }], at(5), 5)).toEqual({ count: 1, warn: true });
  });
  it("follows the setting: at 10 it waits ten minutes", () => {
    expect(unsentFood([{ qty: 1, rungAt: rung }], at(5), 10).warn).toBe(false);
    expect(unsentFood([{ qty: 1, rungAt: rung }], at(10), 10).warn).toBe(true);
  });
  it("one old item is enough, and food with no time never starts it", () => {
    const items = [
      { qty: 1, rungAt: rung },
      { qty: 2, rungAt: "2026-09-26T03:40:00Z" },
    ];
    expect(unsentFood(items, at(5), 5)).toEqual({ count: 3, warn: true });
    expect(unsentFood([{ qty: 1, rungAt: null }], at(60), 5).warn).toBe(false);
  });
});
