import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { cutoffWords, refundCutoffAt } from "./booking-cutoff.js";

const NY = "America/New_York";
const at = (s: string) => Temporal.Instant.from(s);

describe("the refund cut-off (M5-10)", () => {
  it("Jae, booked Wed Sep 23 for Fri 11:00 PM with 24 hours: Thu 11:00 PM", () => {
    const start = at("2026-09-26T03:00:00Z");
    const cutoff = refundCutoffAt(start, 24);
    expect(cutoff.toString()).toBe("2026-09-25T03:00:00Z");
    expect(cutoffWords(cutoff, start, at("2026-09-23T20:00:00Z"), NY)).toBe("Thu 11:00 PM");
  });

  it("across the Nov 1, 2026 change it counts elapsed hours and names the zone", () => {
    // Sun Nov 1, 9:00 PM EST; 24 elapsed hours earlier is Sat Oct 31, 10:00 PM EDT.
    const start = at("2026-11-02T02:00:00Z");
    const cutoff = refundCutoffAt(start, 24);
    expect(cutoffWords(cutoff, start, at("2026-10-29T16:00:00Z"), NY)).toBe("Sat 10:00 PM EDT");
  });

  it("a cut-off more than six days out carries its date", () => {
    const start = at("2026-10-09T03:00:00Z");
    expect(cutoffWords(refundCutoffAt(start, 24), start, at("2026-09-23T20:00:00Z"), NY)).toBe(
      "Wed, Oct 7 11:00 PM",
    );
  });
});
