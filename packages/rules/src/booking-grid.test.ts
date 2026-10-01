import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { bookingGrid, resolveStart } from "./booking-grid.js";
import { wallClock } from "./time.js";

const tz = "America/New_York";
const night = (date: string, opens: string) => ({
  opens: wallClock(date, opens, tz, "06:00"),
  closes: wallClock(date, "04:00", tz, "06:00"),
});

describe("the booking grid", () => {
  it("on the fall-back night (Sat Oct 31, 2026) offers 1:00 AM EDT and 1:00 AM EST", () => {
    const grid = bookingGrid({
      ...night("2026-10-31", "14:00"),
      minHours: 1,
      startSlots: [],
      timeZone: tz,
    });
    const late = grid.filter((s) => s.time === "01:00" || s.time === "01:30");
    expect(late.map((s) => `${s.time} ${s.zone}`)).toEqual([
      "01:00 EDT",
      "01:30 EDT",
      "01:00 EST",
      "01:30 EST",
    ]);
    expect(late.map((s) => s.offset)).toEqual(["-04:00", "-04:00", "-05:00", "-05:00"]);
    // Every slot is 30 real minutes after the one before, and the last ends by the close.
    for (let i = 1; i < grid.length; i++)
      expect(grid[i]!.start.epochMilliseconds - grid[i - 1]!.start.epochMilliseconds).toBe(
        30 * 60_000,
      );
    expect(grid.at(-1)!.time).toBe("03:00");
  });

  it("on the spring-forward night (Sat Mar 13, 2027) skips 2:00 and 2:30 AM", () => {
    const grid = bookingGrid({
      ...night("2027-03-13", "14:00"),
      minHours: 1,
      startSlots: [],
      timeZone: tz,
    });
    const times = grid.map((s) => s.time);
    expect(times).toContain("01:30");
    expect(times).not.toContain("02:00");
    expect(times).not.toContain("02:30");
    expect(times.at(-1)).toBe("03:00");
    expect(grid.find((s) => s.time === "03:00")!.zone).toBe("EDT");
  });

  it("a venue's start slots narrow the grid", () => {
    const grid = bookingGrid({
      ...night("2026-09-26", "14:00"),
      minHours: 2,
      startSlots: ["21:00", "21:30", "02:00"],
      timeZone: tz,
    });
    expect(grid.map((s) => s.time)).toEqual(["21:00", "21:30", "02:00"]);
  });
});

describe("resolving a wall-clock start", () => {
  const date = (d: string) => Temporal.PlainDate.from(d);
  it("9:30 PM on Sat Sep 26 is that evening; 12:30 AM is the next calendar day", () => {
    expect(resolveStart(date("2026-09-26"), "21:30", tz, "06:00")).toEqual({
      start: Temporal.Instant.from("2026-09-26T21:30:00-04:00"),
    });
    expect(resolveStart(date("2026-09-26"), "00:30", tz, "06:00")).toEqual({
      start: Temporal.Instant.from("2026-09-27T00:30:00-04:00"),
    });
  });
  it("2:30 AM on the spring-forward night doesn't exist", () => {
    expect(resolveStart(date("2027-03-13"), "02:30", tz, "06:00")).toEqual({
      refused: "does_not_exist",
    });
  });
  it("1:00 AM on the fall-back night needs its offset; each offset picks its hour", () => {
    expect(resolveStart(date("2026-10-31"), "01:00", tz, "06:00")).toEqual({
      refused: "ambiguous",
    });
    expect(resolveStart(date("2026-10-31"), "01:00", tz, "06:00", "-04:00")).toEqual({
      start: Temporal.Instant.from("2026-11-01T05:00:00Z"),
    });
    expect(resolveStart(date("2026-10-31"), "01:00", tz, "06:00", "-05:00")).toEqual({
      start: Temporal.Instant.from("2026-11-01T06:00:00Z"),
    });
  });
  it("refuses a time that isn't one", () => {
    expect(resolveStart(date("2026-09-26"), "9pm", tz, "06:00")).toEqual({ refused: "not_a_time" });
  });
});
