import { Temporal } from "./temporal.js";

/**
 * One clock for the API, the workers and the scheduler (M1-06). Business
 * times come from here, never from the database's now(). In production it is
 * the real clock; in staging and tests a simulated one that starts at the
 * demo seed's Friday, 10:41 PM, and can be moved.
 */
export interface Clock {
  now(): Temporal.Instant;
}

export const systemClock: Clock = {
  now: () => Temporal.Now.instant(),
};

/** The demo seed's "now": Fri Sep 25, 2026, 10:41:00 PM in New York. */
export const SEED_NOW = Temporal.Instant.from("2026-09-26T02:41:00Z");

/**
 * A clock that runs at real speed from a point that can be moved. It keeps
 * ticking after set(), so a screen's seconds count up from 10:41 PM.
 */
export class SimulatedClock implements Clock {
  private simulatedAt: Temporal.Instant;
  private realAt: Temporal.Instant;

  constructor(
    start: Temporal.Instant = SEED_NOW,
    private readonly real: Clock = systemClock,
  ) {
    this.simulatedAt = start;
    this.realAt = real.now();
  }

  now(): Temporal.Instant {
    const elapsed = this.real.now().since(this.realAt);
    return this.simulatedAt.add(elapsed);
  }

  /** Move the clock to an instant; it keeps ticking from there. */
  set(at: Temporal.Instant): void {
    this.simulatedAt = at;
    this.realAt = this.real.now();
  }

  advance(by: Temporal.Duration): void {
    this.set(this.now().add(by));
  }
}

/** A clock that only moves when told: for tests that need exact instants. */
export class FrozenClock implements Clock {
  constructor(private at: Temporal.Instant = SEED_NOW) {}
  now(): Temporal.Instant {
    return this.at;
  }
  set(at: Temporal.Instant): void {
    this.at = at;
  }
  advance(by: Temporal.Duration): void {
    this.at = this.at.add(by);
  }
}

/** ISO 8601 with the offset of a zone: 2026-09-25T22:41:00-04:00. */
export function formatInZone(instant: Temporal.Instant, timeZone: string): string {
  return instant
    .toZonedDateTimeISO(timeZone)
    .toString({ timeZoneName: "never", fractionalSecondDigits: 0 });
}
