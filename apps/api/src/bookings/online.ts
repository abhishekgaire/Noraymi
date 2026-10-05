import { randomBytes } from "node:crypto";
import {
  emitEvent,
  listRooms,
  payTokenHash,
  readSetting,
  rulePackFor,
  type Queryable,
} from "@west4/db";
import {
  bookingGrid,
  bookingQuote,
  businessDate,
  minGuestsOn,
  resolveStart,
  type BookingQuote,
} from "@west4/rules";
import { Temporal, type DepositRule, type PriceSettings } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { assignBooking, freeSlots, nightHours, venueClock } from "../rooms/assignment.js";
import { pctOf } from "../site/site.js";

/**
 * Online booking, the Pick step (M5-07; Payment flows · Deposit when booking
 * online, step 1; API · availability and bookings): the night's start times
 * with a free room of the right size, the full price before paying, and the
 * hold. Picking a slot gives the booking a real room (the smallest free one
 * offered online that fits) as a pending web booking with a hold block that
 * lapses 10 minutes out; "More time" adds 10 minutes, ten times. Everything
 * is read on the venue's clock, never the guest's device.
 */
export const HOLD_MINUTES = 10;
export const MORE_TIME_TIMES = 10;

interface Night {
  readonly timeZone: string;
  readonly dayCutover: string;
  readonly today: Temporal.PlainDate;
  readonly prices: PriceSettings;
  readonly deposit: DepositRule;
  readonly taxRatePct: string;
  readonly gratuityPct: number;
  readonly wording: "plusTaxAndGratuity" | "allIn";
}

async function nightFacts(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  on: Temporal.PlainDate,
): Promise<Night> {
  const venue = await venueClock(c, venueId);
  const packId =
    (
      await c.query<{ rule_pack_id: string | null }>(
        "select rule_pack_id from venues where id = $1",
        [venueId],
      )
    ).rows[0]?.rule_pack_id ?? "us-ny-new-york-county";
  const [prices, deposit, pay, website, pack] = await Promise.all([
    readSetting(c, venueId, "prices", on),
    readSetting(c, venueId, "deposit", on),
    readSetting(c, venueId, "pay", on),
    readSetting(c, venueId, "website", on),
    rulePackFor(c, packId, on),
  ]);
  if (!prices || !deposit || !pay)
    throw new ApiError("invalid_request", "this venue's prices and deposit aren't set");
  const g = pay.value.gratuity;
  return {
    ...venue,
    today: businessDate(now, venue.timeZone, venue.dayCutover).businessDate,
    prices: prices.value,
    deposit: deposit.value,
    taxRatePct: pack ? pctOf(pack.pack.salesTax.rate) : "0",
    gratuityPct: g.auto === "rooms" || g.auto === "all" ? g.pct : 0,
    wording: website?.value.priceWording ?? "plusTaxAndGratuity",
  };
}

const quoteJson = (q: BookingQuote) => ({
  business_date: q.businessDate.toString(),
  min_guests: q.minGuests,
  billable_guests: q.billableGuests,
  minutes: q.minutes,
  room_time_cents: q.roomTimeCents,
  tax_cents: q.taxCents,
  gratuity_cents: q.gratuityCents,
  total_cents: q.totalCents,
  deposit_cents: q.depositCents,
});

const refuse = (reason: string, message: string) =>
  new ApiError("invalid_request", message, { details: { reason } });

