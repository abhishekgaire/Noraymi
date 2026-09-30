import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { businessDate, wallClock } from "./time.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const moneyCases = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    inputs: { local_time: string; cutover: string; time_zone: string };
    expected: { business_date: string; minutes_from_midnight: number };
  }[];
};

describe("businessDate · the seed's business_date group", () => {
  const group = moneyCases.cases.filter((c) => c.group === "business_date");

  it("has the 7 cases the ticket names", () => {
    expect(group).toHaveLength(7);
  });

  for (const c of group) {
    it(c.id, () => {
      const out = businessDate(
        Temporal.Instant.from(c.inputs.local_time),
        c.inputs.time_zone,
        c.inputs.cutover,
      );
      expect(out.businessDate.toString()).toBe(c.expected.business_date);
      expect(out.minutesFromMidnight).toBe(c.expected.minutes_from_midnight);
    });
  }
});

describe("businessDate", () => {
  it("takes an ISO instant string too, and the seed's clock is Friday at 10:41 PM", () => {
    const out = businessDate("2026-09-26T02:41:00Z", "America/New_York", "06:00");
    expect(out.businessDate.toString()).toBe("2026-09-25");
    expect(out.minutesFromMidnight).toBe(22 * 60 + 41);
  });

  it("uses the venue's zone, not UTC: 1 AM UTC is the previous evening in New York", () => {
    const out = businessDate("2026-09-26T01:00:00Z", "America/New_York", "06:00");
    expect(out.businessDate.toString()).toBe("2026-09-25");
    expect(out.minutesFromMidnight).toBe(21 * 60);
  });

  it("refuses a malformed cutover", () => {
    expect(() => businessDate("2026-09-26T01:00:00Z", "America/New_York", "6am")).toThrow(/HH:MM/);
  });
});

describe("wallClock", () => {
  it("resolves a time before the cutover on the calendar day after the business date", () => {
    // Acceptance: 04:00 on business date Oct 31, 2026 is Nov 1, 4:00 AM EST (−05:00)
    const fallBack = wallClock("2026-10-31", "04:00", "America/New_York", "06:00");
    expect(fallBack.toZonedDateTimeISO("America/New_York").toString()).toBe(
      "2026-11-01T04:00:00-05:00[America/New_York]",
    );
    // Acceptance: 04:00 on business date Mar 13, 2027 is Mar 14, 4:00 AM EDT (−04:00)
    const springForward = wallClock("2027-03-13", "04:00", "America/New_York", "06:00");
    expect(springForward.toZonedDateTimeISO("America/New_York").toString()).toBe(
      "2027-03-14T04:00:00-04:00[America/New_York]",
    );
  });

  it("resolves a time at or after the cutover on the business date itself", () => {
    const open = wallClock("2026-09-25", "18:00", "America/New_York", "06:00");
    expect(open.toString()).toBe("2026-09-25T22:00:00Z");
    const cutover = wallClock("2026-09-25", "06:00", "America/New_York", "06:00");
    expect(cutover.toString()).toBe("2026-09-25T10:00:00Z");
  });

  it("uses Temporal's compatible rule on the daylight-saving nights", () => {
    // Repeated hour: 1:30 AM on Nov 1, 2026 is its first occurrence (EDT)
    expect(
      wallClock("2026-10-31", "01:30", "America/New_York", "06:00")
        .toZonedDateTimeISO("America/New_York")
        .toString(),
    ).toBe("2026-11-01T01:30:00-04:00[America/New_York]");
    // Skipped hour: 2:30 AM on Mar 14, 2027 doesn't exist and becomes 3:30 AM EDT
    expect(
      wallClock("2027-03-13", "02:30", "America/New_York", "06:00")
        .toZonedDateTimeISO("America/New_York")
        .toString(),
    ).toBe("2027-03-14T03:30:00-04:00[America/New_York]");
  });

  it("round-trips with businessDate for every minute of a business date", () => {
    for (const date of ["2026-09-25", "2026-10-31", "2027-03-13"]) {
      for (let m = 0; m < 24 * 60; m += 7) {
        const hh = String(Math.floor(m / 60)).padStart(2, "0");
        const mm = String(m % 60).padStart(2, "0");
        const instant = wallClock(date, `${hh}:${mm}`, "America/New_York", "06:00");
        const back = businessDate(instant, "America/New_York", "06:00");
        expect(back.businessDate.toString(), `${date} ${hh}:${mm}`).toBe(date);
      }
    }
  });
});
