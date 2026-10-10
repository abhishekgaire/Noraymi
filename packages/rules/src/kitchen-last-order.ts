import { Temporal } from "@west4/shared";
import { businessDate, parseCutover, wallClock } from "./time.js";

/**
 * Whether the kitchen's last order time has passed tonight (K-07; spec 16 · Ordering food and
 * 86 and closing the kitchen). `lastOrder` is "HH:MM" on the wall clock, read in the business
 * date `now` belongs to: "01:30" is the small hours after midnight, "22:00" the evening before.
 * Empty (null) means no limit: food can be ordered whenever room ordering is open, the cautious
 * default while the open question stands. A time equal to the cutover is the night's end, so it
 * never stops food early.
 */
export function pastLastOrder(
  now: Temporal.Instant | string,
  lastOrder: string | null | undefined,
  timeZone: string,
  cutover: string,
): boolean {
  if (!lastOrder) return false;
  if (Temporal.PlainTime.compare(parseCutover(lastOrder), parseCutover(cutover)) === 0)
    return false;
  const at = typeof now === "string" ? Temporal.Instant.from(now) : now;
  const date = businessDate(at, timeZone, cutover).businessDate;
  return Temporal.Instant.compare(at, wallClock(date, lastOrder, timeZone, cutover)) >= 0;
}
