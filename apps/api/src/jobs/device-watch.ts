import type pg from "pg";
import {
  closureOn,
  flagQuietDevices,
  readSetting,
  withVenue,
  DEVICE_SILENCE_MS,
  type QuietSweepResult,
  type Sweep,
} from "@west4/db";
import { businessDate, hoursFor, openNow } from "@west4/rules";
import type { Temporal } from "@west4/shared";

/**
 * The quiet-device sweep (spec 09 · Heartbeats; M1-16). The scheduler's
 * leader runs it every 15 seconds: for each venue that is open right now,
 * every device whose last heartbeat is two minutes old or more is flagged
 * offline and device.offline is raised, or one venue.offline when the whole
 * venue dropped at once. Outside opening hours nothing is raised: the bar
 * computer is meant to be off at 4:30 AM.
 */
export const DEVICE_WATCH_EVERY_MS = 15_000;

export interface VenueSweep extends QuietSweepResult {
  readonly venueId: string;
}

export async function sweepQuietDevices(
  pool: pg.Pool,
  now: Temporal.Instant,
  silenceMs: number = DEVICE_SILENCE_MS,
): Promise<VenueSweep[]> {
  const venues = await pool.query<{ id: string; time_zone: string; day_cutover: string }>(
    "select id, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues_for_scheduler()",
  );
  const flagged: VenueSweep[] = [];
  for (const v of venues.rows) {
    const result = await withVenue(
      pool,
      { venueId: v.id, requestId: "device-watch" },
      async (c) => {
        const date = businessDate(now, v.time_zone, v.day_cutover).businessDate;
        const [hours, closure] = await Promise.all([
          readSetting(c, v.id, "hours", date),
          closureOn(c, v.id, date.toString()),
        ]);
        // No hours yet means no "opening hours" to be quiet during.
        if (!hours) return null;
        const h = hoursFor(
          { timeZone: v.time_zone, dayCutover: v.day_cutover },
          date,
          hours.value,
          closure,
        );
        if (!openNow(h, now)) return null;
        return flagQuietDevices(c, v.id, now, silenceMs);
      },
    );
    if (result && result.offline.length > 0) flagged.push({ venueId: v.id, ...result });
  }
  return flagged;
}

export function deviceWatchSweep(pool: pg.Pool, log?: (line: string) => void): Sweep {
  return {
    name: "devices.watch",
    everyMs: DEVICE_WATCH_EVERY_MS,
    run: async (now) => {
      for (const v of await sweepQuietDevices(pool, now)) {
        log?.(
          v.venueOffline
            ? `venue ${v.venueId} offline: every device quiet`
            : `venue ${v.venueId}: ${v.offline.length} device(s) offline`,
        );
      }
    },
  };
}
