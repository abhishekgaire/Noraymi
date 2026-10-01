import { Temporal, cents, type Cents, type PriceSettings } from "@west4/shared";
import { hourlyCentsFor, type RateKind, type RoomForRate, type VenueTime } from "./rates.js";
import { businessDate } from "./time.js";

/**
 * Time bands and session segments (M2-03; spec 05 · rule 3, Billing step;
 * spec 03 · PriceSettings.bands). A band has its business-date weekdays
 * (JS numbering, Sunday 0), `fromMin` and `toMin` as minutes from midnight at
 * the start of the business date (12:30 AM is 1,470), a rate in the venue's
 * own rate mode and a billing step with a rounding rule. Bands resolve per
 * business date on the wall clock (money-cases ambiguity A7); durations are
 * real minutes. West 4 has no bands and bills by the minute.
 */
export type Band = PriceSettings["bands"][number];
export type Billing = PriceSettings["billing"];

export interface BandChoice {
  /** The band's name, or null for the base rate outside every band. */
  readonly bandId: string | null;
  readonly rate: PriceSettings["rate"];
  readonly billing: Billing;
}

/** The first band that covers the minute wins; outside every band, the base rate and billing. */
export function bandAt(
  prices: PriceSettings,
  date: Temporal.PlainDate,
  minutesFromMidnight: number,
): BandChoice {
  const jsDay = date.dayOfWeek % 7;
  const band = prices.bands.find(
    (b) =>
      b.days.includes(jsDay) && b.fromMin <= minutesFromMidnight && minutesFromMidnight < b.toMin,
  );
  return band
    ? { bandId: band.name, rate: band.rate, billing: band.billing }
    : { bandId: null, rate: prices.rate, billing: prices.billing };
}

/** The rate at an instant: the band's, or the VIP flat rate for a VIP party in a VIP room. */
export function rateAt(
  at: Temporal.Instant,
  partySize: number,
  room: RoomForRate,
  prices: PriceSettings,
  venue: VenueTime,
): {
  date: Temporal.PlainDate;
  minGuests: number;
  billableGuests: number;
  bandId: string | null;
  rateKind: RateKind;
  hourlyCents: Cents;
  billing: Billing;
} {
  const bd = businessDate(at, venue.timeZone, venue.dayCutover);
  const minGuests =
    bd.businessDate.dayOfWeek === 5 || bd.businessDate.dayOfWeek === 6
      ? prices.minGuests.friSat
      : prices.minGuests.weeknight;
  const billableGuests = Math.max(partySize, minGuests);
  const choice = bandAt(prices, bd.businessDate, bd.minutesFromMidnight);
  const vip = prices.vip;
  if (vip && vip.roomIds.includes(room.id) && partySize >= vip.fromGuests) {
    return {
      date: bd.businessDate,
      minGuests,
      billableGuests,
      bandId: choice.bandId,
      rateKind: "vip",
      hourlyCents: cents(vip.hourlyCents),
      billing: choice.billing,
    };
  }
  return {
    date: bd.businessDate,
    minGuests,
    billableGuests,
    bandId: choice.bandId,
    billing: choice.billing,
    ...hourlyCentsFor(choice.rate, billableGuests, room),
  };
}

/** A segment as `session_segments` stores it (spec 04). */
export interface SessionSegment {
  readonly startedAt: Temporal.Instant;
  readonly endedAt: Temporal.Instant;
  readonly minutes: number;
  readonly billableGuests: number;
  readonly bandId: string | null;
  readonly rateKind: RateKind;
  readonly hourlyCents: Cents;
  readonly incrementMin: Billing["incrementMin"];
  readonly rounding: Billing["rounding"];
  readonly paused: boolean;
}

export interface SessionEvent {
  readonly at: Temporal.Instant;
  readonly partySize?: number;
  readonly paused?: boolean;
}

const toMinute = (i: Temporal.Instant): Temporal.Instant =>
  i.round({ smallestUnit: "minute", roundingMode: "floor" });

/**
 * Every instant in (start, end) where the band in force changes, or the
 * business date turns over at the cutover (the minimum and the day's bands
 * change with it). Found by walking the session's real minutes and reading
 * each on the wall clock, so a band edge at a wall-clock minute that doesn't
 * exist on the spring-forward night, or exists twice on the fall-back night,
 * falls where the wall clock says (money-cases ambiguity A7).
 */
export function bandBoundaries(
  start: Temporal.Instant,
  end: Temporal.Instant,
  prices: PriceSettings,
  venue: VenueTime,
): Temporal.Instant[] {
  const from = toMinute(start);
  const minutes = Math.floor((end.epochMilliseconds - from.epochMilliseconds) / 60_000);
  const keyAt = (at: Temporal.Instant): string => {
    const bd = businessDate(at, venue.timeZone, venue.dayCutover);
    return `${bd.businessDate.toString()}|${bandAt(prices, bd.businessDate, bd.minutesFromMidnight).bandId ?? ""}`;
  };
  const out: Temporal.Instant[] = [];
  let previous = keyAt(from);
  for (let m = 1; m < minutes; m++) {
    const at = from.add({ minutes: m });
    const key = keyAt(at);
    if (key !== previous) {
      out.push(at);
      previous = key;
    }
  }
  return out;
}

/**
 * The segments of a session from its start to `end`: a new one at every band
 * boundary and at every event (a party-size change, a pause or resume), each
 * on the minute, copying the band, rate and billing it was billed with. They
 * tile the session with no gap and no overlap.
 */
export function segmentsFor(
  input: {
    readonly start: Temporal.Instant;
    readonly end: Temporal.Instant;
    readonly partySize: number;
    readonly room: RoomForRate;
    readonly events?: readonly SessionEvent[];
  },
  prices: PriceSettings,
  venue: VenueTime,
): SessionSegment[] {
  const start = toMinute(input.start);
  const end = toMinute(input.end);
  if (Temporal.Instant.compare(end, start) < 0)
    throw new Error("a session can't end before it started");
  const events = [...(input.events ?? [])]
    .map((e) => ({ ...e, at: toMinute(e.at) }))
    .filter(
      (e) => Temporal.Instant.compare(e.at, start) > 0 && Temporal.Instant.compare(e.at, end) < 0,
    )
    .sort((a, b) => Temporal.Instant.compare(a.at, b.at));
  const cuts = new Map<string, Temporal.Instant>();
  for (const b of bandBoundaries(start, end, prices, venue)) cuts.set(b.toString(), b);
  for (const e of events) cuts.set(e.at.toString(), e.at);
  const points = [start, ...[...cuts.values()].sort(Temporal.Instant.compare), end];
  const segments: SessionSegment[] = [];
  let partySize = input.partySize;
  let paused = false;
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    for (const e of events) {
      if (Temporal.Instant.compare(e.at, from) === 0) {
        if (e.partySize !== undefined) partySize = e.partySize;
        if (e.paused !== undefined) paused = e.paused;
      }
    }
    if (Temporal.Instant.compare(from, to) === 0) continue;
    const r = rateAt(from, partySize, input.room, prices, venue);
    segments.push({
      startedAt: from,
      endedAt: to,
      minutes: Math.round((to.epochMilliseconds - from.epochMilliseconds) / 60_000),
      billableGuests: r.billableGuests,
      bandId: r.bandId,
      rateKind: r.rateKind,
      hourlyCents: r.hourlyCents,
      incrementMin: r.billing.incrementMin,
      rounding: r.billing.rounding,
      paused,
    });
  }
  return segments;
}