/** `GET /v1/public/venues/{slug}/availability?date=&guests=&hours=`. */
export async function onlineAvailability(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  query: { date?: string | undefined; guests: number; hours?: number | undefined },
) {
  const venue = await venueClock(c, venueId);
  const today = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const on = query.date ? Temporal.PlainDate.from(query.date) : today;
  if (Temporal.PlainDate.compare(on, today) < 0) throw refuse("past", "pick tonight or later");
  const n = await nightFacts(c, venueId, now, on);
  const limits = n.prices.booking;
  const hours = query.hours ?? limits.minHours;
  const rooms = (await listRooms(c, venueId)).filter((r) => r.bookable_online && !r.archived_at);
  const largest = Math.max(0, ...rooms.map((r) => r.capacity_max));
  const base = {
    business_date: on.toString(),
    today: today.toString(),
    guests: query.guests,
    hours,
    min_guests: minGuestsOn(on, n.prices),
    billable_guests: Math.max(query.guests, minGuestsOn(on, n.prices)),
    limits: {
      min_hours: limits.minHours,
      max_hours: limits.maxHours,
      max_guests: Math.min(limits.maxGuests, largest),
    },
    price_wording: n.wording,
    tax_pct: n.taxRatePct,
    gratuity_pct: n.gratuityPct,
  };
  // Too many for a room booked online: the enquiry form takes them.
  if (query.guests > limits.maxGuests || query.guests > largest)
    return { ...base, closed: false, too_big: true, slots: [], quote: null };
  if (hours < limits.minHours || hours > limits.maxHours)
    throw refuse("hours", `a booking is ${limits.minHours} to ${limits.maxHours} hours`);
  const night = await nightHours(c, venueId, venue, on);
  if (!night) return { ...base, closed: true, too_big: false, slots: [], quote: null };
  const grid = bookingGrid({
    opens: night.opens,
    closes: night.closes,
    minHours: hours,
    startSlots: limits.startSlots,
    timeZone: venue.timeZone,
  }).filter((s) => Temporal.Instant.compare(s.start, now) > 0);
  const length = Math.round(hours * 60);
  const free = await freeSlots(c, venueId, {
    party: query.guests,
    online: true,
    slots: grid.map((s) => ({ from: s.start, to: s.start.add({ minutes: length }) })),
  });
  const first = grid[0];
  return {
    ...base,
    closed: false,
    too_big: false,
    slots: grid.map((s, i) => ({
      start: s.start.toString(),
      time: s.time,
      zone: s.zone,
      offset: s.offset,
      free: free[i]!.free,
      size_tier: free[i]!.sizeTier,
    })),
    // The price for this party and length (a band can change it; the hold's own quote is exact).
    quote: first
      ? quoteJson(
          bookingQuote({
            start: first.start,
            end: first.start.add({ minutes: length }),
            partySize: query.guests,
            room: { id: "", sizeTier: null },
            prices: n.prices,
            venue,
            deposit: n.deposit,
            taxRatePct: n.taxRatePct,
            gratuityPct: n.gratuityPct,
          }),
        )
      : null,
  };
}

/** `POST /v1/public/venues/{slug}/bookings`: a real room held for 10 minutes. */
export async function holdBooking(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  input: {
    business_date: string;
    time: string;
    offset?: string | undefined;
    hours: number;
    party_size: number;
  },
) {
  const venue = await venueClock(c, venueId);
  const on = Temporal.PlainDate.from(input.business_date);
  const n = await nightFacts(c, venueId, now, on);
  const limits = n.prices.booking;
  if (input.party_size > limits.maxGuests)
    throw refuse("too_big", "a party this size books through the enquiry form");
  if (input.hours < limits.minHours || input.hours > limits.maxHours)
    throw refuse("hours", `a booking is ${limits.minHours} to ${limits.maxHours} hours`);
  const resolved = resolveStart(on, input.time, venue.timeZone, venue.dayCutover, input.offset);
  if ("refused" in resolved)
    throw refuse(
      resolved.refused,
      resolved.refused === "does_not_exist"
        ? "that time doesn't exist that night: the clocks skip it"
        : resolved.refused === "ambiguous"
          ? "that time happens twice that night: pick EDT or EST"
          : "time is HH:MM",
    );
  const start = resolved.start;
  if (Temporal.Instant.compare(start, now) <= 0) throw refuse("past", "that time has passed");
  const night = await nightHours(c, venueId, venue, on);
  if (!night) throw refuse("closed", "the venue is closed that night");
  const length = Math.round(input.hours * 60);
  const onGrid = bookingGrid({
    opens: night.opens,
    closes: night.closes,
    minHours: input.hours,
    startSlots: limits.startSlots,
    timeZone: venue.timeZone,
  }).some((s) => s.start.equals(start));
  if (!onGrid) throw refuse("off_grid", "that isn't one of the night's start times");
  const end = start.add({ minutes: length });
  const lapses = now.add({ minutes: HOLD_MINUTES });
  const block = await assignBooking(c, venueId, {
    party: input.party_size,
    from: start,
    to: end,
    refId: null,
    kind: "hold",
    expiresAt: lapses,
    online: true,
  });
  const room = (await listRooms(c, venueId)).find((r) => r.id === block.room_id)!;
  const q = bookingQuote({
    start,
    end,
    partySize: input.party_size,
    room: { id: room.id, sizeTier: room.size_tier },
    prices: n.prices,
    venue,
    deposit: n.deposit,
    taxRatePct: n.taxRatePct,
    gratuityPct: n.gratuityPct,
  });
  // The guest's link: 128 random bits, stored hashed; it becomes the manage link once confirmed.
  const token = randomBytes(16).toString("base64url");
  const big = n.deposit.bigParty && input.party_size >= n.deposit.bigParty.fromGuests;
  const refundHours = big ? n.deposit.bigParty!.refundHours : n.deposit.refundHours;
  const id = (
    await c.query<{ id: string }>(
      `insert into bookings (venue_id, guest_id, room_id, size_tier, party_size, starts_at, ends_at, business_date,
         status, source, deposit_cents, refund_cutoff_at, pending_until, manage_token_hash)
       values ($1, null, $2, $3, $4, $5, $6, $7, 'pending', 'web', $8, $9, $10, $11) returning id`,
      [
        venueId,
        room.id,
        room.size_tier,
        input.party_size,
        start.toString(),
        end.toString(),
        on.toString(),
        q.depositCents,
        q.depositCents > 0
          ? start.subtract({ minutes: Math.round(refundHours * 60) }).toString()
          : null,
        lapses.toString(),
        payTokenHash(token),
      ],
    )
  ).rows[0]!.id;
  await c.query("update room_blocks set ref_id = $3 where venue_id = $1 and id = $2", [
    venueId,
    block.id,
    id,
  ]);
  await emitEvent(c, { venueId, type: "booking.updated", entityId: id });
  return { token, bookingId: id };
}

