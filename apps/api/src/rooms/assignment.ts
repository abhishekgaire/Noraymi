import {
  addBlock,
  blockById,
  blocksBetween,
  openFaults,
  roomNotes,
  closureOn,
  emitEvent,
  listRooms,
  moveBlock,
  readSetting,
  RoomNotFree,
  setBlockEnd,
  type BlockRow,
  type Queryable,
} from "@west4/db";
import {
  businessDate,
  canExtend,
  chooseRoom,
  freeRoomsFor,
  freeUntil,
  hoursFor,
  type BlockSpan,
  type RoomForAssignment,
} from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { cleaningStatus } from "./cleaning.js";

/**
 * Room assignment and availability for one venue (M2-05; spec 04 · Room
 * assignment). Runs inside the venue's transaction; the rules are pure
 * (`@west4/rules`), and the exclusion constraint has the last word.
 */
export interface VenueClock {
  readonly timeZone: string;
  readonly dayCutover: string;
}

export interface Night {
  readonly businessDate: Temporal.PlainDate;
  /** The night's close, or null when it has no hours (closed). */
  readonly close: Temporal.Instant | null;
}

export async function venueClock(c: Queryable, venueId: string): Promise<VenueClock> {
  const r = await c.query<{ time_zone: string; day_cutover: string }>(
    "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
    [venueId],
  );
  if (!r.rows[0]) throw new ApiError("not_found", "no such venue");
  return { timeZone: r.rows[0].time_zone, dayCutover: r.rows[0].day_cutover };
}

/** The business date an instant belongs to, and that night's close (M1-12). */
export async function nightOf(
  c: Queryable,
  venueId: string,
  venue: VenueClock,
  at: Temporal.Instant,
): Promise<Night> {
  const date = businessDate(at, venue.timeZone, venue.dayCutover).businessDate;
  const [hours, closure] = await Promise.all([
    readSetting(c, venueId, "hours", date),
    closureOn(c, venueId, date.toString()),
  ]);
  if (!hours) return { businessDate: date, close: null };
  const h = hoursFor(
    { timeZone: venue.timeZone, dayCutover: venue.dayCutover },
    date,
    hours.value,
    closure,
  );
  return { businessDate: date, close: h.closed ? null : h.closes };
}

interface Settings {
  readonly cleaningMin: number;
  readonly noticeMin: number;
  readonly graceMin: number;
}

async function settingsOn(
  c: Queryable,
  venueId: string,
  date: Temporal.PlainDate,
): Promise<Settings> {
  const [rooms, alerts, deposit] = await Promise.all([
    readSetting(c, venueId, "rooms", date),
    readSetting(c, venueId, "alerts", date),
    readSetting(c, venueId, "deposit", date),
  ]);
  return {
    cleaningMin: rooms?.value.cleaningMin ?? 0,
    noticeMin: alerts?.value.roomEndingMin ?? 10,
    graceMin: deposit?.value.graceMin ?? 15,
  };
}

/** A block as the rules see it. Open-ended blocks (out of service) last until staff end them. */
const spanWithin =
  (_night: Night, _venue: VenueClock) =>
  (b: BlockRow): BlockSpan => ({
    roomId: b.room_id,
    from: Temporal.Instant.from(b.starts_at),
    to: b.ends_at === null ? null : Temporal.Instant.from(b.ends_at),
  });

/** The venue's live rooms, as assignment sees them; a room out of service isn't available. */
async function roomsForAssignment(c: Queryable, venueId: string, cleaningMin: number) {
  const rooms = await listRooms(c, venueId);
  return rooms.map((r): RoomForAssignment & { readonly state: string } => ({
    id: r.id,
    name: r.name,
    capacityMin: r.capacity_min,
    capacityMax: r.capacity_max,
    cleaningMin: r.cleaning_min ?? cleaningMin,
    available: r.state !== "out_of_service",
    state: r.state,
  }));
}

const iso = (raw: string | null): string | null =>
  raw === null ? null : Temporal.Instant.from(raw).toString();

