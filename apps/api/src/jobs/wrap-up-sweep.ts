import type pg from "pg";
import { withVenue, type Sweep } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { markWrapUps } from "../rooms/sessions.js";

/** Every minute, rooms that need wrapping up (someone booked next, or the night's close) go to wrap-up (M2-07). */
export const WRAP_UP_EVERY_MS = 60_000;

export async function sweepWrapUps(pool: pg.Pool, now: Temporal.Instant) {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  const out: { venueId: string; rooms: string[] }[] = [];
  for (const v of venues.rows) {
    const rooms = await withVenue(pool, { venueId: v.id, requestId: "sweep:wrap-up" }, (c) =>
      markWrapUps(c, v.id, now),
    );
    if (rooms.length > 0) out.push({ venueId: v.id, rooms });
  }
  return out;
}

export function wrapUpSweep(pool: pg.Pool): Sweep {
  return {
    name: "wrap-up",
    everyMs: WRAP_UP_EVERY_MS,
    run: async (now) => void (await sweepWrapUps(pool, now)),
  };
}
