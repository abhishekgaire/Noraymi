import { describe, expect, it } from "vitest";
import { Temporal, type Hours } from "@west4/shared";
import { slotOf, syntheticSlot, type LiveVenueHours } from "./synthetic-schedule.js";

/**
 * The synthetic check's schedule (M8-18), on a clock: every 5 minutes during West 4's hours (4:00 PM
 * to 4:00 AM on weekdays, 2:00 PM to 4:00 AM on Saturdays and Sundays) and never outside them,
 * through both daylight-saving nights. The scheduler is stepped a minute at a time (it looks far
 * more often than every 5 minutes) and each distinct slot is one run.
 */
const ZONE = "America/New_York";
const hours: Hours = {
  weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    opens: day === 0 || day === 6 ? "14:00" : "16:00",
    closes: "04:00",
  })),
  lastCall: "04:00",
};
const west4: LiveVenueHours = { time: { timeZone: ZONE, dayCutover: "06:00" }, hours };
const at = (wall: string) => Temporal.ZonedDateTime.from(`${wall}[${ZONE}]`).toInstant();
const ny = (i: Temporal.Instant) => i.toZonedDateTimeISO(ZONE).toPlainDateTime().toString();

/** Every run between two wall times, the scheduler looking once a minute. */
function runs(from: string, to: string, venues: readonly LiveVenueHours[] = [west4]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let t = at(from); Temporal.Instant.compare(t, at(to)) < 0; t = t.add({ minutes: 1 })) {
    const slot = syntheticSlot(venues, t);
    if (slot && !seen.has(slot.toString())) {
      seen.add(slot.toString());
      out.push(ny(slot));
    }
  }
  return out;
}

describe("the synthetic check's schedule", () => {
  it("a weekday night: every 5 minutes from 4:00 PM to the last run at 3:55 AM, 144 runs", () => {
    const r = runs("2026-09-25T12:00", "2026-09-26T08:00");
    expect(r).toHaveLength(144);
    expect(r[0]).toBe("2026-09-25T16:00:00");
    expect(r[1]).toBe("2026-09-25T16:05:00");
    expect(r.at(-1)).toBe("2026-09-26T03:55:00");
  });

  it("nothing at 3:59 PM on a weekday or at 4:00 AM; Saturday starts at 2:00 PM", () => {
    expect(syntheticSlot([west4], at("2026-09-25T15:59"))).toBeNull();
    expect(syntheticSlot([west4], at("2026-09-26T04:00"))).toBeNull();
    expect(syntheticSlot([west4], at("2026-09-26T13:59"))).toBeNull();
    expect(ny(syntheticSlot([west4], at("2026-09-26T14:03"))!)).toBe("2026-09-26T14:00:00");
    expect(runs("2026-09-26T04:00", "2026-09-26T14:00")).toEqual([]);
  });

  it("the night the clocks go back (Sat Oct 31 to Sun Nov 1, 2026): 15 real hours, 180 runs", () => {
    const r = runs("2026-10-31T12:00", "2026-11-01T08:00");
    expect(r).toHaveLength(180);
    expect(r[0]).toBe("2026-10-31T14:00:00");
    expect(r.at(-1)).toBe("2026-11-01T03:55:00");
    // 1:00 to 2:00 AM happens twice on the wall clock, so twice as many runs carry those times.
    expect(r.filter((x) => x.startsWith("2026-11-01T01:"))).toHaveLength(24);
  });

  it("the night the clocks go forward (Sat Mar 13 to Sun Mar 14, 2027): 13 real hours, 156 runs", () => {
    const r = runs("2027-03-13T12:00", "2027-03-14T08:00");
    expect(r).toHaveLength(156);
    expect(r[0]).toBe("2027-03-13T14:00:00");
    expect(r.at(-1)).toBe("2027-03-14T03:55:00");
    // 2:00 to 3:00 AM doesn't exist on the wall clock that night.
    expect(r.filter((x) => x.startsWith("2027-03-14T02:"))).toEqual([]);
    expect(r).toContain("2027-03-14T01:55:00");
    expect(r).toContain("2027-03-14T03:00:00");
  });

  it("a slot is the 5-minute mark, so a scheduler restart inside it runs nothing new", () => {
    expect(slotOf(at("2026-09-25T22:41:30")).toString()).toBe(at("2026-09-25T22:40").toString());
    expect(slotOf(at("2026-09-25T22:44:59.999")).toString()).toBe(
      at("2026-09-25T22:40").toString(),
    );
  });

  it("no live venue with hours, or none open: no run (our test venue's hours don't count)", () => {
    expect(syntheticSlot([], at("2026-09-25T22:41"))).toBeNull();
    expect(syntheticSlot([{ ...west4, hours: null }], at("2026-09-25T22:41"))).toBeNull();
    const closed: LiveVenueHours = {
      ...west4,
      closure: { date: "2026-09-25", kind: "closed" },
    };
    expect(syntheticSlot([closed], at("2026-09-25T22:41"))).toBeNull();
  });
});
