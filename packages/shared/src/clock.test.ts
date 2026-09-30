import { describe, expect, it } from "vitest";
import { FrozenClock, SEED_NOW, SimulatedClock, formatInZone } from "./clock.js";
import { Temporal } from "./temporal.js";

describe("SimulatedClock", () => {
  it("starts at the seed's Friday 10:41 PM and ticks with real time", () => {
    const real = new FrozenClock(Temporal.Instant.from("2030-01-01T00:00:00Z"));
    const clock = new SimulatedClock(SEED_NOW, real);
    expect(formatInZone(clock.now(), "America/New_York")).toBe("2026-09-25T22:41:00-04:00");
    real.advance(Temporal.Duration.from({ seconds: 90 }));
    expect(formatInZone(clock.now(), "America/New_York")).toBe("2026-09-25T22:42:30-04:00");
  });

  it("can be moved to 4:00, 4:12 and 4:30 AM and keeps ticking from there", () => {
    const real = new FrozenClock(Temporal.Instant.from("2030-01-01T00:00:00Z"));
    const clock = new SimulatedClock(SEED_NOW, real);
    clock.set(Temporal.Instant.from("2026-09-26T08:12:00Z"));
    expect(formatInZone(clock.now(), "America/New_York")).toBe("2026-09-26T04:12:00-04:00");
    real.advance(Temporal.Duration.from({ minutes: 18 }));
    expect(formatInZone(clock.now(), "America/New_York")).toBe("2026-09-26T04:30:00-04:00");
  });
});
