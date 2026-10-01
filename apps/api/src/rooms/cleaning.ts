import {
  addBlock,
  blocksBetween,
  emitEvent,
  listRooms,
  readSetting,
  releaseBlock,
  setBlockEnd,
  setRoomState,
  type Queryable,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "./assignment.js";

/**
 * Cleaning (M2-19; spec 03 · RoomSettings; Board note 9). A session that ends
 * or moves sends its room to cleaning: the `cleaning` state, and a block for
 * the room's cleaning minutes (never past its next booking). With
 * `rooms.cleaningEnds` "staff" the state stays until someone marks the room
 * clean; with "timer" it ends by itself after the cleaning minutes. Marking a
 * room clean changes no booking.
 */
async function roomSettings(c: Queryable, venueId: string, at: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(at, venue.timeZone, venue.dayCutover).businessDate;
  const rooms = await readSetting(c, venueId, "rooms", date);
  return {
    cleaningMin: rooms?.value.cleaningMin ?? 0,
    cleaningEnds: rooms?.value.cleaningEnds ?? "staff",
    cleaningFlagMin: rooms?.value.cleaningFlagMin ?? 0,
  };
}

export async function sendToCleaning(
  c: Queryable,
  venueId: string,
  roomId: string,
  input: { now: Temporal.Instant; userId?: string | undefined },
): Promise<void> {
  const settings = await roomSettings(c, venueId, input.now);
  const room = (await listRooms(c, venueId)).find((r) => r.id === roomId);
  const minutes = room?.cleaning_min ?? settings.cleaningMin;
  if (minutes > 0) {
    const end = input.now.add({ minutes });
    const next = (await blocksBetween(c, venueId, input.now, end))
      .filter(
        (b) =>
          b.room_id === roomId &&
          Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), input.now) > 0,
      )
      .map((b) => Temporal.Instant.from(b.starts_at))
      .sort(Temporal.Instant.compare)[0];
    const to = next ?? end;
    if (Temporal.Instant.compare(to, input.now) > 0)
      await addBlock(c, { venueId, roomId, kind: "cleaning", from: input.now, to });
  }
  await setRoomState(c, venueId, roomId, {
    state: "cleaning",
    setBy: input.userId,
    at: input.now.toString(),
  });
  await emitEvent(c, { venueId, type: "room.updated", entityId: roomId, entityVersion: 0 });
}

/** Marks a room clean: Open again (or in use, if a party is in it); its cleaning block ends now. */
export async function markClean(
  c: Queryable,
  venueId: string,
  roomId: string,
  input: { now: Temporal.Instant; userId?: string | undefined },
): Promise<void> {
  const room = (await listRooms(c, venueId)).find((r) => r.id === roomId);
  if (!room) throw new ApiError("not_found", "no such room");
  if (room.state !== "cleaning") throw new ApiError("invalid_request", "the room isn't cleaning");
  const open = await c.query(
    "select 1 from room_sessions where venue_id = $1 and room_id = $2 and ended_at is null",
    [venueId, roomId],
  );
  await setRoomState(c, venueId, roomId, {
    state: (open.rowCount ?? 0) > 0 ? "in_use" : "available",
    setBy: input.userId,
    at: input.now.toString(),
  });
  const blocks = (await blocksBetween(c, venueId, input.now.subtract({ hours: 24 }), null)).filter(
    (b) =>
      b.room_id === roomId &&
      b.kind === "cleaning" &&
      (b.ends_at === null ||
        Temporal.Instant.compare(Temporal.Instant.from(b.ends_at), input.now) > 0),
  );
  for (const b of blocks)
    if (Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), input.now) >= 0)
      await releaseBlock(c, b.id);
    else await setBlockEnd(c, venueId, b.id, input.now);
  await emitEvent(c, { venueId, type: "room.updated", entityId: roomId, entityVersion: 0 });
}

/** With "timer", cleaning ends by itself after the cleaning minutes; returns the rooms it ended. */
export async function endTimedCleaning(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<string[]> {
  const settings = await roomSettings(c, venueId, now);
  if (settings.cleaningEnds !== "timer") return [];
  const due = await c.query<{ room_id: string }>(
    `select s.room_id from room_states s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
      where s.venue_id = $1 and s.state = 'cleaning'
        and s.since + make_interval(mins => coalesce(r.cleaning_min, $2)) <= $3::timestamptz`,
    [venueId, settings.cleaningMin, now.toString()],
  );
  for (const row of due.rows) await markClean(c, venueId, row.room_id, { now });
  return due.rows.map((r) => r.room_id);
}

/** "Needs a wipe · left 10:33 PM (8 min)", flagged once it's been longer than the flag minutes. */
export async function cleaningStatus(c: Queryable, venueId: string, now: Temporal.Instant) {
  const settings = await roomSettings(c, venueId, now);
  const r = await c.query<{ room_id: string; since: string }>(
    "select room_id, to_json(since) #>> '{}' as since from room_states where venue_id = $1 and state = 'cleaning'",
    [venueId],
  );
  return new Map(
    r.rows.map((row) => {
      const minutes = Math.max(
        0,
        Math.floor(
          (now.epochMilliseconds - Temporal.Instant.from(row.since).epochMilliseconds) / 60_000,
        ),
      );
      return [
        row.room_id,
        { left_at: row.since, minutes, flagged: minutes > settings.cleaningFlagMin },
      ] as const;
    }),
  );
}
