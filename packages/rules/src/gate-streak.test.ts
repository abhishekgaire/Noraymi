import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { GATE_DAYS, gateStreak } from "./gate-streak.js";

const nights = (from: string, days: number, ok = true, skip: number[] = []) =>
  Array.from({ length: days }, (_, i) => i)
    .filter((i) => !skip.includes(i))
    .map((i) => ({ night: Temporal.PlainDate.from(from).add({ days: i }).toString(), ok }));

describe("the gate's 4 weeks (M9-17)", () => {
  it("before any live night, nothing counts", () =>
    expect(gateStreak([])).toMatchObject({
      cleanNights: 0,
      runStartedOn: null,
      daysToGo: GATE_DAYS,
      met: false,
    }));

  it("28 clean calendar days meet it; the nights the venue was shut don't break the run", () => {
    const r = gateStreak(nights("2026-11-02", 28, true, [7, 14]));
    expect(r).toMatchObject({
      cleanNights: 26,
      runStartedOn: "2026-11-02",
      daysInRun: 28,
      daysToGo: 0,
      met: true,
    });
    expect(gateStreak(nights("2026-11-02", 27)).met).toBe(false);
  });

  it("a money error starts the 4 weeks again from the next night", () => {
    const all = [
      ...nights("2026-11-02", 20),
      { night: "2026-11-22", ok: false },
      ...nights("2026-11-23", 10),
    ];
    expect(gateStreak(all)).toMatchObject({
      cleanNights: 10,
      runStartedOn: "2026-11-23",
      lastErrorOn: "2026-11-22",
      daysInRun: 10,
      daysToGo: 18,
      met: false,
    });
  });

  it("one row per night, in any order", () => {
    const r = gateStreak([...nights("2026-11-02", 3)].reverse());
    expect(r).toMatchObject({ cleanNights: 3, runStartedOn: "2026-11-02", daysInRun: 3 });
  });
});