export interface RoomAvailability {
  readonly room_id: string;
  readonly name: string;
  readonly state: string;
  readonly free_now: boolean;
  /** Free now: until the next block starts, or the close when `all_night`. Busy: until the current block ends (null: until staff end it). */
  readonly until: string | null;
  readonly all_night: boolean;
  readonly current: { kind: string; ref_id: string | null; held_until: string | null } | null;
  readonly next: { kind: string; ref_id: string | null; at: string } | null;
  /** Open faults, shown on the tile (M2-16). */
  readonly faults: { id: string; text: string; reported_at: string; out_of_service: boolean }[];
  /** The room's tablet is off while the room is out of service (M2-16). */
  readonly tablet_on: boolean;
  /** "Needs a wipe · left 10:33 PM (8 min)", flagged after rooms.cleaningFlagMin (M2-19). */
  readonly cleaning: { left_at: string; minutes: number; flagged: boolean } | null;
  /** Notes that stay with the room (M2-19). */
  readonly notes: { id: string; text: string }[];
}

/** Every live room at an instant: free or not, until when, and what's in it or next (the board's "free until"). */
export async function availability(c: Queryable, venueId: string, at: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const night = await nightOf(c, venueId, venue, at);
  const settings = await settingsOn(c, venueId, night.businessDate);
  const rooms = await roomsForAssignment(c, venueId, settings.cleaningMin);
  const blocks = await blocksBetween(
    c,
    venueId,
    at.subtract({ hours: 24 }),
    night.close && Temporal.Instant.compare(night.close, at) > 0
      ? night.close
      : at.add({ hours: 24 }),
  );
  const spans = blocks.map(spanWithin(night, venue));
  const faults = await openFaults(c, venueId);
  const notes = await roomNotes(c, venueId);
  const cleaning = await cleaningStatus(c, venueId, at);
  const out: RoomAvailability[] = rooms.map((room) => {
    const mine = blocks.filter((b) => b.room_id === room.id);
    const f = freeUntil(room.id, spans, at);
    const current = mine.find(
      (b) =>
        Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), at) <= 0 &&
        (b.ends_at === null || Temporal.Instant.compare(at, Temporal.Instant.from(b.ends_at)) < 0),
    );
    const next = mine.find(
      (b) => Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), at) > 0,
    );
    // A room still being cleaned isn't free now, though its later bookings stand (M2-19).
    const freeNow = f.freeNow && room.available && room.state !== "cleaning";
    return {
      room_id: room.id,
      name: room.name,
      state: room.state,
      free_now: freeNow,
      until: freeNow
        ? ((f.until ?? night.close)?.toString() ?? null)
        : (f.until?.toString() ?? null),
      all_night: freeNow && f.until === null,
      current: current
        ? {
            kind: current.kind,
            ref_id: current.ref_id,
            // A booking whose party hasn't arrived is held for them until the grace runs out.
            held_until:
              current.kind === "booking"
                ? Temporal.Instant.from(current.starts_at)
                    .add({ minutes: settings.graceMin })
                    .toString()
                : current.kind === "hold"
                  ? iso(current.expires_at)
                  : null,
          }
        : room.state === "cleaning"
          ? { kind: "cleaning", ref_id: null, held_until: null }
          : null,
      next: next ? { kind: next.kind, ref_id: next.ref_id, at: iso(next.starts_at)! } : null,
      faults: faults
        .filter((f) => f.room_id === room.id)
        .map((f) => ({
          id: f.id,
          text: f.text,
          reported_at: f.reported_at,
          out_of_service: f.out_of_service,
        })),
      tablet_on: room.state !== "out_of_service",
      cleaning: cleaning.get(room.id) ?? null,
      notes: notes.filter((n) => n.room_id === room.id).map((n) => ({ id: n.id, text: n.text })),
    };
  });
  return {
    at: at.toString(),
    business_date: night.businessDate.toString(),
    close: night.close?.toString() ?? null,
    rooms: out,
  };
}

