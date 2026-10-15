import { createHash, randomBytes, randomInt } from "node:crypto";
import type pg from "pg";
import {
  addBlock,
  addVisualChecks,
  bookingById,
  emitEvent,
  applyDeposits,
  heldDeposits,
  findOrCreateGuest,
  insertCheck,
  listRooms,
  moduleOn,
  nextCheckNumber,
  readSetting,
  releaseBlock,
  RoomNotFree,
  setRoomState,
  updateBooking,
  withVenue,
  type Queryable,
} from "@west4/db";
import {
  businessDate,
  minSpendFor,
  prepaidBlockCents,
  rateAt,
  type RoomForRate,
} from "@west4/rules";
import { Temporal, cents, walkInTakesOf, type Clock } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { noShowMoney } from "../bookings/cancel.js";
import { queueText, venueTexts } from "../texts/queue.js";
import type { VenueTextSettings } from "../texts/venue.js";
import { sealRoomCode } from "./room-code.js";
import { availability, venueClock } from "./assignment.js";
import { pickOfferRoom } from "./waitlist.js";
import { emailRoomQr, printRoomQr } from "./room-qr.js";
import type { EmailSettings } from "../email/settings.js";
import { AlcoholRefused, logRefused } from "../orders/alcohol.js";
import { packageForStart, sellPackageAtStart } from "../routes/package-sales.js";

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
  /** Who the API may email (the room QR to the host, F-07); absent: every address. */
  readonly email?: Pick<EmailSettings, "allowList">;
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
  return {
    venue,
    date,
    prices: prices.value,
    graceMin: deposit?.value.graceMin ?? 15,
    bigParty: deposit?.value.bigParty ?? null,
    walkIn: walkInTakesOf(deposit?.value),
  };
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

/** Why a room can't take the party right now (U-09): the sheet greys its chip with this. */
export type RoomChoiceWhy = "too_small" | "in_use" | "cleaning" | "held" | "out_of_service";

/** One room chip on the check-in sheet (U-09): its size, and whether it can take the party now. */
export interface RoomChoice {
  readonly room_id: string;
  readonly name: string;
  readonly capacity_min: number;
  readonly capacity_max: number;
  readonly ok: boolean;
  readonly why: RoomChoiceWhy | null;
  /** Free until the next block's start (null: free all night, or not free). */
  readonly until: string | null;
}

/**
 * Every room for the check-in sheet's picker (U-09; spec 10 · Check in): the board's own
 * availability (free now, in use, held, being cleaned, out of service) and the seat rule (a party
 * bigger than the room's capacity is refused), so the screen decides nothing itself. A booking's
 * own room, held for it, counts as free for that booking.
 */
async function roomChoices(
  c: Queryable,
  venueId: string,
  party: number,
  now: Temporal.Instant,
  bookingId: string | null,
): Promise<RoomChoice[]> {
  const avail = await availability(c, venueId, now);
  const rooms = await listRooms(c, venueId);
  const out: RoomChoice[] = [];
  for (const a of avail.rooms) {
    const room = rooms.find((r) => r.id === a.room_id);
    if (!room) continue;
    const own =
      bookingId !== null && a.current?.kind === "booking" && a.current.ref_id === bookingId;
    const why: RoomChoiceWhy | null =
      room.state === "out_of_service" || a.current?.kind === "out_of_service"
        ? "out_of_service"
        : !(a.free_now || own)
          ? a.current?.kind === "session"
            ? "in_use"
            : a.current?.kind === "cleaning" || a.state === "cleaning"
              ? "cleaning"
              : a.current
                ? "held"
                : "in_use"
          : party > room.capacity_max
            ? "too_small"
            : null;
    out.push({
      room_id: room.id,
      name: room.name,
      capacity_min: room.capacity_min,
      capacity_max: room.capacity_max,
      ok: why === null,
      why,
      until: why === null && !a.all_night ? a.until : null,
    });
  }
  return out;
}

