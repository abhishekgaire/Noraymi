import type pg from "pg";
import { withVenue, type Sweep } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { cancelAlcohol } from "../rooms/cut-off.js";
import { alcoholNow } from "./alcohol.js";

/**
 * The 4 AM stop (M3-22; Money rules 5): once the alcohol window closes (4:00
 * AM at West 4, on the wall clock for that business date, so the same on the
 * daylight-saving nights), every alcohol order nobody accepted is cancelled
 * as `alcohol_closed`, nothing charged; an order with other items keeps
 * ringing with just those. The rooms read "The bar stopped serving alcohol
 * at 4 AM", the bar "Cancelled at 4:00 AM". The sweep checks every 5 seconds,
 * so it acts within seconds of the close whatever the house last call.
 */
export const FOUR_AM_EVERY_MS = 5_000;

export async function sweepAlcoholStop(pool: pg.Pool, now: Temporal.Instant): Promise<number> {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  let cancelled = 0;
  for (const v of venues.rows)
    cancelled += await withVenue(
      pool,
      { venueId: v.id, requestId: "sweep:alcohol-stop" },
      async (c) => {
        if ((await alcoholNow(c, v.id, now)).state !== "closed") return 0;
        return cancelAlcohol(
          c,
          v.id,
          { sessionId: null, roomGuestId: null },
          null,
          now,
          "alcohol_closed",
        );
      },
    );
  return cancelled;
}

export function alcoholStopSweep(pool: pg.Pool): Sweep {
  return {
    name: "orders.alcohol-stop",
    everyMs: FOUR_AM_EVERY_MS,
    run: async (now) => void (await sweepAlcoholStop(pool, now)),
  };
}
