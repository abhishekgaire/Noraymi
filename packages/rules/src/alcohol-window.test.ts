import { describe, expect, it } from "vitest";
import { Temporal, newYorkCounty } from "@west4/shared";
import { alcoholWindow, clearOutDue, type AlcoholVenue } from "./alcohol-window.js";

const west4: AlcoholVenue = {
  timeZone: "America/New_York",
  dayCutover: "06:00",
  alcohol: newYorkCounty.alcohol,
  lastCall: "04:00",
};
const at = (iso: string) => Temporal.Instant.from(iso.replace(/\[.*\]$/, ""));
const ny = (i: Temporal.Instant) => i.toZonedDateTimeISO("America/New_York").toString();

describe("alcoholWindow", () => {
  it("on Fri Sep 25, 2026 is open at 3:59:59 AM Saturday and closed at 4:00:00 AM", () => {
    const before = alcoholWindow(west4, at("2026-09-26T03:59:59-04:00[America/New_York]"));
    expect(before.state).toBe("open");
    expect(ny(before.changesAt)).toBe("2026-09-26T04:00:00-04:00[America/New_York]");
    const after = alcoholWindow(west4, at("2026-09-26T04:00:00-04:00[America/New_York]"));
    expect(after.state).toBe("closed");
    expect(ny(after.changesAt)).toBe("2026-09-26T08:00:00-04:00[America/New_York]");
  });

  it("is open at the demo's 10:41 PM", () => {
    const w = alcoholWindow(west4, at("2026-09-25T22:41:00-04:00[America/New_York]"));
    expect(w.state).toBe("open");
    expect(ny(w.closesAt)).toBe("2026-09-26T04:00:00-04:00[America/New_York]");
  });

  it("closes at 4:00 AM EST on Nov 1 on the fall-back night", () => {
    const open = alcoholWindow(west4, at("2026-11-01T03:59:59-05:00[America/New_York]"));
    expect(open.state).toBe("open");
    expect(ny(open.changesAt)).toBe("2026-11-01T04:00:00-05:00[America/New_York]");
    expect(alcoholWindow(west4, at("2026-11-01T04:00:00-05:00[America/New_York]")).state).toBe(
      "closed",
    );
    // Still open in the repeated hour, both times round.
    expect(alcoholWindow(west4, at("2026-11-01T01:30:00-04:00[America/New_York]")).state).toBe(
      "open",
    );
    expect(alcoholWindow(west4, at("2026-11-01T01:30:00-05:00[America/New_York]")).state).toBe(
      "open",
    );
  });

  it("closes at 4:00 AM EDT on Mar 14, 2027 on the spring-forward night, not 5:00 AM", () => {
    const open = alcoholWindow(west4, at("2027-03-14T03:59:59-04:00[America/New_York]"));
    expect(open.state).toBe("open");
    expect(ny(open.changesAt)).toBe("2027-03-14T04:00:00-04:00[America/New_York]");
    expect(alcoholWindow(west4, at("2027-03-14T04:00:00-04:00[America/New_York]")).state).toBe(
      "closed",
    );
    expect(alcoholWindow(west4, at("2027-03-14T04:30:00-04:00[America/New_York]")).state).toBe(
      "closed",
    );
  });

  it("closes at a house last call of 3:00 AM", () => {
    const early = { ...west4, lastCall: "03:00" };
    expect(alcoholWindow(early, at("2026-09-26T02:59:59-04:00[America/New_York]")).state).toBe(
      "open",
    );
    const closed = alcoholWindow(early, at("2026-09-26T03:00:00-04:00[America/New_York]"));
    expect(closed.state).toBe("closed");
    expect(ny(closed.closesAt)).toBe("2026-09-26T03:00:00-04:00[America/New_York]");
  });

  it("uses the pack's last sale when there's no house last call, or a later one", () => {
    const none = alcoholWindow({ ...west4, lastCall: null }, at("2026-09-26T03:00:00-04:00"));
    expect(ny(none.closesAt)).toBe("2026-09-26T04:00:00-04:00[America/New_York]");
    const late = alcoholWindow({ ...west4, lastCall: "05:00" }, at("2026-09-26T04:30:00-04:00"));
    expect(late.state).toBe("closed");
  });

  it("stays closed from 4:00 to 8:00 AM, across the 6:00 AM cutover, and opens at 8:00", () => {
    for (const t of ["04:00:00", "05:00:00", "05:59:59", "06:00:00", "07:00:00", "07:59:59"]) {
      const w = alcoholWindow(west4, at(`2026-09-26T${t}-04:00[America/New_York]`));
      expect(w.state, t).toBe("closed");
      expect(ny(w.changesAt), t).toBe("2026-09-26T08:00:00-04:00[America/New_York]");
    }
    const open = alcoholWindow(west4, at("2026-09-26T08:00:00-04:00[America/New_York]"));
    expect(open.state).toBe("open");
    expect(ny(open.changesAt)).toBe("2026-09-27T04:00:00-04:00[America/New_York]");
  });
});

describe("clearOutDue", () => {
  it("is 4:30 AM on business date Fri Sep 25, 2026", () => {
    expect(ny(clearOutDue(west4, "2026-09-25"))).toBe(
      "2026-09-26T04:30:00-04:00[America/New_York]",
    );
  });

  it("counts from the window's close: 3:30 AM with a 3:00 AM house last call", () => {
    expect(ny(clearOutDue({ ...west4, lastCall: "03:00" }, "2026-09-25"))).toBe(
      "2026-09-26T03:30:00-04:00[America/New_York]",
    );
  });

  it("is 4:30 AM on both daylight-saving nights", () => {
    expect(ny(clearOutDue(west4, "2026-10-31"))).toBe(
      "2026-11-01T04:30:00-05:00[America/New_York]",
    );
    expect(ny(clearOutDue(west4, "2027-03-13"))).toBe(
      "2027-03-14T04:30:00-04:00[America/New_York]",
    );
  });
});
