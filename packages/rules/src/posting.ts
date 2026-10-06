import { Temporal } from "@west4/shared";
import { businessDate } from "./time.js";

/**
 * Posting dates (M7-02; Money rules 2 and 16; Data model · night_closes). A row
 * is stamped with the business date it happens in, moved forward past any
 * closed night: a closed night never takes another row. The database's
 * `posting_business_date(venue, at)` is the same rule; this one is for tests
 * and for screens that show where late money goes ("tips post to Sat Sep 26").
 * Dates are ISO `YYYY-MM-DD`.
 */

/** `date`, or the first business date after it that isn't closed. */
export function openBusinessDate(
  date: Temporal.PlainDate | string,
  closedNights: Iterable<string>,
): Temporal.PlainDate {
  const closed = new Set(closedNights);
  let d = typeof date === "string" ? Temporal.PlainDate.from(date) : date;
  while (closed.has(d.toString())) d = d.add({ days: 1 });
  return d;
}

/** The business date of `at` (local time minus the cutover), moved forward past any closed night. */
export function postingBusinessDate(
  at: Temporal.Instant | string,
  timeZone: string,
  cutover: string,
  closedNights: Iterable<string>,
): Temporal.PlainDate {
  return openBusinessDate(businessDate(at, timeZone, cutover).businessDate, closedNights);
}

export interface LatePosting {
  readonly businessDate: string;
  /** The earlier night the row belongs to, or null when it posts to its own night. */
  readonly adjustsBusinessDate: string | null;
}

/**
 * A row that belongs to `night` (a slip tip for a tab of that night, a refund of its check, a no-show
 * charge, a kept deposit, money collected for a `capture_failed` tab), written when the posting date is
 * `posting`: it posts there, and points back at its night when that's earlier.
 */
export function latePosting(night: string, posting: Temporal.PlainDate | string): LatePosting {
  const on = typeof posting === "string" ? Temporal.PlainDate.from(posting) : posting;
  const own = Temporal.PlainDate.from(night);
  return Temporal.PlainDate.compare(own, on) < 0
    ? { businessDate: on.toString(), adjustsBusinessDate: night }
    : { businessDate: night, adjustsBusinessDate: null };
}
