import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Temporal, cents } from "@west4/shared";
import { prepaidBlockBetween, prepaidBlockCents, roomTime } from "./room-time.js";
import { sessionClock } from "./session-clock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
interface Case {
  id: string;
  group: string;
  function: string;
  inputs: {
    segments?: { minutes: number; hourly_cents: number; paused?: boolean }[];
    first_hour_minimum?: boolean;
    block?: { minutes: number; cents: number };
    step?: { increment_min: 1 | 15 | 30 | 60; rounding: "up" | "nearest" | "down" };
    start?: string;
    end?: string;
    hourly_cents?: number;
    block_minutes?: number;
  };
  expected: {
    room_time_cents?: number;
    billed_minutes?: number;
    elapsed_minutes?: number;
    block_cents?: number;
  };
  must_not_equal?: { room_time_cents?: number };
}
const cases = (
  JSON.parse(readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8")) as {
    cases: Case[];
  }
).cases.filter((c) => c.group === "prepaid_block");

/**
 * P-04: the `prepaid_block` group (spec 05 · rule 3, Prepaid block), written before the code. A
 * prepaid block bills at least its price (its minutes at the room's rate, or a package's room-time
 * share) even when the party leaves early; minutes past it bill as pay as you go, rounded once;
 * and the minutes are real ones through both daylight-saving nights.
 */
describe("prepaid block · the seed's prepaid_block group", () => {
  it("has the 14 cases", () => {
    expect(cases).toHaveLength(14);
  });
  for (const c of cases) {
    it(c.id, () => {
      const i = c.inputs;
      if (c.function === "prepaid_block_cents") {
        expect(prepaidBlockCents(i.block_minutes!, cents(i.hourly_cents!))).toBe(
          c.expected.block_cents,
        );
        return;
      }
      if (c.function === "prepaid_block_between") {
        const start = Temporal.Instant.from(i.start!);
        const end = Temporal.Instant.from(i.end!);
        const hourly = cents(i.hourly_cents!);
        const block = {
          minutes: i.block_minutes!,
          cents: prepaidBlockCents(i.block_minutes!, hourly),
        };
        const out = prepaidBlockBetween(start, end, hourly, block);
        expect(out.minutes).toBe(c.expected.elapsed_minutes);
        expect(out.cents).toBe(c.expected.room_time_cents);
        // The live clock agrees: one segment from start, read at the end.
        const clock = sessionClock({
          segments: [{ startedAt: start, endedAt: null, hourlyCents: hourly, paused: false }],
          now: end,
          bookedEnd: null,
          nextNeedsRoomAt: null,
          close: null,
          stayOnWhenFree: false,
          noticeMin: 10,
          firstHourMinimum: true,
          prepaid: block,
        });
        expect(clock.roomTimeCents).toBe(c.expected.room_time_cents);
        if (c.must_not_equal?.room_time_cents !== undefined)
          expect(out.cents).not.toBe(c.must_not_equal.room_time_cents);
        return;
      }
      const out = roomTime(
        i.segments!.map((s) => ({
          minutes: s.minutes,
          hourlyCents: cents(s.hourly_cents),
          paused: s.paused ?? false,
        })),
        {
          firstHourMinimum: i.first_hour_minimum ?? false,
          step: i.step
            ? { incrementMin: i.step.increment_min, rounding: i.step.rounding }
            : undefined,
          prepaid: { minutes: i.block!.minutes, cents: cents(i.block!.cents) },
        },
      );
      expect(out.cents).toBe(c.expected.room_time_cents);
      expect(out.billedMinutes).toBe(c.expected.billed_minutes);
      expect(out.elapsedMinutes).toBe(c.expected.elapsed_minutes);
      if (c.must_not_equal?.room_time_cents !== undefined)
        expect(out.cents).not.toBe(c.must_not_equal.room_time_cents);
    });
  }

  it("with no block, billing is unchanged (pay as you go)", () => {
    const segs = [{ minutes: 75, hourlyCents: cents(4000) }];
    expect(roomTime(segs, { firstHourMinimum: true }).cents).toBe(5000);
    expect(roomTime(segs, { firstHourMinimum: true, prepaid: null }).cents).toBe(5000);
  });

  it("refuses a block that isn't whole minutes or integer cents", () => {
    const segs = [{ minutes: 10, hourlyCents: cents(4000) }];
    expect(() =>
      roomTime(segs, { firstHourMinimum: true, prepaid: { minutes: 1.5, cents: cents(100) } }),
    ).toThrow();
    expect(() =>
      roomTime(segs, { firstHourMinimum: true, prepaid: { minutes: 60, cents: -1 as never } }),
    ).toThrow();
  });
});
