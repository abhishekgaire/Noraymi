import { describe, expect, it } from "vitest";
import { Temporal, cents } from "@west4/shared";
import { bandAt, bandBoundaries, rateAt, segmentsFor } from "./bands.js";
import { hourlyRateAt } from "./rates.js";
import { roomTime, roundToStep } from "./room-time.js";
import { WEST4_PRICES, WEST4_TIME } from "./west4-fixtures.js";

/**
 * M2-03 unit tests: a band that starts mid-session (a 12:30 AM band change on
 * a Saturday is minute 1,470 of Friday's business date), the billing step and
 * its rounding rules, and segments that tile a session.
 */
const lateNight = {
  ...WEST4_PRICES,
  bands: [
    {
      name: "late",
      days: [5, 6], // Friday and Saturday business dates
      fromMin: 1470, // 12:30 AM
      toMin: 1800, // 6:00 AM, the cutover
      rate: { mode: "perPerson" as const, perPersonCents: 1500 },
      billing: { incrementMin: 15 as const, rounding: "up" as const },
    },
  ],
};
const room = { id: "room_1", sizeTier: "m" };

describe("bands", () => {
  it("12:30 AM on a Saturday is minute 1,470 of Friday's business date, where the late band starts", () => {
    const fri = Temporal.PlainDate.from("2026-09-25");
    expect(bandAt(lateNight, fri, 1469).bandId).toBeNull();
    expect(bandAt(lateNight, fri, 1470).bandId).toBe("late");
    expect(bandAt(lateNight, Temporal.PlainDate.from("2026-09-23"), 1470).bandId).toBeNull();
    const before = Temporal.Instant.from("2026-09-26T00:29:00-04:00");
    const after = Temporal.Instant.from("2026-09-26T00:30:00-04:00");
    expect(hourlyRateAt(before, 4, room, lateNight, WEST4_TIME).hourlyCents).toBe(4000);
    expect(hourlyRateAt(after, 4, room, lateNight, WEST4_TIME).hourlyCents).toBe(6000);
    expect(rateAt(after, 4, room, lateNight, WEST4_TIME)).toMatchObject({
      bandId: "late",
      billing: { incrementMin: 15, rounding: "up" },
    });
  });

  it("a session across the band change closes one segment and opens the next, on the minute", () => {
    const start = Temporal.Instant.from("2026-09-25T23:00:00-04:00");
    const end = Temporal.Instant.from("2026-09-26T01:10:30-04:00");
    expect(bandBoundaries(start, end, lateNight, WEST4_TIME).map(String)).toEqual([
      "2026-09-26T04:30:00Z",
    ]);
    const segments = segmentsFor({ start, end, partySize: 4, room }, lateNight, WEST4_TIME);
    expect(
      segments.map((s) => [s.bandId, s.minutes, s.hourlyCents, s.incrementMin, s.rounding]),
    ).toEqual([
      [null, 90, 4000, 1, "nearest"],
      ["late", 40, 6000, 15, "up"],
    ]);
    // 130 minutes: 70 after the first hour, rounded up to 75 at the last segment's rate.
    const bill = roomTime(segments, {
      firstHourMinimum: true,
      step: { incrementMin: 15, rounding: "up" },
    });
    expect(bill.billedMinutes).toBe(135);
    expect(bill.cents).toBe(Math.floor((4000 * 90 + 6000 * 40 + 6000 * 5 + 30) / 60));
  });

  it("a party-size change mid-session opens a new segment at the new rate", () => {
    const start = Temporal.Instant.from("2026-09-25T20:00:00-04:00");
    const segments = segmentsFor(
      {
        start,
        end: start.add({ minutes: 84 }),
        partySize: 4,
        room,
        events: [{ at: start.add({ minutes: 40 }), partySize: 5 }],
      },
      WEST4_PRICES,
      WEST4_TIME,
    );
    expect(segments.map((s) => [s.minutes, s.billableGuests, s.hourlyCents])).toEqual([
      [40, 4, 4000],
      [44, 5, 5000],
    ]);
    expect(roomTime(segments, { firstHourMinimum: true }).cents).toBe(6333);
  });

  it("a pause is a segment that bills nothing", () => {
    const start = Temporal.Instant.from("2026-09-25T20:00:00-04:00");
    const segments = segmentsFor(
      {
        start,
        end: start.add({ minutes: 90 }),
        partySize: 4,
        room,
        events: [
          { at: start.add({ minutes: 30 }), paused: true },
          { at: start.add({ minutes: 45 }), paused: false },
        ],
      },
      WEST4_PRICES,
      WEST4_TIME,
    );
    expect(segments.map((s) => [s.minutes, s.paused])).toEqual([
      [30, false],
      [15, true],
      [45, false],
    ]);
    expect(roomTime(segments, { firstHourMinimum: true })).toMatchObject({
      elapsedMinutes: 75,
      cents: 5000,
    });
  });

  it("the step rounds minutes after the first hour by its rule: up, nearest (half up) and down", () => {
    expect(roundToStep(70, { incrementMin: 15, rounding: "up" })).toBe(75);
    expect(roundToStep(70, { incrementMin: 15, rounding: "nearest" })).toBe(75);
    expect(roundToStep(67, { incrementMin: 15, rounding: "nearest" })).toBe(60);
    expect(roundToStep(67.5, { incrementMin: 15, rounding: "nearest" })).toBe(75);
    expect(roundToStep(74, { incrementMin: 15, rounding: "down" })).toBe(60);
    expect(roundToStep(74, { incrementMin: 1, rounding: "down" })).toBe(74);
    // A step changes nothing inside the first hour; with the minimum, an hour is an hour.
    const segs = [{ minutes: 50, hourlyCents: cents(6000) }];
    expect(
      roomTime(segs, { firstHourMinimum: true, step: { incrementMin: 30, rounding: "up" } }).cents,
    ).toBe(6000);
    expect(
      roomTime([{ minutes: 61, hourlyCents: cents(6000) }], {
        firstHourMinimum: true,
        step: { incrementMin: 30, rounding: "up" },
      }).cents,
    ).toBe(9000);
  });

  it("West 4 bills by the minute: with no bands and a step of 1, the segments and the bill are the per-minute sum", () => {
    const start = Temporal.Instant.from("2026-09-25T20:00:00-04:00");
    const segments = segmentsFor(
      { start, end: start.add({ minutes: 161 }), partySize: 12, room },
      WEST4_PRICES,
      WEST4_TIME,
    );
    expect(segments).toHaveLength(1);
    expect(
      roomTime(segments, { firstHourMinimum: true, step: { incrementMin: 1, rounding: "nearest" } })
        .cents,
    ).toBe(32200);
  });
});
