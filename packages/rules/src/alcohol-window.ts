import { Temporal, type RulePack } from "@west4/shared";
import { businessDate, wallClock } from "./time.js";

/**
 * The alcohol window (spec 03 · Rule packs; Money rules 5). Open until the
 * earlier of the rule pack's last sale and the venue's house last call,
 * resolved on the wall clock in the venue's zone for that business date,
 * never as opening time plus hours (an hour off on daylight-saving nights).
 * Closed from then until the pack's first sale ("08:00") on the calendar day
 * the close falls on. Every screen reads `changesAt`, so all of them grey
 * alcohol at the same instant; the server enforces it on every route.
 */
export interface AlcoholVenue {
  readonly timeZone: string;
  readonly dayCutover: string;
  readonly alcohol: Pick<
    RulePack["alcohol"],
    "lastSale" | "firstSale" | "drinkingUpMin" | "drinkingUpFrom"
  >;
  /** The venue's hours.lastCall, "HH:MM" or null. */
  readonly lastCall: string | null;
}

export interface AlcoholWindow {
  readonly state: "open" | "closed";
  /** The next instant the state changes. */
  readonly changesAt: Temporal.Instant;
  /** When the window that's open, or that last closed, closes. */
  readonly closesAt: Temporal.Instant;
}

const earlier = (a: Temporal.Instant, b: Temporal.Instant) =>
  Temporal.Instant.compare(a, b) <= 0 ? a : b;

/** The instant the window closes on a business date. */
export function windowClose(
  venue: AlcoholVenue,
  date: Temporal.PlainDate | string,
): Temporal.Instant {
  const at = (t: string) => wallClock(date, t, venue.timeZone, venue.dayCutover);
  const lastSale = at(venue.alcohol.lastSale);
  return venue.lastCall === null ? lastSale : earlier(lastSale, at(venue.lastCall));
}

/** The first sale after a business date's close: firstSale on the calendar day the close falls on. */
function reopens(venue: AlcoholVenue, date: Temporal.PlainDate): Temporal.Instant {
  const day = windowClose(venue, date).toZonedDateTimeISO(venue.timeZone).toPlainDate();
  const t = Temporal.PlainTime.from(venue.alcohol.firstSale);
  return day.toZonedDateTime({ timeZone: venue.timeZone, plainTime: t }).toInstant();
}

export function alcoholWindow(venue: AlcoholVenue, at: Temporal.Instant): AlcoholWindow {
  const today = businessDate(at, venue.timeZone, venue.dayCutover).businessDate;
  const yesterday = today.subtract({ days: 1 });
  // Still inside the closed stretch that began on the previous business date (before the first sale).
  const lastReopen = reopens(venue, yesterday);
  if (Temporal.Instant.compare(at, lastReopen) < 0) {
    return { state: "closed", changesAt: lastReopen, closesAt: windowClose(venue, yesterday) };
  }
  const close = windowClose(venue, today);
  if (Temporal.Instant.compare(at, close) < 0) {
    return { state: "open", changesAt: close, closesAt: close };
  }
  return { state: "closed", changesAt: reopens(venue, today), closesAt: close };
}

/** The clear-out check: the window's close plus drinking-up time (4:30 AM at West 4). */
export function clearOutDue(
  venue: AlcoholVenue,
  date: Temporal.PlainDate | string,
): Temporal.Instant {
  return windowClose(venue, date).add({ minutes: venue.alcohol.drinkingUpMin });
}
