import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { coverageGaps, shiftAt, type RotaShift } from "./oncall-coverage.js";
import { hoursFor } from "./hours.js";
import { wallClock } from "./time.js";

const zone = "America/New_York";
const at = (date: string, time: string) => wallClock(date, time, zone, "06:00");
// The ticket's opening hours: 4 PM on weekdays, 2 PM on weekends, to 4 AM.
const hours = {
  timeZone: zone,
  dayCutover: "06:00",
  lastCall: "04:00",
  weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    opens: day === 0 || day === 6 ? "14:00" : "16:00",
    closes: "04:00",
  })),
};
const nights = (first: string, days: number) =>
  Array.from({ length: days }, (_, i) => {
    const d = Temporal.PlainDate.from(first).add({ days: i });
    const h = hoursFor({ timeZone: zone, dayCutover: "06:00" }, d, hours as never);
    return {
      businessDate: d.toString(),
      from: h.opens!,
      to: at(d.add({ days: 1 }).toString(), "06:00"),
    };
  });
const shift = (
  from: Temporal.Instant,
  to: Temporal.Instant,
  first = "ana@x",
  second = "ben@x",
): RotaShift => ({
  from,
  to,
  first,
  second,
});

describe("on-call coverage (M9-16)", () => {
  const week = nights("2026-10-12", 7); // Mon Oct 12 to Sun Oct 18
  const full = week.map((w) => shift(w.from, w.to));

  it("a shift per night, opening to cutover, covers the week", () => {
    expect(coverageGaps(week, full)).toEqual([]);
    expect(week[5]!.from.toString()).toBe(at("2026-10-17", "14:00").toString()); // Saturday opens at 2 PM
  });

  it("an hour nobody covers is a gap with its night and times", () => {
    const shifts = [
      ...full.slice(0, 2),
      shift(at("2026-10-14", "17:00"), week[2]!.to),
      ...full.slice(3),
    ];
    expect(coverageGaps(week, shifts)).toEqual([
      {
        businessDate: "2026-10-14",
        from: at("2026-10-14", "16:00"),
        to: at("2026-10-14", "17:00"),
        why: "uncovered",
      },
    ]);
  });

  it("a shift with no second responder, or the same person twice, doesn't count", () => {
    const one = [shift(week[0]!.from, week[0]!.to, "ana@x", "")];
    expect(coverageGaps(week.slice(0, 1), one)[0]!.why).toBe("no_second");
    const same = [shift(week[0]!.from, week[0]!.to, "ana@x", "ANA@x")];
    expect(coverageGaps(week.slice(0, 1), same)[0]!.why).toBe("same_person");
  });

  it("handovers can overlap, and through the daylight-saving change the night still counts its real hours", () => {
    const w = nights("2026-10-31", 1); // the night before Nov 1, when clocks go back at 2 AM
    expect(w[0]!.to.since(w[0]!.from).total("hours")).toBe(17); // 2 PM to 6 AM, plus the repeated hour
    const split = [
      shift(w[0]!.from, at("2026-10-31", "23:00")),
      shift(at("2026-10-31", "22:00"), w[0]!.to, "cy@x", "dee@x"),
    ];
    expect(coverageGaps(w, split)).toEqual([]);
    expect(shiftAt(split, at("2026-10-31", "22:30"))!.first).toBe("cy@x");
  });
});
