import { Temporal } from "@west4/shared";

/**
 * When a bar tab's hold runs out, and what happens before it does (M6-17; Payment flows · Bar tab with a
 * growing hold, step 6). Stripe reports `capture_before` once the hold is placed: an in-person hold lasts
 * at least two days, and 5 days for Visa. Until Stripe has said, the hold is taken to run out two days
 * after it was placed, the shortest it can be (the cautious reading).
 *  - 12 hours before then, a tab still `awaiting_tip` is captured by the sweeper at a tip of 0;
 *  - and any hold still standing raises an alert to the manager on duty.
 * Real hours, never wall-clock ones, so a daylight-saving night counts its 25 or 23 hours.
 */
export const HOLD_MIN_DAYS = 2;
export const HOLD_WATCH_HOURS = 12;

export function holdExpiresAt(input: {
  readonly captureBefore: Temporal.Instant | null;
  readonly placedAt: Temporal.Instant;
}): Temporal.Instant {
  return input.captureBefore ?? input.placedAt.add({ hours: HOLD_MIN_DAYS * 24 });
}

/** The instant the sweeper and the alert act on: 12 real hours before the hold runs out. */
export const holdWatchAt = (expiresAt: Temporal.Instant): Temporal.Instant =>
  expiresAt.subtract({ hours: HOLD_WATCH_HOURS });

/** Whether a hold is within 12 hours of running out at `now`. */
export const holdRunningOut = (now: Temporal.Instant, expiresAt: Temporal.Instant): boolean =>
  Temporal.Instant.compare(now, holdWatchAt(expiresAt)) >= 0;
