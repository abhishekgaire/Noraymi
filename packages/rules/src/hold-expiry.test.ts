import { Temporal } from "@west4/shared";
import { describe, expect, it } from "vitest";
import { holdExpiresAt, holdRunningOut, holdWatchAt } from "./hold-expiry.js";

const ny = (s: string) => Temporal.ZonedDateTime.from(`${s}[America/New_York]`).toInstant();

describe("a bar tab's hold running out (M6-17)", () => {
  it("uses Stripe's capture_before when it has one", () => {
    const at = ny("2026-09-30T22:12:00-04:00");
    expect(holdExpiresAt({ captureBefore: at, placedAt: ny("2026-09-25T22:12:00-04:00") })).toEqual(
      at,
    );
  });

  it("takes two days, the shortest an in-person hold lasts, until Stripe has said", () => {
    const placed = ny("2026-09-25T22:12:00-04:00");
    expect(holdExpiresAt({ captureBefore: null, placedAt: placed }).toString()).toBe(
      ny("2026-09-27T22:12:00-04:00").toString(),
    );
  });

  it("acts 12 hours before: not a second sooner (Dev S.'s slip on a normal night)", () => {
    const expires = ny("2026-09-27T22:12:00-04:00");
    expect(holdWatchAt(expires).toString()).toBe(ny("2026-09-27T10:12:00-04:00").toString());
    expect(holdRunningOut(ny("2026-09-27T10:11:59-04:00"), expires)).toBe(false);
    expect(holdRunningOut(ny("2026-09-27T10:12:00-04:00"), expires)).toBe(true);
    // 11 hours from running out: inside the watch.
    expect(holdRunningOut(expires.subtract({ hours: 11 }), expires)).toBe(true);
  });

  it("counts real hours across the fall-back night (Nov 1, 2026: 25 hours)", () => {
    // A hold placed Fri Oct 30 at 11 PM runs out Sun Nov 1 at 10 PM EST (48 real hours).
    const expires = holdExpiresAt({
      captureBefore: null,
      placedAt: ny("2026-10-30T23:00:00-04:00"),
    });
    expect(expires.toString()).toBe(ny("2026-11-01T22:00:00-05:00").toString());
    expect(holdWatchAt(expires).toString()).toBe(ny("2026-11-01T10:00:00-05:00").toString());
    // Across the change itself: 12 real hours before 8 AM EST is 9 PM EDT the night before.
    expect(holdWatchAt(ny("2026-11-01T08:00:00-05:00")).toString()).toBe(
      ny("2026-10-31T21:00:00-04:00").toString(),
    );
  });

  it("counts real hours across the spring-forward night (Mar 14, 2027 is the night before 23 hours)", () => {
    // 12 real hours before 10 AM EDT Sun Mar 14 is 9 PM EST Sat Mar 13.
    expect(holdWatchAt(ny("2027-03-14T10:00:00-04:00")).toString()).toBe(
      ny("2027-03-13T21:00:00-05:00").toString(),
    );
    const expires = holdExpiresAt({
      captureBefore: null,
      placedAt: ny("2027-03-12T23:00:00-05:00"),
    });
    expect(expires.toString()).toBe(ny("2027-03-15T00:00:00-04:00").toString());
  });
});