/** Rooms that fit a party and are free for [from, to) plus cleaning, in assignment order (moves, offers). */
export async function freeFor(
  c: Queryable,
  venueId: string,
  input: {
    party: number;
    from: Temporal.Instant;
    to: Temporal.Instant;
    /** From now on, a room still being cleaned isn't offered (M2-19). */
    now?: Temporal.Instant;
  },
) {
  const venue = await venueClock(c, venueId);
  const night = await nightOf(c, venueId, venue, input.from);
  const settings = await settingsOn(c, venueId, night.businessDate);
  const startsNow = input.now !== undefined && Temporal.Instant.compare(input.from, input.now) <= 0;
  const rooms = (await roomsForAssignment(c, venueId, settings.cleaningMin)).filter(
    (r) => !(startsNow && r.state === "cleaning"),
  );
  const blocks = await blocksBetween(
    c,
    venueId,
    input.from.subtract({ hours: 24 }),
    input.to.add({ hours: 24 }),
  );
  const pastClose = night.close !== null && Temporal.Instant.compare(input.to, night.close) > 0;
  return {
    close: night.close?.toString() ?? null,
    past_close: pastClose,
    rooms: pastClose
      ? []
      : freeRoomsFor(
          rooms,
          blocks.map(spanWithin(night, venue)),
          input.party,
          input.from,
          input.to,
        ).map((r) => ({
          room_id: r.id,
          name: r.name,
        })),
  };
}

/**
 * Gives a booking a real room and writes its block (time plus cleaning).
 * Refuses a booking that ends after the night's close, or when nothing fits.
 * A race lost to the exclusion constraint tries the next room.
 */
export async function assignBooking(
  c: Queryable,
  venueId: string,
  input: {
    party: number;
    from: Temporal.Instant;
    to: Temporal.Instant;
    refId: string | null;
    kind?: "booking" | "hold";
    expiresAt?: Temporal.Instant | null;
  },
): Promise<BlockRow> {
  const venue = await venueClock(c, venueId);
  const night = await nightOf(c, venueId, venue, input.from);
  const settings = await settingsOn(c, venueId, night.businessDate);
  const rooms = await roomsForAssignment(c, venueId, settings.cleaningMin);
  const blocks = (
    await blocksBetween(c, venueId, input.from.subtract({ hours: 24 }), input.to.add({ hours: 24 }))
  ).map(spanWithin(night, venue));
  const choice = chooseRoom(rooms, blocks, input.party, input.from, input.to, night.close);
  if ("refused" in choice)
    throw new ApiError(
      choice.refused === "past_close" ? "invalid_request" : "room_not_free",
      choice.refused === "past_close"
        ? "a booking must end by the night's close"
        : "no room fits this party at that time",
      { details: { reason: choice.refused } },
    );
  for (const room of freeRoomsFor(rooms, blocks, input.party, input.from, input.to)) {
    // A lost race leaves the transaction usable through a savepoint, then tries the next room.
    await c.query("savepoint assign_room");
    try {
      const block = await addBlock(c, {
        venueId,
        roomId: room.id,
        kind: input.kind ?? "booking",
        from: input.from,
        to: input.to.add({ minutes: room.cleaningMin }),
        refId: input.refId,
        expiresAt: input.expiresAt ?? null,
      });
      await emitEvent(c, { venueId, type: "room.updated", entityId: room.id, entityVersion: 0 });
      return block;
    } catch (e) {
      if (!(e instanceof RoomNotFree)) throw e;
      await c.query("rollback to savepoint assign_room");
    }
  }
  throw new ApiError("room_not_free", "no room fits this party at that time", {
    details: { reason: "no_room" },
  });
}