/** What the sheet shows before anyone presses Check in. */
export async function checkInPreview(
  c: Queryable,
  venueId: string,
  input: { bookingId?: string; roomId?: string; partySize?: number; walkIn?: boolean },
  now: Temporal.Instant,
  opts: { guestAppUrl?: string | null } = {},
) {
  const booking = input.bookingId ? await bookingById(c, venueId, input.bookingId) : null;
  if (input.bookingId && !booking) throw new ApiError("not_found", "no such booking");
  const rooms = await listRooms(c, venueId);
  // + Walk-in from the board's header (U-09): no room yet, so the smallest free room that fits
  // the party, exactly as the waitlist's Offer picks one. The party starts at the smallest
  // room's usual party until staff tap theirs.
  const chooseRoom = !booking && !input.roomId && input.walkIn === true;
  const live = rooms.filter((r) => r.state !== "out_of_service");
  const usual = Math.min(...(live.length ? live : rooms).map((r) => r.capacity_min));
  const suggested = chooseRoom
    ? await pickOfferRoom(c, venueId, input.partySize ?? usual, now)
    : null;
  const roomId = chooseRoom ? (suggested?.id ?? null) : (input.roomId ?? booking?.room_id);
  const found = rooms.find((r) => r.id === roomId);
  if (!found && !chooseRoom) throw new ApiError("not_found", "no such room");
  // Nothing free fits: the sheet says so; the rate lines read from the biggest room meanwhile.
  const room = found ?? [...rooms].sort((a, b) => b.capacity_max - a.capacity_max)[0];
  if (!room) throw new ApiError("not_found", "no such room");
  const party = input.partySize ?? booking?.party_size ?? (chooseRoom ? usual : room.capacity_min);
  const ctx = await priceContext(c, venueId, now);
  const rate = rateAt(now, party, room as RoomForRate, ctx.prices, ctx.venue);
  const choices = await roomChoices(c, venueId, party, now, booking?.id ?? null);
  const friSat = ctx.date.dayOfWeek === 5 || ctx.date.dayOfWeek === 6;
  // What seating sends (D128), so the sheet's last line says what will happen: the room code text
  // (when the host gives a phone) and the room's QR slip and email (while Ordering from the room is on).
  const appUrl = opts.guestAppUrl ?? null;
  const [texts, qr] = appUrl
    ? await Promise.all([
        venueTexts(c, venueId, "room_code"),
        moduleOn(c, venueId, "room_ordering"),
      ])
    : [false, false];
  const from = booking
    ? noShowFrom(booking.starts_at, ctx.graceMin, booking.running_late_until)
    : null;
  // The deposit the sheet applies (M4-09): the booking's captured deposit payments, once they exist
  // as payments (online booking, M5; the seed's, M4-10); until then the booking's own figure.
  // A deposit partly refunded (M5-11: a smaller party before the cut-off) counts what's left.
  const held = booking ? await heldDeposits(c, venueId, booking.id) : [];
  const paid =
    held.length > 0
      ? { cents: String(held.reduce((s, p) => s + p.held_cents, 0)), n: held.length }
      : undefined;
  return {
    booking_id: booking?.id ?? null,
    guest_name: booking?.guest_name ?? null,
    party_size: party,
    min_guests: rate.minGuests,
    billable_guests: rate.billableGuests,
    /** "weeknight" or "fri_sat": which minimum, and the day word the sheet uses. */
    min_day: friSat ? (ctx.date.dayOfWeek === 5 ? "friday" : "saturday") : "weeknight",
    /** The same minimum every day of the week (D128: Sing Sing's 3): the line drops the day word. */
    min_every_day: ctx.prices.minGuests.weeknight === ctx.prices.minGuests.friSat,
    /** What seating sends (D128): a text when the host gives a phone, the QR slip and its email. */
    sends: { text: texts, qr },
    /** A booking's guest has a phone on file (the code text goes to it); null for a walk-in. */
    host_phone: booking ? booking.guest_phone !== null : null,
    hourly_cents: rate.hourlyCents,
    room_id: found ? room.id : null,
    room_name: found ? room.name : null,
    room_fits: found ? party <= room.capacity_max : false,
    /** Every room as a chip (U-09): its size, and why it can't take the party now. */
    rooms: choices,
    /** + Walk-in's pick (U-09): the smallest free room that fits, as the waitlist's Offer; else null. */
    suggested_room_id: suggested?.id ?? null,
    deposit_cents: paid && paid.n > 0 ? Number(paid.cents) : (booking?.deposit_cents ?? 0),
    booked_start: booking?.starts_at ?? null,
    booked_end: booking?.ends_at ?? null,
    no_show_from: from?.toString() ?? null,
    can_no_show: from ? Temporal.Instant.compare(now, from) >= 0 : false,
    /**
     * What a walk-in's step 5 takes (D112; Admin → Deposits & cancelling): "deposit" (today's
     * line), "cardOnTab" (a card tapped onto the room's check once it's seated, nothing
     * charged) or "nothing". A booking keeps its own deposit, whatever this says.
     */
    walk_in: booking ? null : ctx.walkIn,
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
  /**
   * A practice session (training mode, M7-03; cautious default in the ticket's notes): on a free
   * room, it writes no room_blocks and no room_states, texts nobody, and only screens in training
   * see it. Its check is numbered T-… from its own counter.
   */
  readonly training?: boolean;
  /** Starting a room (P-04): a note shown on the tile and at close-out. */
  readonly note?: string | null;
  /**
   * A prepaid block (P-04; spec 05 · rule 3): its minutes, billed at least at the room's rate, or
   * as the room-time share of the package it starts with. Null is pay as you go.
   */
  readonly prepaid?: { readonly minutes: number; readonly packageId: string | null } | null;
  /** Who's seating them, for the package's staff order. */
  readonly staff?: { readonly membershipId: string; readonly deviceId: string | null } | null;
}

/**
 * Seats a party: the session and its first segment, the session's block (the
 * booking's own block turns into it, or a new one when the room changed), the
 * room in use, the check with its number (taken first, in its own short
 * transaction), and the Room code text to the host. A room that doesn't fit
 * or isn't free answers 409 room_not_free. A package it starts with is sold
 * on the check in the same transaction; an alcohol refusal seats nobody and
 * is logged.
 */
async function seat(ctx: Context, input: SeatInput) {
  try {
    return await seatOnce(ctx, input);
  } catch (e) {
    if (e instanceof AlcoholRefused)
      await withVenue(ctx.pool, { venueId: input.venueId }, (c) =>
        logRefused(c, input.venueId, e.refused),
      );
    throw e;
  }
}

async function seatOnce(ctx: Context, input: SeatInput) {
  const training = input.training ?? false;
  const number = await nextCheckNumber(ctx.pool, input.venueId, { training });
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
    // A practice session takes only a free room, and never stops a live party taking it.
    if (training && room.state !== "available")
      throw new ApiError("room_not_free", "practice on a free room", {
        details: { reason: "in_use" },
      });
    const open = await c.query(
      `select 1 from room_sessions where venue_id = $1 and room_id = $2 and ended_at is null
          and (training = $3 or not training)`,
      [input.venueId, room.id, training],
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
    // A minimum spend, where a venue sets one (Money rules 6; M4-27; off at West 4): the big-party
    // rule's when it applies, otherwise the prices row for this room's tier, night and band.
    const minSpend = minSpendFor({
      rows: priced.prices.minSpend,
      tier: room.size_tier,
      day: priced.date.dayOfWeek % 7,
      band: rate.bandId,
      partySize: input.partySize,
      bigParty: priced.bigParty,
    });
    // A prepaid block's regular price: its minutes at the room's rate as the room starts (P-04).
    const blockRegular = input.prepaid
      ? prepaidBlockCents(input.prepaid.minutes, cents(rate.hourlyCents))
      : null;
    const sessionId = (
      await c.query<{ id: string }>(
        `insert into room_sessions (venue_id, room_id, booking_id, party_size, started_at, booked_end_at, business_date,
           server_user_id, room_code_hash, token_version, host_token_hash, guest_id, room_code_enc, host_lock, min_spend_cents,
           training, note, prepaid_minutes, prepaid_cents, package_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id`,
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
          input.guest.id,
          sealRoomCode(code),
          // A new session starts with the host lock on or off as the venue sets it (M3-10).
          (await readSetting(c, input.venueId, "ordering", priced.date))?.value.hostLockDefault ??
            false,
          minSpend,
          training,
          input.note?.trim() || null,
          input.prepaid?.minutes ?? null,
          // A package's share is set once it's sold, below.
          input.prepaid ? (input.prepaid.packageId ? 0 : blockRegular) : null,
          input.prepaid?.packageId ?? null,
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
    if (!training)
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
    if (!training)
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
      training,
    });
    await c.query("update room_sessions set check_id = $3 where venue_id = $1 and id = $2", [
      input.venueId,
      sessionId,
      checkId,
    ]);
    // The booking's deposit goes onto the check now (M4-09): before this it was money held for the guest.
    const depositApplied = input.bookingId
      ? await applyDeposits(c, input.venueId, { bookingId: input.bookingId, checkId })
      : 0;
    // The package it starts with (P-04): on the tab now, its room-time share the prepaid block.
    if (input.prepaid?.packageId) {
      if (!input.staff) throw new ApiError("forbidden", "a package is a person's sale");
      await sellPackageAtStart(c, input.venueId, {
        packageId: input.prepaid.packageId,
        checkId,
        sessionId,
        blockRegularCents: blockRegular!,
        userId: input.userId,
        membershipId: input.staff.membershipId,
        deviceId: input.staff.deviceId,
        now: input.start,
      });
    }

    // The Room code text, to the host, with the join link that carries the host token.
    let texted: "queued" | "no_phone" | "not_sent" = "no_phone";
    if (input.guest.phone && !training) {
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
    // The room's join QR (F-07; D124): a slip on the front desk's printer and, when the host's email
    // is known, an email, while Ordering from the room is on. Neither ever blocks seating the party.
    const slip = await printRoomQr(c, input.venueId, sessionId, {
      now: input.start,
      guestAppUrl: ctx.settings.guestAppUrl,
    });
    const qrEmail = await emailRoomQr(c, input.venueId, sessionId, {
      now: input.start,
      guestAppUrl: ctx.settings.guestAppUrl,
      email: ctx.settings.email ?? { allowList: null },
    });
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
      qr: { printed: slip !== null, emailed: qrEmail?.to ?? null },
      session_id: sessionId,
      check_id: checkId,
      check_number: number,
      /** A practice session's check (M7-03): shown as T-0012. */
      training,
      room_id: room.id,
      room_name: room.name,
      room_code: code,
      billable_guests: rate.billableGuests,
      hourly_cents: rate.hourlyCents,
      ids_checked: input.idsChecked,
      text: texted,
      deposit_applied_cents: depositApplied,
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
    note?: string | null | undefined;
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
    note: body.note ?? null,
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
    guest?:
      | { name: string; phone_e164?: string | null | undefined; email?: string | null | undefined }
      | undefined;
    /** A waitlist offer's hold in the room (M2-26): released as the session takes the room. */
    holdBlockId?: string | null;
    /** Starting a room (P-04): a note, pay as you go (the default) or a prepaid block, a package. */
    note?: string | null | undefined;
    time?: "pay_as_you_go" | "prepaid" | undefined;
    package_id?: string | undefined;
  },
  userId: string,
  training = false,
  staff: { membershipId: string; deviceId: string | null } | null = null,
) {
  const now = ctx.clock.now().round({ smallestUnit: "minute", roundingMode: "floor" });
  if (body.ids_checked > body.party_size)
    throw new ApiError("invalid_request", "more IDs checked than guests");
  // A package with a length sets the room's time and is a prepaid block (P-04). Packages &
  // specials must be on: a switched-off feature is refused here, not just hidden.
  let minutes = body.minutes;
  let prepaid: { minutes: number; packageId: string | null } | null =
    body.time === "prepaid" ? { minutes, packageId: null } : null;
  if (body.package_id) {
    const pkg = await withVenue(ctx.pool, { venueId }, async (c) => {
      if (!(await moduleOn(c, venueId, "packages")))
        throw new ApiError("module_off", "Packages & specials is off at this venue");
      return packageForStart(c, venueId, body.package_id!, ctx.clock.now());
    });
    minutes = pkg.minutes;
    prepaid = { minutes, packageId: pkg.id };
  }
  // A practice walk-in writes no guest record: practice never reaches a real guest.
  const guest =
    body.guest && !training
      ? await withVenue(ctx.pool, { venueId }, async (c) => ({
          id: await findOrCreateGuest(c, venueId, {
            name: body.guest!.name,
            phoneE164: body.guest!.phone_e164 ?? null,
            email: body.guest!.email ?? null,
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
    plannedEnd: now.add({ minutes }),
    bookingId: null,
    bookingBlockId: training ? null : (body.holdBlockId ?? null),
    guest,
    userId,
    training,
    note: body.note ?? null,
    prepaid,
    staff,
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
    // The deposit by the accepted policy (M5-12): kept, charged up to the first hour, or refunded.
    const money = await noShowMoney(c, venueId, bookingId, userId, now);
    await emitEvent(c, { venueId, type: "booking.updated", entityId: bookingId, entityVersion: 0 });
    await emitEvent(c, {
      venueId,
      type: "room.updated",
      entityId: booking.room_id,
      entityVersion: 0,
    });
    return {
      booking: await bookingById(c, venueId, bookingId),
      deposit: {
        refund_cents: money.refundCents,
        kept_cents: money.keptCents,
        charge_cents: money.chargeCents,
      },
    };
  });
}
