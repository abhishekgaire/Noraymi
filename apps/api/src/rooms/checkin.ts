import { createHash, randomBytes, randomInt } from "node:crypto";
import type pg from "pg";
import {
  addBlock,
  addVisualChecks,
  bookingById,
  emitEvent,
  findOrCreateGuest,
  insertCheck,
  listRooms,
  nextCheckNumber,
  readSetting,
  releaseBlock,
  RoomNotFree,
  setRoomState,
  updateBooking,
  withVenue,
  type Queryable,
} from "@west4/db";
import { businessDate, rateAt, type RoomForRate } from "@west4/rules";
import { Temporal, type Clock } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { queueText } from "../texts/queue.js";
import type { VenueTextSettings } from "../texts/venue.js";
import { venueClock } from "./assignment.js";

/**
 * Check-in, walk-ins and Mark no-show (M2-11; screens N10; spec 10 · Check in;
 * spec 08 · Bookings, Board and sessions; spec 09 · Joining a room). One sheet:
 * the party size with its billable minimum, the IDs checked, the room, the
 * clock, the deposit, and a new 5-character room code texted to the host with
 * the join link.
 */

/** No 0/O, 1/I/L, 5/S, 8/B: a code read aloud or off a wall can't be misread. */
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY234679";

/** A new 5-character room code that never contains a digit of the room's own number. */
export function newRoomCode(roomName: string, random: (n: number) => number = randomInt): string {
  const banned = new Set(roomName.replace(/\D/g, "").split(""));
  const alphabet = [...CODE_ALPHABET].filter((ch) => !banned.has(ch));
  let code = "";
  for (let i = 0; i < 5; i++) code += alphabet[random(alphabet.length)];
  return code;
}

export const hashRoomCode = (venueId: string, code: string) =>
  createHash("sha256").update(`${venueId}:${code.toUpperCase()}`).digest("hex");

export interface CheckInSettings {
  readonly texts: Pick<VenueTextSettings, "allowList">;
  readonly guestAppUrl: string | null;
}

interface Context {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly settings: CheckInSettings;
}

export async function priceContext(c: Queryable, venueId: string, at: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(at, venue.timeZone, venue.dayCutover).businessDate;
  const [prices, deposit] = await Promise.all([
    readSetting(c, venueId, "prices", date),
    readSetting(c, venueId, "deposit", date),
  ]);
  if (!prices) throw new ApiError("invalid_request", "prices aren't set for this venue");
  return { venue, date, prices: prices.value, graceMin: deposit?.value.graceMin ?? 15 };
}

/** When Mark no-show becomes allowed: the grace past the start, or a running-late hold if that ends later. */
export function noShowFrom(
  startsAt: string,
  graceMin: number,
  runningLateUntil: string | null,
): Temporal.Instant {
  const grace = Temporal.Instant.from(startsAt).add({ minutes: graceMin });
  if (!runningLateUntil) return grace;
  const late = Temporal.Instant.from(runningLateUntil);
  return Temporal.Instant.compare(late, grace) > 0 ? late : grace;
}

/** What the sheet shows before anyone presses Check in. */
export async function checkInPreview(
  c: Queryable,
  venueId: string,
  input: { bookingId?: string; roomId?: string; partySize?: number },
  now: Temporal.Instant,
) {
  const booking = input.bookingId ? await bookingById(c, venueId, input.bookingId) : null;
  if (input.bookingId && !booking) throw new ApiError("not_found", "no such booking");
  const rooms = await listRooms(c, venueId);
  const roomId = input.roomId ?? booking?.room_id;
  const room = rooms.find((r) => r.id === roomId);
  if (!room) throw new ApiError("not_found", "no such room");
  const party = input.partySize ?? booking?.party_size ?? room.capacity_min;
  const ctx = await priceContext(c, venueId, now);
  const rate = rateAt(now, party, room as RoomForRate, ctx.prices, ctx.venue);
  const friSat = ctx.date.dayOfWeek === 5 || ctx.date.dayOfWeek === 6;
  const from = booking
    ? noShowFrom(booking.starts_at, ctx.graceMin, booking.running_late_until)
    : null;
  return {
    booking_id: booking?.id ?? null,
    guest_name: booking?.guest_name ?? null,
    party_size: party,
    min_guests: rate.minGuests,
    billable_guests: rate.billableGuests,
    /** "weeknight" or "fri_sat": which minimum, and the day word the sheet uses. */
    min_day: friSat ? (ctx.date.dayOfWeek === 5 ? "friday" : "saturday") : "weeknight",
    hourly_cents: rate.hourlyCents,
    room_id: room.id,
    room_name: room.name,
    room_fits: party <= room.capacity_max,
    deposit_cents: booking?.deposit_cents ?? 0,
    booked_start: booking?.starts_at ?? null,
    booked_end: booking?.ends_at ?? null,
    no_show_from: from?.toString() ?? null,
    can_no_show: from ? Temporal.Instant.compare(now, from) >= 0 : false,
  };
}

