import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { nextBusinessDate } from "./time.js";

const at = (iso: string) =>
  nextBusinessDate(Temporal.Instant.from(iso), "America/New_York", "06:00").toString();

/** A bar POS layout published now starts at the next business date (M6-01). */
describe("nextBusinessDate", () => {
  it("Fri Sep 25 at 10:41 PM: Sat Sep 26", () =>
    expect(at("2026-09-25T22:41:00-04:00")).toBe("2026-09-26"));
  it("Sat 3:00 AM is still Friday's night: Sat Sep 26", () =>
    expect(at("2026-09-26T03:00:00-04:00")).toBe("2026-09-26"));
  it("from the 6:00 AM cutover: Sun Sep 27", () =>
    expect(at("2026-09-26T06:00:00-04:00")).toBe("2026-09-27"));
  it("the fall-back night, 1:30 AM EST on Nov 1: still Oct 31's night, so Nov 1", () =>
    expect(at("2026-11-01T01:30:00-05:00")).toBe("2026-11-01"));
  it("the spring-forward night, 3:30 AM EDT on Mar 14, 2027: Mar 14", () =>
    expect(at("2027-03-14T03:30:00-04:00")).toBe("2027-03-14"));
});
