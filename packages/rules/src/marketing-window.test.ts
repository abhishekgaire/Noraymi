import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { marketingWindow, recipientZones } from "./marketing-window.js";

const NY = "America/New_York";
const at = (local: string, zone: string) =>
  Temporal.ZonedDateTime.from(`${local}[${zone}]`).toInstant();

describe("the marketing sending window (spec 11 · Consent and timing)", () => {
  it("places area codes, with every zone a split code spans", () => {
    expect(recipientZones("+12125550101")).toEqual([NY]);
    expect(recipientZones("+13105550101")).toEqual(["America/Los_Angeles"]);
    expect(recipientZones("+18505550101")).toEqual([NY, "America/Chicago"]);
    expect(recipientZones("+16025550101")).toEqual(["America/Phoenix"]);
    expect(recipientZones("+19995550101")).toBeNull();
    expect(recipientZones("+442071234567")).toBeNull();
  });

  it("refuses 9:05 PM in the recipient's zone and allows 8:59 PM", () => {
    expect(marketingWindow(at("2026-09-25T21:05", NY), "+12125550101", NY)).toEqual({
      ok: false,
      reason: "outside_hours",
      zone: NY,
    });
    expect(marketingWindow(at("2026-09-25T20:59", NY), "+12125550101", NY)).toEqual({ ok: true });
  });

  it("refuses before 8 AM and allows 8:00 AM sharp", () => {
    expect(marketingWindow(at("2026-09-25T07:59", NY), "+12125550101", NY).ok).toBe(false);
    expect(marketingWindow(at("2026-09-25T08:00", NY), "+12125550101", NY).ok).toBe(true);
  });

  it("uses the recipient's zone: 9:05 PM in Los Angeles is refused from a Chicago venue", () => {
    const la = "America/Los_Angeles";
    // 9:05 PM in LA is 11:05 PM in Chicago: refused by both.
    const r = marketingWindow(at("2026-09-25T21:05", la), "+13105550101", "America/Chicago");
    expect(r.ok).toBe(false);
    // 7:30 AM in LA is 9:30 AM in Chicago: the recipient's zone refuses it.
    expect(marketingWindow(at("2026-09-25T07:30", la), "+13105550101", "America/Chicago")).toEqual({
      ok: false,
      reason: "outside_hours",
      zone: la,
    });
  });

  it("checks against the venue's zone too: 6:30 PM in LA is 9:30 PM at a New York venue", () => {
    const la = "America/Los_Angeles";
    expect(marketingWindow(at("2026-09-25T18:30", la), "+13105550101", NY)).toEqual({
      ok: false,
      reason: "outside_hours",
      zone: NY,
    });
  });

  it("a split area code must fit every zone it spans", () => {
    // 8:30 AM Eastern is 7:30 AM Central: the panhandle's Central half refuses it.
    expect(marketingWindow(at("2026-09-25T08:30", NY), "+18505550101", NY)).toEqual({
      ok: false,
      reason: "outside_hours",
      zone: "America/Chicago",
    });
  });

  it("refuses a number it can't place", () => {
    expect(marketingWindow(at("2026-09-25T12:00", NY), "+19995550101", NY)).toEqual({
      ok: false,
      reason: "unknown_area",
    });
  });

  it("follows daylight saving: Arizona keeps 9 PM on the wall clock all year", () => {
    const phx = "America/Phoenix";
    // In January, 9:05 PM in Phoenix is 11:05 PM in New York.
    expect(marketingWindow(at("2026-01-15T20:30", phx), "+16025550101", "America/Denver").ok).toBe(
      true,
    );
    // In July, Denver is an hour ahead of Phoenix: 8:30 PM Phoenix is 9:30 PM Denver.
    expect(marketingWindow(at("2026-07-15T20:30", phx), "+16025550101", "America/Denver")).toEqual({
      ok: false,
      reason: "outside_hours",
      zone: "America/Denver",
    });
  });
});