interface SeatInput {
  readonly venueId: string;
  readonly roomId: string;
  readonly partySize: number;
  readonly idsChecked: number;
  readonly start: Temporal.Instant;
  readonly plannedEnd: Temporal.Instant;
  readonly bookingId: string | null;
  readonly bookingBlockId: string | null;
  readonly guest: { id: string | null; phone: string | null };
  readonly userId: string;
}

/**
 * Seats a party: the session and its first segment, the session's block (the
 * booking's own block turns into it, or a new one when the room changed), the
 * room in use, the check with its number (taken first, in its own short
 * transaction), and the Room code text to the host. A room that doesn't fit
 * or isn't free answers 409 room_not_free.
 */
async function seat(ctx: Context, input: SeatInput) {
  const number = await nextCheckNumber(ctx.pool, input.venueId);
  return withVenue(ctx.pool, { venueId: input.venueId, userId: input.userId }, async (c) => {
    const rooms = await listRooms(c, input.venueId);
    const room = rooms.find((r) => r.id === input.roomId);
    if (!room) throw new ApiError("not_found", "no such room");
    if (room.state === "out_of_service")
      throw new ApiError("room_not_free", "that room is out of service");
    if (input.partySize > room.capacity_max)
      throw new ApiError("room_not_free", `${room.name} holds ${room.capacity_max}`, {
        details: { reason: "too_small" },
      });
    const open = await c.query(
      "select 1 from room_sessions where venue_id = $1 and room_id = $2 and ended_at is null",
      [input.venueId, room.id],
    );
    if (open.rowCount)
      throw new ApiError("room_not_free", "another party is in that room", {
        details: { reason: "in_use" },
      });

    const priced = await priceContext(c, input.venueId, input.start);
    const rate = rateAt(
      input.start,
      input.partySize,
      room as RoomForRate,
      priced.prices,
      priced.venue,
    );
    const code = newRoomCode(room.name);
    const hostToken = randomBytes(24).toString("base64url");
    const sessionId = (
      await c.query<{ id: string }>(
        `insert into room_sessions (venue_id, room_id, booking_id, party_size, started_at, booked_end_at, business_date,
           server_user_id, room_code_hash, token_version, host_token_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10) returning id`,
        [
          input.venueId,
          room.id,
          input.bookingId,
          input.partySize,
          input.start.toString(),
          input.plannedEnd.toString(),
          priced.date.toString(),
          input.userId,
          hashRoomCode(input.venueId, code),
          createHash("sha256").update(hostToken).digest("hex"),
        ],
      )
    ).rows[0]!.id;
    await c.query(
      `insert into session_segments (venue_id, session_id, room_id, started_at, billable_guests, rate_kind, hourly_cents, band_id, increment_min, rounding)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.venueId,
        sessionId,
        room.id,
        input.start.toString(),
        rate.billableGuests,
        rate.rateKind,
        rate.hourlyCents,
        rate.bandId,
        rate.billing.incrementMin,
        rate.billing.rounding,
      ],
    );

    // Step 2 of the sheet: one visual row per person whose ID was checked (who checked, and when).
    await addVisualChecks(c, input.venueId, {
      sessionId,
      count: input.idsChecked,
      checkedBy: input.userId,
      at: input.start.toString(),
    });

    // The room's block: the booking's own block becomes the session's, or the session takes the new room.
    const cleaning =
      (await readSetting(c, input.venueId, "rooms", priced.date))?.value.cleaningMin ?? 0;
    const blockEnd = input.plannedEnd.add({ minutes: room.cleaning_min ?? cleaning });
    try {
      if (input.bookingBlockId) await releaseBlock(c, input.bookingBlockId);
      await addBlock(c, {
        venueId: input.venueId,
        roomId: room.id,
        kind: "session",
        from: input.start,
        to: blockEnd,
        refId: sessionId,
      });
    } catch (e) {
      if (e instanceof RoomNotFree)
        throw new ApiError("room_not_free", `${room.name} isn't free for that time`, {
          details: { reason: "taken" },
        });
      throw e;
    }
    await setRoomState(c, input.venueId, room.id, {
      state: "in_use",
      setBy: input.userId,
      at: input.start.toString(),
    });

    const checkId = await insertCheck(c, {
      venueId: input.venueId,
      number,
      kind: "room",
      businessDate: priced.date.toString(),
      roomSessionId: sessionId,
      bookingId: input.bookingId,
      openedBy: input.userId,
      openedAt: input.start.toString(),
    });
    await c.query("update room_sessions set check_id = $3 where venue_id = $1 and id = $2", [
      input.venueId,
      sessionId,
      checkId,
    ]);

    // The Room code text, to the host, with the join link that carries the host token.
    let texted: "queued" | "no_phone" | "not_sent" = "no_phone";
    if (input.guest.phone) {
      if (!ctx.settings.guestAppUrl) texted = "not_sent";
      else {
        try {
          await queueText(
            c,
            input.venueId,
            {
              templateKey: "room_code",
              to: input.guest.phone,
              params: { room: room.name, code, link: `${ctx.settings.guestAppUrl}/r/${hostToken}` },
              guestId: input.guest.id,
              context: { kind: "session", id: sessionId },
              sentBy: input.userId,
              now: input.start,
            },
            ctx.settings.texts,
          );
          texted = "queued";
        } catch (e) {
          // A text that can't go (Guest texts off, a number outside +1) never blocks seating the party.
          if (!(e instanceof ApiError)) throw e;
          texted = "not_sent";
        }
      }
    }
    await emitEvent(c, {
      venueId: input.venueId,
      type: "room.updated",
      entityId: room.id,
      entityVersion: 0,
    });
    await emitEvent(c, {
      venueId: input.venueId,
      type: "check.updated",
      entityId: checkId,
      entityVersion: 0,
    });
    return {
      session_id: sessionId,
      check_id: checkId,
      check_number: number,
      room_id: room.id,
      room_name: room.name,
      room_code: code,
      billable_guests: rate.billableGuests,
      hourly_cents: rate.hourlyCents,
      ids_checked: input.idsChecked,
      text: texted,
    };
  });
}

