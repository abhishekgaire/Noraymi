import type pg from "pg";
import { emitEvent, expireHolds, withVenue, type Sweep } from "@west4/db";
import type { Clock } from "@west4/shared";

/**
 * Lapsed holds (M2-05; spec 04 · room_blocks): a hold on a room (a slot being
 * paid for, a payment link, a waitlist offer) is gone once it expires, and the
 * room is free again. Every 15 seconds, venue by venue.
 */
export const HOLD_SWEEP_EVERY_MS = 15_000;

export async function sweepHolds(
  pool: pg.Pool,
  now: Clock["now"] extends () => infer I ? I : never,
) {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  const freed: { venueId: string; rooms: string[] }[] = [];
  for (const v of venues.rows) {
    const rooms = await withVenue(pool, { venueId: v.id, requestId: "sweep:holds" }, async (c) => {
      const gone = await expireHolds(c, now);
      for (const roomId of new Set(gone))
        await emitEvent(c, {
          venueId: v.id,
          type: "room.updated",
          entityId: roomId,
          entityVersion: 0,
        });
      return gone;
    });
    if (rooms.length > 0) freed.push({ venueId: v.id, rooms });
  }
  return freed;
}

export function holdSweep(pool: pg.Pool): Sweep {
  return {
    name: "room-holds",
    everyMs: HOLD_SWEEP_EVERY_MS,
    run: async (now) => {
      await sweepHolds(pool, now);
    },
  };
}
