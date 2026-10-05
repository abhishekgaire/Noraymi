import { cents, Temporal, type Cents, type DepositRule, type PriceSettings } from "@west4/shared";
import { percent } from "./check-totals.js";
import { deposit } from "./deposit.js";
import { hourlyRateAt, type RoomForRate, type VenueTime } from "./rates.js";
import { roomTime, type Segment } from "./room-time.js";
import { businessDate } from "./time.js";

/**
 * A booking's full price before paying (M5-07; Payment flows · the booking
 * page; Money rules 2, 3 and 11): room time for the booked length at the
 * billable guests, minute by minute at the rate in force (a band or the VIP
 * room changes it), tax on it, the gratuity on it before tax, and the deposit.
 * Real minutes, so a booking across the fall-back hour bills its 60 extra.
 */
export interface BookingQuote {
  readonly businessDate: Temporal.PlainDate;
  readonly minGuests: number;
  readonly billableGuests: number;
  readonly minutes: number;
  readonly roomTimeCents: Cents;
  readonly taxCents: Cents;
  readonly gratuityCents: Cents;
  readonly totalCents: Cents;
  readonly depositCents: Cents;
}

export function bookingQuote(input: {
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
  readonly partySize: number;
  /** The room held for it; before a hold, any room that isn't the VIP room. */
  readonly room: RoomForRate;
  readonly prices: PriceSettings;
  readonly venue: VenueTime;
  readonly deposit: DepositRule;
  /** The rule pack's rate, "8.875". */
  readonly taxRatePct: string;
  /** 0 when the gratuity is off for rooms. */
  readonly gratuityPct: number;
}): BookingQuote {
  const segments: Segment[] = [];
  let at = input.start;
  while (Temporal.Instant.compare(at, input.end) < 0) {
    const rate = hourlyRateAt(at, input.partySize, input.room, input.prices, input.venue);
    const last = segments[segments.length - 1];
    if (last && last.hourlyCents === rate.hourlyCents)
      segments[segments.length - 1] = { ...last, minutes: last.minutes + 1 };
    else segments.push({ minutes: 1, hourlyCents: rate.hourlyCents });
    at = at.add({ minutes: 1 });
  }
  const first = hourlyRateAt(input.start, input.partySize, input.room, input.prices, input.venue);
  const room = roomTime(segments, { firstHourMinimum: false });
  const tax = percent(room.cents, input.taxRatePct);
  const gratuity = percent(room.cents, input.gratuityPct);
  const date = businessDate(input.start, input.venue.timeZone, input.venue.dayCutover).businessDate;
  return {
    businessDate: date,
    minGuests: first.minGuests,
    billableGuests: first.billableGuests,
    minutes: room.billedMinutes,
    roomTimeCents: room.cents,
    taxCents: tax,
    gratuityCents: gratuity,
    totalCents: cents(room.cents + tax + gratuity),
    depositCents: deposit(input.partySize, date, input.deposit, input.prices).depositCents,
  };
}