export async function checkIn(
  ctx: Context,
  venueId: string,
  bookingId: string,
  body: {
    party_size: number;
    ids_checked: number;
    room_id?: string | undefined;
    start_at?: string | undefined;
  },
  userId: string,
) {
  const now = ctx.clock.now();
  const found = await withVenue(ctx.pool, { venueId }, async (c) => {
    const booking = await bookingById(c, venueId, bookingId);
    if (!booking) throw new ApiError("not_found", "no such booking");
    if (booking.status !== "confirmed" && booking.status !== "pending")
      throw new ApiError(
        "invalid_request",
        `a ${booking.status.replace("_", " ")} booking can't be checked in`,
      );
    const block = await c.query<{ id: string }>(
      "select id from room_blocks where venue_id = $1 and ref_id = $2 and kind in ('booking', 'hold')",
      [venueId, bookingId],
    );
    const guest = await c.query<{ phone_e164: string | null }>(
      "select phone_e164 from guests where venue_id = $1 and id = $2",
      [venueId, booking.guest_id],
    );
    return {
      booking,
      blockId: block.rows[0]?.id ?? null,
      phone: guest.rows[0]?.phone_e164 ?? null,
    };
  });
  if (body.ids_checked > body.party_size)
    throw new ApiError("invalid_request", "more IDs checked than guests");
  // The clock starts now, or at the booked time when staff choose it (never in the future).
  const booked = Temporal.Instant.from(found.booking.starts_at);
  const start = body.start_at === "booked" ? booked : now;
  if (Temporal.Instant.compare(start, now) > 0)
    throw new ApiError("invalid_request", "the clock can't start in the future");
  const plannedEnd = Temporal.Instant.from(found.booking.ends_at);
  const seated = await seat(ctx, {
    venueId,
    roomId: body.room_id ?? found.booking.room_id,
    partySize: body.party_size,
    idsChecked: body.ids_checked,
    start: start.round({ smallestUnit: "minute", roundingMode: "floor" }),
    plannedEnd:
      Temporal.Instant.compare(plannedEnd, now) > 0 ? plannedEnd : now.add({ minutes: 60 }),
    bookingId,
    bookingBlockId: found.blockId,
    guest: { id: found.booking.guest_id, phone: found.phone },
    userId,
  });
  await withVenue(ctx.pool, { venueId, userId }, async (c) => {
    const room = (await listRooms(c, venueId)).find((r) => r.id === seated.room_id)!;
    await updateBooking(c, venueId, bookingId, {
      status: "checked_in",
      ...(room.id !== found.booking.room_id ? { roomId: room.id, sizeTier: room.size_tier } : {}),
      partySize: body.party_size,
    });
    await emitEvent(c, { venueId, type: "booking.updated", entityId: bookingId, entityVersion: 0 });
  });
  return { ...seated, deposit_cents: found.booking.deposit_cents };
}

