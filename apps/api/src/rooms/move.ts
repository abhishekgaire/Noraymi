import {
  addBlock,
  emitEvent,
  listRooms,
  RoomNotFree,
  setBlockEnd,
  setRoomState,
  type Queryable,
} from "@west4/db";
import { rateAt, type RoomForRate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { moveOptions } from "./assignment.js";
import { sendToCleaning } from "./cleaning.js";
import { hashRoomCode, newRoomCode, priceContext } from "./checkin.js";
import { sessionBlock } from "./sessions.js";

/**
 * A room move (M2-18; screens N12; spec 04 · Room assignment; spec 08 · Board
 * and sessions). In one transaction: the segment closes and the next opens in
 * the new room on the minute, the session's block continues there, a new room
 * code is issued and the guests' token rotates so the old code stops working,
 * the old room goes to cleaning until its next booking, and the check stays
 * one check.
 */
async function sessionForMove(c: Queryable, venueId: string, sessionId: string) {
  const s = (
    await c.query<{
      id: string;
      room_id: string;
      party_size: number;
      booked_end_at: string | null;
      ended_at: string | null;
    }>(
      `select id, room_id, party_size, to_json(booked_end_at) #>> '{}' as booked_end_at,
              to_json(ended_at) #>> '{}' as ended_at
         from room_sessions where venue_id = $1 and id = $2 for update`,
      [venueId, sessionId],
    )
  ).rows[0];
  if (!s) throw new ApiError("not_found", "no such session");
  if (s.ended_at) throw new ApiError("invalid_request", "the session has ended");
  return s;
}

export async function sessionMoveOptions(
  c: Queryable,
  venueId: string,
  sessionId: string,
  now: Temporal.Instant,
) {
  const s = await sessionForMove(c, venueId, sessionId);
  return moveOptions(
    c,
    venueId,
    {
      roomId: s.room_id,
      partySize: s.party_size,
      bookedEnd: s.booked_end_at ? Temporal.Instant.from(s.booked_end_at) : null,
    },
    now,
  );
}

export async function moveSession(
  c: Queryable,
  venueId: string,
  sessionId: string,
  input: { roomId: string; now: Temporal.Instant; userId?: string },
) {
  const s = await sessionForMove(c, venueId, sessionId);
  const options = await moveOptions(
    c,
    venueId,
    {
      roomId: s.room_id,
      partySize: s.party_size,
      bookedEnd: s.booked_end_at ? Temporal.Instant.from(s.booked_end_at) : null,
    },
    input.now,
  );
  const option = options.rooms.find((r) => r.room_id === input.roomId);
  if (!option || !option.ok)
    throw new ApiError("room_not_free", "that room isn't free for the time needed", {
      details: { reason: option?.why ?? "no_room" },
    });
  const rooms = await listRooms(c, venueId);
  const from = rooms.find((r) => r.id === s.room_id)!;
  const to = rooms.find((r) => r.id === input.roomId)!;
  const minute = input.now.round({ smallestUnit: "minute", roundingMode: "floor" });
  const at = minute.toString();

  // The clock: the open segment closes and the next opens in the new room, at its rate.
  const seg = (
    await c.query<{ id: string; started_at: string }>(
      `select id, to_json(started_at) #>> '{}' as started_at from session_segments
        where venue_id = $1 and session_id = $2 and ended_at is null order by started_at desc limit 1`,
      [venueId, s.id],
    )
  ).rows[0];
  const priced = await priceContext(c, venueId, minute);
  const rate = rateAt(minute, s.party_size, to as RoomForRate, priced.prices, priced.venue);
  if (seg) {
    const when = Date.parse(seg.started_at) > minute.epochMilliseconds ? seg.started_at : at;
    await c.query("update session_segments set ended_at = $3 where venue_id = $1 and id = $2", [
      venueId,
      seg.id,
      when,
    ]);
    await c.query(
      `insert into session_segments (venue_id, session_id, room_id, started_at, billable_guests, rate_kind, hourly_cents,
                                     band_id, increment_min, rounding, paused, reason, approved_by)
       select venue_id, session_id, $3, $4, $5, $6, $7, $8, $9, $10, paused, reason, approved_by
         from session_segments where venue_id = $1 and id = $2`,
      [
        venueId,
        seg.id,
        to.id,
        when,
        rate.billableGuests,
        rate.rateKind,
        rate.hourlyCents,
        rate.bandId,
        rate.billing.incrementMin,
        rate.billing.rounding,
      ],
    );
  }

  // The blocks: the old room's ends now and goes to cleaning until its next booking; the session runs on in the new room.
  const block = await sessionBlock(c, venueId, s.id);
  if (block) await setBlockEnd(c, venueId, block.id, input.now);
  try {
    await addBlock(c, {
      venueId,
      roomId: to.id,
      kind: "session",
      from: input.now,
      to: Temporal.Instant.from(options.needed_until),
      refId: s.id,
    });
  } catch (e) {
    if (e instanceof RoomNotFree)
      throw new ApiError("room_not_free", "that room isn't free for the time needed", {
        details: { reason: "in_use" },
      });
    throw e;
  }

  // A new room code; the token version goes up, so the old code and joined phones' tokens stop working.
  const code = newRoomCode(to.name);
  await c.query(
    `update room_sessions set room_id = $3, room_code_hash = $4, token_version = token_version + 1
      where venue_id = $1 and id = $2`,
    [venueId, s.id, to.id, hashRoomCode(venueId, code)],
  );
  await sendToCleaning(c, venueId, from.id, { now: input.now, userId: input.userId });
  await setRoomState(c, venueId, to.id, {
    state: "in_use",
    setBy: input.userId,
    at: input.now.toString(),
  });
  for (const roomId of [from.id, to.id])
    await emitEvent(c, { venueId, type: "room.updated", entityId: roomId, entityVersion: 0 });
  // The old room's channel: joined phones show "You've moved to Room 11 · new code …" (the guest page is M3).
  await emitEvent(c, {
    venueId,
    type: "session.moved",
    entityId: s.id,
    entityVersion: 0,
    roomId: from.id,
  });
  await emitEvent(c, { venueId, type: "session.updated", entityId: s.id, entityVersion: 0 });
  return {
    session_id: s.id,
    from_room: { room_id: from.id, name: from.name },
    to_room: { room_id: to.id, name: to.name },
    room_code: code,
    hourly_cents: rate.hourlyCents,
  };
}
