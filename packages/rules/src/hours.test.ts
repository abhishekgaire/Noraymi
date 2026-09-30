import { describe, expect, it } from "vitest";
import { Temporal, type Hours } from "@west4/shared";
import { hoursFor, openNow } from "./hours.js";
import { businessDate } from "./time.js";

const west4 = { timeZone: "America/New_York", dayCutover: "06:00" };
const hours: Hours = {
  weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    opens: day === 0 || day === 6 ? "14:00" : "16:00",
    closes: "04:00",
  })),
  lastCall: "04:00",
};
const ny = (i: Temporal.Instant | null) => i?.toZonedDateTimeISO("America/New_York").toString();

describe("hoursFor", () => {
  it("Fri Sep 25, 2026 opens at 4:00 PM and closes Sat at 4:00 AM EDT", () => {
    const h = hoursFor(west4, Temporal.PlainDate.from("2026-09-25"), hours);
    expect(h.closed).toBe(false);
    expect(ny(h.opens)).toBe("2026-09-25T16:00:00-04:00[America/New_York]");
    expect(ny(h.closes)).toBe("2026-09-26T04:00:00-04:00[America/New_York]");
    expect(ny(h.lastCall)).toBe("2026-09-26T04:00:00-04:00[America/New_York]");
    expect(h.source).toBe("weekly");
  });

  it("Sat Oct 31 closes at 4:00 AM EST on Nov 1, and Sat Mar 13, 2027 at 4:00 AM EDT on Mar 14", () => {
    const fallBack = hoursFor(west4, Temporal.PlainDate.from("2026-10-31"), hours);
    expect(ny(fallBack.opens)).toBe("2026-10-31T14:00:00-04:00[America/New_York]");
    expect(ny(fallBack.closes)).toBe("2026-11-01T04:00:00-05:00[America/New_York]");
    // 15 hours of real time, not 14: the repeated 1 AM hour is inside the night.
    expect(fallBack.closes!.since(fallBack.opens!).total({ unit: "hours" })).toBe(15);
    const springForward = hoursFor(west4, Temporal.PlainDate.from("2027-03-13"), hours);
    expect(ny(springForward.closes)).toBe("2027-03-14T04:00:00-04:00[America/New_York]");
    expect(springForward.closes!.since(springForward.opens!).total({ unit: "hours" })).toBe(13);
  });

  it("a closure for Thu Dec 24 closing at 11:00 PM moves that night's close to 11:00 PM, and its last call to no later than 11:00 PM", () => {
    const h = hoursFor(west4, Temporal.PlainDate.from("2026-12-24"), hours, {
      date: "2026-12-24",
      kind: "special",
      closes: "23:00",
    });
    expect(h.source).toBe("special");
    expect(ny(h.opens)).toBe("2026-12-24T16:00:00-05:00[America/New_York]");
    expect(ny(h.closes)).toBe("2026-12-24T23:00:00-05:00[America/New_York]");
    expect(ny(h.lastCall)).toBe("2026-12-24T23:00:00-05:00[America/New_York]");
    const closed = hoursFor(west4, Temporal.PlainDate.from("2026-12-25"), hours, {
      date: "2026-12-25",
      kind: "closed",
    });
    expect(closed).toMatchObject({
      closed: true,
      opens: null,
      closes: null,
      lastCall: null,
      source: "closed",
    });
    // A closure for another date changes nothing.
    expect(
      hoursFor(west4, Temporal.PlainDate.from("2026-12-23"), hours, {
        date: "2026-12-24",
        kind: "closed",
      }).closed,
    ).toBe(false);
  });

  it("'Open now' is true at 10:41 PM on the seed and false at 4:30 AM, on the venue's clock", () => {
    const seedNow = Temporal.Instant.from("2026-09-26T02:41:00Z");
    const later = Temporal.Instant.from("2026-09-26T08:30:00Z");
    const date = (i: Temporal.Instant) =>
      businessDate(i, west4.timeZone, west4.dayCutover).businessDate;
    expect(openNow(hoursFor(west4, date(seedNow), hours), seedNow)).toBe(true);
    expect(openNow(hoursFor(west4, date(later), hours), later)).toBe(false);
    // Before opening on the same business date.
    expect(
      openNow(
        hoursFor(west4, Temporal.PlainDate.from("2026-09-25"), hours),
        Temporal.Instant.from("2026-09-25T18:00:00Z"),
      ),
    ).toBe(false);
  });

  it("a day with no weekly hours is closed", () => {
    const h = hoursFor(west4, Temporal.PlainDate.from("2026-09-25"), {
      weekly: [],
      lastCall: null,
    });
    expect(h).toMatchObject({ closed: true, source: "none" });
  });
});