export async function seatWalkIn(
  ctx: Context,
  venueId: string,
  roomId: string,
  body: {
    party_size: number;
    ids_checked: number;
    minutes: number;
    guest?: { name: string; phone_e164?: string | null | undefined } | undefined;
    /** A waitlist offer's hold in the room (M2-26): released as the session takes the room. */
    holdBlockId?: string | null;
  },
  userId: string,
) {
  const now = ctx.clock.now().round({ smallestUnit: "minute", roundingMode: "floor" });
  if (body.ids_checked > body.party_size)
    throw new ApiError("invalid_request", "more IDs checked than guests");
  const guest = body.guest
    ? await withVenue(ctx.pool, { venueId }, async (c) => ({
        id: await findOrCreateGuest(c, venueId, {
          name: body.guest!.name,
          phoneE164: body.guest!.phone_e164 ?? null,
        }),
        phone: body.guest!.phone_e164 ?? null,
      }))
    : { id: null, phone: null };
  return seat(ctx, {
    venueId,
    roomId,
    partySize: body.party_size,
    idsChecked: body.ids_checked,
    start: now,
    plannedEnd: now.add({ minutes: body.minutes }),
    bookingId: null,
    bookingBlockId: body.holdBlockId ?? null,
    guest,
    userId,
  });
}

export async function markNoShow(ctx: Context, venueId: string, bookingId: string, userId: string) {
  const now = ctx.clock.now();
  return withVenue(ctx.pool, { venueId, userId }, async (c) => {
    const booking = await bookingById(c, venueId, bookingId);
    if (!booking) throw new ApiError("not_found", "no such booking");
    if (booking.status !== "confirmed" && booking.status !== "pending")
      throw new ApiError(
        "invalid_request",
        `a ${booking.status.replace("_", " ")} booking can't be marked a no-show`,
      );
    const { graceMin } = await priceContext(c, venueId, now);
    const from = noShowFrom(booking.starts_at, graceMin, booking.running_late_until);
    if (Temporal.Instant.compare(now, from) < 0)
      throw new ApiError("invalid_request", "not yet: the party still has its grace", {
        details: { reason: "too_early", from: from.toString() },
      });
    const block = await c.query<{ id: string }>(
      "select id from room_blocks where venue_id = $1 and ref_id = $2 and kind in ('booking', 'hold')",
      [venueId, bookingId],
    );
    for (const b of block.rows) await releaseBlock(c, b.id);
    await updateBooking(c, venueId, bookingId, { status: "no_show" });
    await emitEvent(c, { venueId, type: "booking.updated", entityId: bookingId, entityVersion: 0 });
    await emitEvent(c, {
      venueId,
      type: "room.updated",
      entityId: booking.room_id,
      entityVersion: 0,
    });
    return { booking: await bookingById(c, venueId, bookingId) };
  });
}
