import { Temporal } from "@west4/shared";
import { zoneName } from "./booking-grid.js";

/**
 * A booking's refund cut-off (Payment flows · Deposit when booking online,
 * step 4; Money rules 2; M5-08 and M5-10). `refundHours` is a duration, so it
 * is counted in elapsed hours, the way rule 2 counts durations: across a
 * daylight-saving change the wall clock moves by an hour more or less than
 * the hours counted (the cautious default M5-10 names, flagged for the
 * founder). The words show it in the venue's time zone.
 */
export function refundCutoffAt(start: Temporal.Instant, refundHours: number): Temporal.Instant {
  return start.subtract({ minutes: Math.round(refundHours * 60) });
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * "Thu 11:00 PM", as the Booking confirmed text reads (Song systems and texts,
 * text 1). A cut-off more than six days after `now` adds the date ("Thu, Oct 8
 * 11:00 PM") so the weekday can't be read as this week's (cautious default,
 * flagged). When the cut-off and the booked start fall on different sides of
 * a daylight-saving change, the zone is named ("Sat 11:00 PM EDT").
 */
export function cutoffWords(
  cutoff: Temporal.Instant,
  start: Temporal.Instant,
  now: Temporal.Instant,
  timeZone: string,
): string {
  const z = cutoff.toZonedDateTimeISO(timeZone);
  const hour = z.hour % 12 === 0 ? 12 : z.hour % 12;
  const clock = `${hour}:${String(z.minute).padStart(2, "0")} ${z.hour < 12 ? "AM" : "PM"}`;
  const day = DAYS[z.dayOfWeek - 1]!;
  const far = Temporal.Instant.compare(cutoff, now.add({ hours: 24 * 6 })) > 0;
  const when = far ? `${day}, ${MONTHS[z.month - 1]!} ${z.day} ${clock}` : `${day} ${clock}`;
  const across =
    cutoff.toZonedDateTimeISO(timeZone).offsetNanoseconds !==
    start.toZonedDateTimeISO(timeZone).offsetNanoseconds;
  return across ? `${when} ${zoneName(cutoff, timeZone)}` : when;
}
