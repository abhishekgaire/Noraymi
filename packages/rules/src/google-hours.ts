import { Temporal, type Hours } from "@west4/shared";
import type { Closure } from "./hours.js";

/**
 * The venue's hours as Google Business Profile reads them (M5-15): the
 * weekly hours become the location's `regularHours`, and every closure from
 * today on becomes a `specialHours` entry (a closed date, or that date's own
 * opening and close). The shapes are those of Google's Business Information
 * API (`Location.regularHours` and `Location.specialHours`).
 *
 * Times follow the venue's wall clock like `hoursFor`: a time before the day
 * cutover (a close of "04:00" with a 06:00 cutover) is on the next calendar
 * day, and so is a close that isn't after the opening.
 */
export type GoogleDay =
  "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY";
export interface GoogleTime {
  readonly hours: number;
  readonly minutes: number;
}
export interface GoogleDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}
export interface GoogleRegularPeriod {
  readonly openDay: GoogleDay;
  readonly openTime: GoogleTime;
  readonly closeDay: GoogleDay;
  readonly closeTime: GoogleTime;
}
export interface GoogleSpecialPeriod {
  readonly startDate: GoogleDate;
  readonly endDate?: GoogleDate;
  readonly openTime?: GoogleTime;
  readonly closeTime?: GoogleTime;
  readonly closed?: boolean;
}
export interface GoogleHours {
  readonly regularHours: { readonly periods: GoogleRegularPeriod[] };
  readonly specialHours: { readonly specialHourPeriods: GoogleSpecialPeriod[] };
}

const DAYS: readonly GoogleDay[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

const toTime = (t: string): GoogleTime => ({
  hours: Number(t.slice(0, 2)),
  minutes: Number(t.slice(3, 5)),
});
const toDate = (d: Temporal.PlainDate): GoogleDate => ({
  year: d.year,
  month: d.month,
  day: d.day,
});

/** Days after the business date that the opening and the close fall on. */
function offsets(opens: string, closes: string, cutover: string): [number, number] {
  const open = opens < cutover ? 1 : 0;
  let close = closes < cutover ? 1 : 0;
  if (close === open && closes <= opens) close += 1;
  return [open, Math.max(close, open)];
}

export function googleHours(
  hours: Hours,
  closures: readonly Closure[],
  today: Temporal.PlainDate,
  dayCutover: string,
): GoogleHours {
  const cutover = dayCutover.slice(0, 5);
  const periods = [...hours.weekly]
    .sort((a, b) => a.day - b.day)
    .map((w): GoogleRegularPeriod => {
      const [o, c] = offsets(w.opens, w.closes, cutover);
      return {
        openDay: DAYS[(w.day + o) % 7]!,
        openTime: toTime(w.opens),
        closeDay: DAYS[(w.day + c) % 7]!,
        closeTime: toTime(w.closes),
      };
    });
  const specialHourPeriods = [...closures]
    .filter((x) => Temporal.PlainDate.compare(Temporal.PlainDate.from(x.date), today) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((x): GoogleSpecialPeriod => {
      const date = Temporal.PlainDate.from(x.date);
      const weekly = hours.weekly.find((w) => w.day === date.dayOfWeek % 7);
      const opens = x.kind === "special" ? (x.opens ?? weekly?.opens ?? null) : null;
      const closes = x.kind === "special" ? (x.closes ?? weekly?.closes ?? null) : null;
      if (opens === null || closes === null) return { startDate: toDate(date), closed: true };
      const [o, c] = offsets(opens.slice(0, 5), closes.slice(0, 5), cutover);
      return {
        startDate: toDate(date.add({ days: o })),
        openTime: toTime(opens),
        endDate: toDate(date.add({ days: c })),
        closeTime: toTime(closes),
      };
    });
  return { regularHours: { periods }, specialHours: { specialHourPeriods } };
}
