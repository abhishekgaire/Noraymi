import { Temporal, type Hours } from "@west4/shared";
import { wallClock } from "./time.js";

/**
 * Each business date's opening hours (M1-12): the opening, the close and the
 * house last call as instants, from hours.weekly and any closure for the
 * date, resolved on the wall clock in the venue's zone. A close of "04:00"
 * belongs to the business date it ends. Screens and jobs read "open now"
 * from here and the venue's clock, never the device's.
 *
 * hours.weekly[].day counts Sunday as 0 through Saturday as 6, like
 * JavaScript's Date.getDay().
 */
export interface Closure {
  readonly date: string;
  readonly kind: "closed" | "special";
  readonly opens?: string | null | undefined;
  readonly closes?: string | null | undefined;
}

export interface VenueTime {
  readonly timeZone: string;
  readonly dayCutover: string;
}

export interface BusinessDateHours {
  readonly businessDate: string;
  readonly closed: boolean;
  readonly opens: Temporal.Instant | null;
  readonly closes: Temporal.Instant | null;
  /** The house last call, never later than the close. */
  readonly lastCall: Temporal.Instant | null;
  /** Where the times came from: the weekly hours or a closure. */
  readonly source: "weekly" | "special" | "closed" | "none";
}

export function hoursFor(
  venue: VenueTime,
  businessDate: Temporal.PlainDate,
  hours: Hours,
  closure?: Closure | null,
): BusinessDateHours {
  const date = businessDate.toString();
  if (closure && closure.date === date && closure.kind === "closed") {
    return {
      businessDate: date,
      closed: true,
      opens: null,
      closes: null,
      lastCall: null,
      source: "closed",
    };
  }
  const jsDay = businessDate.dayOfWeek % 7; // Temporal: Monday 1 … Sunday 7 → JS: Sunday 0 … Saturday 6
  const weekly = hours.weekly.find((w) => w.day === jsDay);
  const special =
    closure && closure.date === date && closure.kind === "special" ? closure : undefined;
  const opensAt = special?.opens ?? weekly?.opens ?? null;
  const closesAt = special?.closes ?? weekly?.closes ?? null;
  if (opensAt === null || closesAt === null) {
    return {
      businessDate: date,
      closed: true,
      opens: null,
      closes: null,
      lastCall: null,
      source: "none",
    };
  }
  const at = (time: string) => wallClock(businessDate, time, venue.timeZone, venue.dayCutover);
  const opens = at(opensAt);
  const closes = at(closesAt);
  let lastCall: Temporal.Instant | null = hours.lastCall === null ? null : at(hours.lastCall);
  // Cautious reading (M1-12 notes): the house last call is never later than that night's close.
  if (lastCall !== null && Temporal.Instant.compare(lastCall, closes) > 0) lastCall = closes;
  return {
    businessDate: date,
    closed: false,
    opens,
    closes,
    lastCall,
    source: special ? "special" : "weekly",
  };
}

/** Open at this instant: on or after the opening and before the close. */
export function openNow(hours: BusinessDateHours, at: Temporal.Instant): boolean {
  if (hours.closed || hours.opens === null || hours.closes === null) return false;
  return (
    Temporal.Instant.compare(at, hours.opens) >= 0 && Temporal.Instant.compare(at, hours.closes) < 0
  );
}
