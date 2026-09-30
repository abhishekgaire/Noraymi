import { describe, expect, it } from "vitest";
import { Temporal, FrozenClock, SEED_NOW } from "@west4/shared";
import { plannedRuns, runInstant, type Schedule, type VenueClock, Scheduler } from "./scheduler.js";

const west4: VenueClock = { id: "v1", timeZone: "America/New_York", dayCutover: "06:00" };
const at0130: Schedule = { kind: "nightly.0130", at: "01:30", pool: "normal" };
const at0230: Schedule = { kind: "nightly.0230", at: "02:30", pool: "normal" };

describe("runInstant on the daylight-saving nights", () => {
  it("a daily 1:30 AM job runs once on Nov 1, 2026, at the first 1:30 (EDT)", () => {
    const run = runInstant(at0130, west4, Temporal.PlainDate.from("2026-10-31"));
    expect(run.toZonedDateTimeISO("America/New_York").toString()).toBe(
      "2026-11-01T01:30:00-04:00[America/New_York]",
    );
  });

  it("a daily 2:30 AM job runs once on Mar 14, 2027, at 3:30 AM EDT", () => {
    const run = runInstant(at0230, west4, Temporal.PlainDate.from("2027-03-13"));
    expect(run.toZonedDateTimeISO("America/New_York").toString()).toBe(
      "2027-03-14T03:30:00-04:00[America/New_York]",
    );
  });
});

describe("plannedRuns", () => {
  it("plans today's and tomorrow's business dates, keyed kind:venue:date, so each runs exactly once", () => {
    const runs = plannedRuns([at0130], west4, Temporal.Instant.from("2026-09-26T02:41:00Z"));
    expect(runs.map((r) => r.key)).toEqual([
      "nightly.0130:v1:2026-09-25",
      "nightly.0130:v1:2026-09-26",
    ]);
    expect(runs.map((r) => r.runAt.toString())).toEqual([
      "2026-09-26T05:30:00Z",
      "2026-09-27T05:30:00Z",
    ]);
  });

  it("at 1:31 AM on the fall-back night the same key is planned, never a second 1:30", () => {
    for (const now of ["2026-11-01T05:31:00Z", "2026-11-01T06:31:00Z"]) {
      const runs = plannedRuns([at0130], west4, Temporal.Instant.from(now));
      expect(runs[0]?.key).toBe("nightly.0130:v1:2026-10-31");
      expect(runs[0]?.runAt.toString()).toBe("2026-11-01T05:30:00Z");
    }
  });
});

describe("sweeps (M1-16)", () => {
  it("runs each sweep once per interval, and one sweep's error is logged, not thrown", async () => {
    const lines: string[] = [];
    const ran: string[] = [];
    const scheduler = new Scheduler({} as never, {
      schedules: [],
      clock: new FrozenClock(SEED_NOW),
      log: (l) => lines.push(l),
      sweeps: [
        { name: "devices.watch", everyMs: 60_000, run: async () => void ran.push("devices") },
        {
          name: "broken",
          everyMs: 60_000,
          run: async () => {
            throw new Error("no such table");
          },
        },
      ],
    });
    expect(await scheduler.runSweeps()).toEqual(["devices.watch"]);
    expect(lines).toEqual(["sweep broken: no such table"]);
    expect(await scheduler.runSweeps()).toEqual([]);
    expect(ran).toEqual(["devices"]);
  });
});
