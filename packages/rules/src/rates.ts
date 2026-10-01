import type { Temporal } from "@west4/shared";
import { cents, type Cents, type PriceSettings } from "@west4/shared";
import { businessDate } from "./time.js";

/**
 * The hourly rate (M2-02; spec 05 · rules 2 and 3). The business date decides
 * the minimum (3 on weeknights, 4 on Friday and Saturday at West 4); billable
 * guests is the larger of the party size and that minimum; the hourly cents
 * come from the venue's rate mode. In a VIP room a party at or above the VIP
 * threshold pays the VIP flat rate instead. Time bands join in M2-03.
 */
export type RateKind = "per_person" | "base_plus_extra" | "flat_by_size" | "vip";

export interface RoomForRate {
  readonly id: string;
  readonly sizeTier?: string | null;
}

export interface VenueTime {
  readonly timeZone: string;
  readonly dayCutover: string;
}

export interface HourlyRate {
  readonly businessDate: Temporal.PlainDate;
  readonly minGuests: number;
  readonly billableGuests: number;
  readonly rateKind: RateKind;
  readonly hourlyCents: Cents;
}

/** Friday and Saturday business dates take the friSat minimum; every other night is a weeknight. */
export function minGuestsOn(date: Temporal.PlainDate, prices: PriceSettings): number {
  return date.dayOfWeek === 5 || date.dayOfWeek === 6
    ? prices.minGuests.friSat
    : prices.minGuests.weeknight;
}

export function billableGuestsOn(
  partySize: number,
  date: Temporal.PlainDate,
  prices: PriceSettings,
): number {
  return Math.max(partySize, minGuestsOn(date, prices));
}

/** The hourly cents for billable guests in a rate mode, without the VIP rule. */
export function hourlyCentsFor(
  rate: PriceSettings["rate"],
  billableGuests: number,
  room?: RoomForRate,
): { rateKind: Exclude<RateKind, "vip">; hourlyCents: Cents } {
  switch (rate.mode) {
    case "perPerson":
      return { rateKind: "per_person", hourlyCents: cents(rate.perPersonCents * billableGuests) };
    case "basePlusExtra":
      return {
        rateKind: "base_plus_extra",
        hourlyCents: cents(
          rate.baseCents + rate.extraCents * Math.max(0, billableGuests - rate.baseGuests),
        ),
      };
    case "flatBySize": {
      const tier = room?.sizeTier ?? null;
      const price = tier === null ? undefined : rate.bySizeCents[tier];
      if (price === undefined) throw new Error(`no price for size tier "${tier ?? "none"}"`);
      return { rateKind: "flat_by_size", hourlyCents: cents(price) };
    }
  }
}

export function hourlyRateAt(
  at: Temporal.Instant,
  partySize: number,
  room: RoomForRate,
  prices: PriceSettings,
  venue: VenueTime,
): HourlyRate {
  const date = businessDate(at, venue.timeZone, venue.dayCutover).businessDate;
  const minGuests = minGuestsOn(date, prices);
  const billableGuests = Math.max(partySize, minGuests);
  const vip = prices.vip;
  if (vip && vip.roomIds.includes(room.id) && partySize >= vip.fromGuests) {
    return {
      businessDate: date,
      minGuests,
      billableGuests,
      rateKind: "vip",
      hourlyCents: cents(vip.hourlyCents),
    };
  }
  // The band the instant falls in (M2-03) decides the rate; outside every band, the base rate.
  const bd = businessDate(at, venue.timeZone, venue.dayCutover);
  const jsDay = date.dayOfWeek % 7;
  const band = prices.bands.find(
    (b) =>
      b.days.includes(jsDay) &&
      b.fromMin <= bd.minutesFromMidnight &&
      bd.minutesFromMidnight < b.toMin,
  );
  return {
    businessDate: date,
    minGuests,
    billableGuests,
    ...hourlyCentsFor(band?.rate ?? prices.rate, billableGuests, room),
  };
}
