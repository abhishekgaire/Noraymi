import { describe, expect, it } from "vitest";
import { formatCheckTime } from "./clock.js";

describe("times on checks", () => {
  const ny = "America/New_York";
  it("reads EDT and then EST across the fall-back night (Nov 1, 2026)", () => {
    expect(formatCheckTime("2026-11-01T05:30:00Z", ny)).toBe("1:30 AM EDT");
    expect(formatCheckTime("2026-11-01T06:30:00Z", ny)).toBe("1:30 AM EST");
  });
  it("skips from 1:59 AM EST to 3:00 AM EDT on the spring-forward night (Mar 14, 2027)", () => {
    expect(formatCheckTime("2027-03-14T06:59:00Z", ny)).toBe("1:59 AM EST");
    expect(formatCheckTime("2027-03-14T07:00:00Z", ny)).toBe("3:00 AM EDT");
  });
  it("shows Room 9's 10:41 PM as EDT", () => {
    expect(formatCheckTime("2026-09-26T02:41:00Z", ny)).toBe("10:41 PM EDT");
  });
});
