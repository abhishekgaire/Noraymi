import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Temporal, cents } from "@west4/shared";
import { roomTime, roomTimeBetween } from "./room-time.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const moneyCases = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    inputs: {
      segments?: { minutes: number; hourly_cents: number }[];
      first_hour_minimum?: boolean;
      start?: string;
      end?: string;
      hourly_cents?: number;
    };
    expected: { room_time_cents: number; elapsed_minutes?: number };
    must_not_equal?: { room_time_cents?: number };
  }[];
};

/**
 * M2-01: the `room_time` group (spec 05 · rule 3), written before the code.
 * Rounded once over every segment; the first-hour minimum tops a short
 * session up at its first segment's rate; and elapsed time is real minutes
 * across both daylight-saving nights, never clock times subtracted.
 */
describe("roomTime · the seed's room_time group", () => {
  const group = moneyCases.cases.filter((c) => c.group === "room_time");
  it("has the 9 cases the ticket names", () => {
    expect(group).toHaveLength(9);
  });
  for (const c of group) {
    it(c.id, () => {
      if (c.inputs.segments) {
        const out = roomTime(
          c.inputs.segments.map((s) => ({
            minutes: s.minutes,
            hourlyCents: cents(s.hourly_cents),
          })),
          { firstHourMinimum: c.inputs.first_hour_minimum ?? false },
        );
        expect(out.cents).toBe(c.expected.room_time_cents);
        if (c.must_not_equal?.room_time_cents !== undefined)
          expect(out.cents).not.toBe(c.must_not_equal.room_time_cents);
      } else {
        const out = roomTimeBetween(
          Temporal.Instant.from(c.inputs.start!),
          Temporal.Instant.from(c.inputs.end!),
          cents(c.inputs.hourly_cents!),
        );
        expect(out.minutes).toBe(c.expected.elapsed_minutes);
        expect(out.cents).toBe(c.expected.room_time_cents);
      }
    });
  }
});

describe("roomTime", () => {
  it("Room 9: one 161-minute segment at $120.00 an hour bills $322.00; Room 5: 41 minutes at $40.00 bills $40.00", () => {
    expect(
      roomTime([{ minutes: 161, hourlyCents: cents(12000) }], { firstHourMinimum: true }).cents,
    ).toBe(32200);
    expect(
      roomTime([{ minutes: 41, hourlyCents: cents(4000) }], { firstHourMinimum: true }).cents,
    ).toBe(4000);
  });

  it("a paused segment bills nothing and doesn't count toward the hour", () => {
    const out = roomTime(
      [
        { minutes: 30, hourlyCents: cents(4000) },
        { minutes: 15, hourlyCents: cents(4000), paused: true },
        { minutes: 20, hourlyCents: cents(4000) },
      ],
      { firstHourMinimum: true },
    );
    // 50 billed minutes, topped up to 60 at $40.00: one hour.
    expect(out).toEqual({ cents: 4000, billedMinutes: 60, elapsedMinutes: 50 });
  });

  it("without the first-hour minimum a short session bills its minutes", () => {
    expect(
      roomTime([{ minutes: 30, hourlyCents: cents(4000) }], { firstHourMinimum: false }).cents,
    ).toBe(2000);
    expect(roomTime([], { firstHourMinimum: true }).cents).toBe(0);
  });

  it("refuses a segment that isn't whole minutes or has a negative length", () => {
    expect(() =>
      roomTime([{ minutes: 1.5, hourlyCents: cents(4000) }], { firstHourMinimum: true }),
    ).toThrow(/whole minutes/);
    expect(() =>
      roomTime([{ minutes: -1, hourlyCents: cents(4000) }], { firstHourMinimum: true }),
    ).toThrow(/whole minutes/);
  });

  it("roomTimeBetween takes a part minute down to the whole minute (flagged in M2-01)", () => {
    const start = Temporal.Instant.from("2026-09-25T20:00:00-04:00");
    expect(roomTimeBetween(start, start.add({ seconds: 90 }), cents(6000)).minutes).toBe(1);
    expect(() => roomTimeBetween(start, start.subtract({ minutes: 1 }), cents(6000))).toThrow(
      /before it started/,
    );
  });
});