/** A web booking by its link, for the steps after Pick: the hold, the room size and the exact quote. */
export async function heldBooking(
  c: Queryable,
  venueId: string,
  tokenHash: string,
  now: Temporal.Instant,
) {
  const b = (
    await c.query<{
      id: string;
      status: string;
      party_size: number;
      size_tier: string;
      room_id: string;
      starts_at: string;
      ends_at: string;
      business_date: string;
      pending_until: string | null;
      hold_extensions: number;
      refund_cutoff_at: string | null;
    }>(
      `select id, status, party_size, size_tier, room_id, to_json(starts_at) #>> '{}' as starts_at,
              to_json(ends_at) #>> '{}' as ends_at, business_date::text, to_json(pending_until) #>> '{}' as pending_until,
              hold_extensions, to_json(refund_cutoff_at) #>> '{}' as refund_cutoff_at
         from bookings where venue_id = $1 and manage_token_hash = $2`,
      [venueId, tokenHash],
    )
  ).rows[0];
  if (!b) throw new ApiError("not_found", "no such booking");
  const venue = await venueClock(c, venueId);
  const on = Temporal.PlainDate.from(b.business_date);
  const n = await nightFacts(c, venueId, now, on);
  const start = Temporal.Instant.from(b.starts_at);
  const q = bookingQuote({
    start,
    end: Temporal.Instant.from(b.ends_at),
    partySize: b.party_size,
    room: { id: b.room_id, sizeTier: b.size_tier },
    prices: n.prices,
    venue,
    deposit: n.deposit,
    taxRatePct: n.taxRatePct,
    gratuityPct: n.gratuityPct,
  });
  const lapsed =
    b.status === "cancelled" ||
    (b.status === "pending" &&
      b.pending_until !== null &&
      Temporal.Instant.compare(Temporal.Instant.from(b.pending_until), now) <= 0);
  return {
    id: b.id,
    status: lapsed && b.status === "pending" ? "lapsed" : b.status,
    party_size: b.party_size,
    size_tier: b.size_tier,
    starts_at: b.starts_at,
    ends_at: b.ends_at,
    time_zone: venue.timeZone,
    pending_until: b.pending_until,
    seconds_left: b.pending_until
      ? Math.max(0, Math.floor((Date.parse(b.pending_until) - now.epochMilliseconds) / 1000))
      : null,
    more_time_left: Math.max(0, MORE_TIME_TIMES - b.hold_extensions),
    refund_cutoff_at: b.refund_cutoff_at,
    price_wording: n.wording,
    tax_pct: n.taxRatePct,
    gratuity_pct: n.gratuityPct,
    quote: quoteJson(q),
  };
}

/** "More time": 10 more minutes on the hold, while it's still held, ten times. */
export async function moreTime(
  c: Queryable,
  venueId: string,
  bookingId: string,
  now: Temporal.Instant,
) {
  const r = await c.query<{ pending_until: string }>(
    `update bookings set pending_until = $3::timestamptz + interval '${HOLD_MINUTES} minutes',
            hold_extensions = hold_extensions + 1
      where venue_id = $1 and id = $2 and status = 'pending' and source = 'web'
        and pending_until > $3 and hold_extensions < ${MORE_TIME_TIMES}
      returning to_json(pending_until) #>> '{}' as pending_until`,
    [venueId, bookingId, now.toString()],
  );
  const until = r.rows[0]?.pending_until;
  if (!until)
    throw new ApiError("invalid_request", "this hold can't be extended", {
      details: { reason: "hold_over" },
    });
  await c.query(
    "update room_blocks set expires_at = $3 where venue_id = $1 and ref_id = $2 and kind = 'hold'",
    [venueId, bookingId, until],
  );
}

/** Web holds that lapsed unpaid are cancelled (their blocks go with the hold sweep). */
export async function lapseHolds(c: Queryable, venueId: string, now: Temporal.Instant) {
  const r = await c.query<{ id: string }>(
    `update bookings set status = 'cancelled'
      where venue_id = $1 and source = 'web' and status = 'pending' and pending_until <= $2
      returning id`,
    [venueId, now.toString()],
  );
  for (const row of r.rows)
    await emitEvent(c, { venueId, type: "booking.updated", entityId: row.id });
  return r.rows.length;
}