/** A session past its booked end extends 15 minutes, only while nothing is booked next. */
export async function extendSession(c: Queryable, venueId: string, blockId: string) {
  const block = await blockById(c, venueId, blockId);
  if (!block || block.kind !== "session" || block.ends_at === null)
    throw new ApiError("not_found", "no such session block");
  const venue = await venueClock(c, venueId);
  const end = Temporal.Instant.from(block.ends_at);
  const night = await nightOf(c, venueId, venue, Temporal.Instant.from(block.starts_at));
  const settings = await settingsOn(c, venueId, night.businessDate);
  const room = (await roomsForAssignment(c, venueId, settings.cleaningMin)).find(
    (r) => r.id === block.room_id,
  );
  const next = (await blocksBetween(c, venueId, end, null)).find(
    (b) =>
      b.room_id === block.room_id &&
      b.id !== block.id &&
      Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), end) >= 0,
  );
  const verdict = canExtend(
    end,
    next ? Temporal.Instant.from(next.starts_at) : null,
    settings.noticeMin,
    room?.cleaningMin ?? settings.cleaningMin,
    night.close,
  );
  if (!verdict.ok)
    throw new ApiError(
      "room_not_free",
      verdict.why === "booked_next" ? "the room is booked next" : "the night closes first",
      {
        details: { reason: verdict.why },
      },
    );
  const updated = await setBlockEnd(c, venueId, blockId, verdict.to);
  await emitEvent(c, { venueId, type: "room.updated", entityId: block.room_id, entityVersion: 0 });
  return updated!;
}

/** The night's opening and close, for the booking grid. */
export async function nightHours(
  c: Queryable,
  venueId: string,
  venue: VenueClock,
  date: Temporal.PlainDate,
) {
  const [hours, closure] = await Promise.all([
    readSetting(c, venueId, "hours", date),
    closureOn(c, venueId, date.toString()),
  ]);
  if (!hours) return null;
  const h = hoursFor(
    { timeZone: venue.timeZone, dayCutover: venue.dayCutover },
    date,
    hours.value,
    closure,
  );
  return h.closed || !h.opens || !h.closes ? null : { opens: h.opens, closes: h.closes };
}

/**
 * A room switched off, out of service or archived (M2-04 hook): each of its
 * future bookings moves to the smallest free room that fits, largest parties
 * first; any that can't move stay and are listed for a manager.
 */
export async function reassignFutureBookings(
  c: Queryable,
  venueId: string,
  roomId: string,
  now: Temporal.Instant,
) {
  const venue = await venueClock(c, venueId);
  const night = await nightOf(c, venueId, venue, now);
  const settings = await settingsOn(c, venueId, night.businessDate);
  const rooms = (await roomsForAssignment(c, venueId, settings.cleaningMin)).filter(
    (r) => r.id !== roomId,
  );
  const future = await c.query<{
    block_id: string;
    booking_id: string;
    party: number;
    starts_at: string;
    ends_at: string;
  }>(
    `select rb.id as block_id, b.id as booking_id, b.party_size as party,
            to_json(b.starts_at) #>> '{}' as starts_at, to_json(b.ends_at) #>> '{}' as ends_at
       from room_blocks rb join bookings b on b.venue_id = rb.venue_id and b.id = rb.ref_id
      where rb.venue_id = $1 and rb.room_id = $2 and rb.kind in ('booking', 'hold')
        and lower(rb.period) >= $3::timestamptz and b.status in ('pending', 'confirmed')
      order by b.party_size desc, lower(rb.period)`,
    [venueId, roomId, now.toString()],
  );
  const moved: { booking_id: string; to_room_id: string }[] = [];
  const unplaced: { booking_id: string }[] = [];
  for (const f of future.rows) {
    const from = Temporal.Instant.from(f.starts_at);
    const to = Temporal.Instant.from(f.ends_at);
    const blocks = (
      await blocksBetween(c, venueId, from.subtract({ hours: 24 }), to.add({ hours: 24 }))
    ).map(spanWithin(night, venue));
    let placed = false;
    for (const room of freeRoomsFor(rooms, blocks, f.party, from, to)) {
      await c.query("savepoint move_booking");
      try {
        await moveBlock(c, venueId, f.block_id, room.id);
        await c.query(
          "update bookings set room_id = $3, size_tier = (select size_tier from rooms where venue_id = $1 and id = $3) where venue_id = $1 and id = $2",
          [venueId, f.booking_id, room.id],
        );
        await emitEvent(c, {
          venueId,
          type: "booking.updated",
          entityId: f.booking_id,
          entityVersion: 0,
        });
        moved.push({ booking_id: f.booking_id, to_room_id: room.id });
        placed = true;
        break;
      } catch (e) {
        if (!(e instanceof RoomNotFree)) throw e;
        await c.query("rollback to savepoint move_booking");
      }
    }
    if (!placed) unplaced.push({ booking_id: f.booking_id });
  }
  return { moved, unplaced };
}

