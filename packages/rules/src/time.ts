import { Temporal } from "@west4/shared";

/**
 * Business dates (Money rules 2). Every sale, payment, shift and drawer move
 * belongs to the night it happened in: its wall-clock time in the venue's
 * zone, minus the venue's day cutover (06:00 at West 4). Minutes from
 * midnight count from the start of the business date, so 12:30 AM early on a
 * Sunday is Saturday at minute 1,470. On the two daylight-saving nights the
 * minute is the wall-clock reading (money-cases ambiguity A7); durations are
 * billed from elapsed time, never from these readings.
 */
export interface BusinessDateResult {
  readonly businessDate: Temporal.PlainDate;
  /** Wall-clock minutes from midnight at the start of the business date, 0 to 1,799. */
  readonly minutesFromMidnight: number;
}

const CUTOVER = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseCutover(cutover: string): Temporal.PlainTime {
  const m = CUTOVER.exec(cutover);
  if (!m) throw new RangeError(`cutover must be HH:MM, got ${JSON.stringify(cutover)}`);
  return Temporal.PlainTime.from({ hour: Number(m[1]), minute: Number(m[2]) });
}

export function businessDate(
  instant: Temporal.Instant | string,
  timeZone: string,
  cutover: string,
): BusinessDateResult {
  const at = typeof instant === "string" ? Temporal.Instant.from(instant) : instant;
  const cut = parseCutover(cutover);
  const wall = at.toZonedDateTimeISO(timeZone).toPlainDateTime();
  const minutes = wall.hour * 60 + wall.minute;
  const beforeCutover = Temporal.PlainTime.compare(wall.toPlainTime(), cut) < 0;
  return beforeCutover
    ? {
        businessDate: wall.toPlainDate().subtract({ days: 1 }),
        minutesFromMidnight: minutes + 24 * 60,
      }
    : { businessDate: wall.toPlainDate(), minutesFromMidnight: minutes };
}

/**
 * The instant a wall-clock time in settings ("HH:MM") happens on a business
 * date. A time before the cutover, such as "04:00", falls on the calendar day
 * after. Temporal's "compatible" rule resolves the daylight-saving nights: a
 * time in the repeated hour is its first occurrence, one in the skipped hour
 * is the hour after.
 */
export function wallClock(
  businessDate: Temporal.PlainDate | string,
  time: string,
  timeZone: string,
  cutover: string,
): Temporal.Instant {
  const date =
    typeof businessDate === "string" ? Temporal.PlainDate.from(businessDate) : businessDate;
  const cut = parseCutover(cutover);
  const at = parseCutover(time);
  const calendarDay = Temporal.PlainTime.compare(at, cut) < 0 ? date.add({ days: 1 }) : date;
  return calendarDay
    .toZonedDateTime({ timeZone, plainTime: at }) // disambiguation defaults to "compatible"
    .toInstant();
}
