import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { googleHours } from "./google-hours.js";

const hours = {
  weekly: [
    { day: 5, opens: "16:00", closes: "04:00" },
    { day: 6, opens: "14:00", closes: "04:00" },
    { day: 1, opens: "18:00", closes: "23:30" },
  ],
  lastCall: "04:00",
};
const today = Temporal.PlainDate.from("2026-09-25");

describe("googleHours (M5-15)", () => {
  it("turns the weekly hours into regular periods, a 4 AM close on the next day", () => {
    const g = googleHours(hours, [], today, "06:00:00");
    expect(g.regularHours.periods).toEqual([
      {
        openDay: "MONDAY",
        openTime: { hours: 18, minutes: 0 },
        closeDay: "MONDAY",
        closeTime: { hours: 23, minutes: 30 },
      },
      {
        openDay: "FRIDAY",
        openTime: { hours: 16, minutes: 0 },
        closeDay: "SATURDAY",
        closeTime: { hours: 4, minutes: 0 },
      },
      {
        openDay: "SATURDAY",
        openTime: { hours: 14, minutes: 0 },
        closeDay: "SUNDAY",
        closeTime: { hours: 4, minutes: 0 },
      },
    ]);
  });

  it("sends closed dates and special dates from today on, filling a missing side from the week", () => {
    const g = googleHours(
      hours,
      [
        { date: "2026-10-02", kind: "special", opens: null, closes: "02:00" },
        { date: "2026-09-24", kind: "closed" },
        { date: "2026-12-25", kind: "closed" },
      ],
      today,
      "06:00",
    );
    expect(g.specialHours.specialHourPeriods).toEqual([
      {
        startDate: { year: 2026, month: 10, day: 2 },
        openTime: { hours: 16, minutes: 0 },
        endDate: { year: 2026, month: 10, day: 3 },
        closeTime: { hours: 2, minutes: 0 },
      },
      { startDate: { year: 2026, month: 12, day: 25 }, closed: true },
    ]);
  });

  it("marks a special date with no hours to fall back on as closed", () => {
    const g = googleHours(
      hours,
      [{ date: "2026-09-29", kind: "special", opens: "20:00", closes: null }],
      today,
      "06:00",
    );
    expect(g.specialHours.specialHourPeriods).toEqual([
      { startDate: { year: 2026, month: 9, day: 29 }, closed: true },
    ]);
  });
});