export type MoveBlocked =
  "too_small" | "out_of_service" | "in_use" | "cleaning" | "held" | "booked_next" | "past_close";

export interface MoveOption {
  readonly room_id: string;
  readonly name: string;
  readonly ok: boolean;
  /** Free until (the next block's start), or null when free all night. */
  readonly until: string | null;
  readonly all_night: boolean;
  readonly why: MoveBlocked | null;
}

/**
 * Where a session can move (M2-18; spec 04 · Room assignment): rooms that fit
 * the party and are free for the time needed. The time needed is the rest of
 * the booked time, or one 15-minute extension step for a party past its end
 * (cautious default, flagged), and the next booking in the room must still
 * get the wrap-up notice plus cleaning, as for an extension.
 */
export async function moveOptions(
  c: Queryable,
  venueId: string,
  session: { roomId: string; partySize: number; bookedEnd: Temporal.Instant | null },
  now: Temporal.Instant,
): Promise<{ needed_until: string; rooms: MoveOption[] }> {
  const venue = await venueClock(c, venueId);
  const night = await nightOf(c, venueId, venue, now);
  const settings = await settingsOn(c, venueId, night.businessDate);
  const rooms = (await roomsForAssignment(c, venueId, settings.cleaningMin)).filter(
    (r) => r.id !== session.roomId,
  );
  const neededUntil =
    session.bookedEnd && Temporal.Instant.compare(session.bookedEnd, now) > 0
      ? session.bookedEnd
      : now.add({ minutes: 15 });
  const blocks = await blocksBetween(c, venueId, now.subtract({ hours: 24 }), null);
  const out = rooms.map((room): MoveOption => {
    const mine = blocks.filter((b) => b.room_id === room.id);
    const current = mine.find(
      (b) =>
        Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), now) <= 0 &&
        (b.ends_at === null || Temporal.Instant.compare(now, Temporal.Instant.from(b.ends_at)) < 0),
    );
    const next = mine
      .map((b) => Temporal.Instant.from(b.starts_at))
      .filter((at) => Temporal.Instant.compare(at, now) > 0)
      .sort(Temporal.Instant.compare)[0];
    const until = next ?? null;
    const base = { room_id: room.id, name: room.name, until: until?.toString() ?? null };
    const no = (why: MoveBlocked): MoveOption => ({ ...base, ok: false, all_night: false, why });
    if (!room.available) return no("out_of_service");
    if (room.capacityMax < session.partySize) return no("too_small");
    if (current)
      return no(
        current.kind === "session"
          ? "in_use"
          : current.kind === "cleaning"
            ? "cleaning"
            : current.kind === "out_of_service"
              ? "out_of_service"
              : "held",
      );
    if (room.state === "cleaning") return no("cleaning");
    if (night.close && Temporal.Instant.compare(neededUntil, night.close) > 0)
      return no("past_close");
    if (
      until &&
      Temporal.Instant.compare(
        neededUntil,
        until.subtract({ minutes: settings.noticeMin + room.cleaningMin }),
      ) > 0
    )
      return no("booked_next");
    const allNight =
      until === null || (night.close !== null && Temporal.Instant.compare(until, night.close) >= 0);
    return {
      ...base,
      until: allNight ? (night.close?.toString() ?? null) : base.until,
      ok: true,
      all_night: allNight,
      why: null,
    };
  });
  return { needed_until: neededUntil.toString(), rooms: out };
}
