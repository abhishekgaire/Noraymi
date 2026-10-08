import { businessDate, hoursFor, openNow, type Closure, type VenueTime } from "@west4/rules";
import { Temporal, type Hours } from "@west4/shared";

/**
 * When the synthetic check runs (M8-18; spec 13 · Watching production): every 5 minutes during
 * New York opening hours. The spec doesn't say whose hours for a check that serves every venue;
 * the cautious default is the union of every live venue's hours (our own test venue's hours don't
 * count), which with West 4 alone is West 4's own: 4:00 PM to 4:00 AM on weekdays, 2:00 PM to
 * 4:00 AM on Saturdays and Sundays. The run's slot is the 5-minute mark it belongs to, so a slot
 * runs once however often the scheduler looks and through either daylight-saving night: the marks
 * are real 5-minute steps of UTC time, and the hours come from each venue's own wall clock.
 */
export const SYNTHETIC_EVERY_MIN = 5;

export interface LiveVenueHours {
  readonly time: VenueTime;
  readonly hours: Hours | null;
  /** The closure on the business date at `now`, if any. */
  readonly closure?: Closure | null;
}

/** The 5-minute mark `now` belongs to (UTC; New York's offsets are whole hours). */
export function slotOf(now: Temporal.Instant): Temporal.Instant {
  const step = SYNTHETIC_EVERY_MIN * 60_000;
  return Temporal.Instant.fromEpochMilliseconds(Math.floor(now.epochMilliseconds / step) * step);
}

/** Whether any live venue is inside its opening hours at `at`. */
export function anyLiveVenueOpen(venues: readonly LiveVenueHours[], at: Temporal.Instant): boolean {
  return venues.some((v) => {
    if (!v.hours) return false;
    const date = businessDate(at, v.time.timeZone, v.time.dayCutover).businessDate;
    return openNow(hoursFor(v.time, date, v.hours, v.closure ?? null), at);
  });
}

/** The slot to run at `now`, or null outside every live venue's hours. */
export function syntheticSlot(
  venues: readonly LiveVenueHours[],
  now: Temporal.Instant,
): Temporal.Instant | null {
  const slot = slotOf(now);
  return anyLiveVenueOpen(venues, slot) ? slot : null;
}
