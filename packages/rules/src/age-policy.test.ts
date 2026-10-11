import { describe, expect, it } from "vitest";
import { ageSwitchAt, bookingAgeSwitch, twentyOneAt } from "./age-policy.js";

// The venue age policy (D108): Sing Sing is all ages until 8 PM, 21 and over after (its website);
// West 4 is 21 and over all night. New York, 6:00 AM cutover.
const NY = "America/New_York";
const CUT = "06:00";

describe("the venue age policy", () => {
  it("switches at 8:00 PM on the business date's wall clock", () => {
    expect(ageSwitchAt("2026-09-25", "20:00", NY, CUT)?.toString()).toBe("2026-09-26T00:00:00Z");
  });
  it("a small-hours time is the next calendar day of the same night", () => {
    expect(ageSwitchAt("2026-09-25", "01:00", NY, CUT)?.toString()).toBe("2026-09-26T05:00:00Z");
  });
  it("no switch for 21 and over all night, or a time equal to the cutover", () => {
    expect(ageSwitchAt("2026-09-25", null, NY, CUT)).toBeNull();
    expect(ageSwitchAt("2026-09-25", undefined, NY, CUT)).toBeNull();
    expect(ageSwitchAt("2026-09-25", "06:00", NY, CUT)).toBeNull();
  });
  it("21 and over from the switch on, and all night without one", () => {
    expect(twentyOneAt("2026-09-25T23:59:00Z", "20:00", NY, CUT)).toBe(false); // 7:59 PM
    expect(twentyOneAt("2026-09-26T00:00:00Z", "20:00", NY, CUT)).toBe(true); // 8:00 PM
    expect(twentyOneAt("2026-09-26T06:30:00Z", "20:00", NY, CUT)).toBe(true); // 2:30 AM
    expect(twentyOneAt("2026-09-25T18:00:00Z", null, NY, CUT)).toBe(true); // 2:00 PM, West 4
  });
  it("a booking that runs past 8:00 PM gets the note; one over by then, or at West 4, doesn't", () => {
    // 6:00 PM to 9:00 PM.
    expect(
      bookingAgeSwitch(
        "2026-09-25T22:00:00Z",
        "2026-09-26T01:00:00Z",
        "20:00",
        NY,
        CUT,
      )?.toString(),
    ).toBe("2026-09-26T00:00:00Z");
    // 9:00 PM to 11:00 PM: all of it after the switch.
    expect(
      bookingAgeSwitch(
        "2026-09-26T01:00:00Z",
        "2026-09-26T03:00:00Z",
        "20:00",
        NY,
        CUT,
      )?.toString(),
    ).toBe("2026-09-26T00:00:00Z");
    // 5:00 PM to 8:00 PM: over at the switch.
    expect(
      bookingAgeSwitch("2026-09-25T21:00:00Z", "2026-09-26T00:00:00Z", "20:00", NY, CUT),
    ).toBeNull();
    expect(
      bookingAgeSwitch("2026-09-25T22:00:00Z", "2026-09-26T01:00:00Z", null, NY, CUT),
    ).toBeNull();
  });
  it("counts real minutes through the fall-back night", () => {
    // Nov 1, 2026: 8:00 PM EST is 01:00Z the next day.
    expect(ageSwitchAt("2026-11-01", "20:00", NY, CUT)?.toString()).toBe("2026-11-02T01:00:00Z");
  });
});
