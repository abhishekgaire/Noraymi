import { closureOn, emitEvent, readSetting, type Queryable } from "@west4/db";
import { businessDate, hoursFor, openNow } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { enqueuePush } from "../push/send-push.js";
import { venueClock } from "./assignment.js";

/**
 * No bar device connected (M3-17; screens N32; spec 09 · Room orders at the
 * bar). The server tracks whether a bar computer is connected: its live
 * socket, with its heartbeat behind it. When the last one drops during
 * opening hours, every bar-role phone buzzes at once and the board shows the
 * alert; when one connects again, the alert clears everywhere. Outside
 * opening hours nothing is raised: the bar computer is meant to be off.
 */
export async function venueOpenNow(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<boolean> {
  const v = await venueClock(c, venueId);
  const date = businessDate(now, v.timeZone, v.dayCutover).businessDate;
  const [hours, closure] = await Promise.all([
    readSetting(c, venueId, "hours", date),
    closureOn(c, venueId, date.toString()),
  ]);
  if (!hours) return false;
  return openNow(hoursFor(v, date, hours.value, closure), now);
}

/** Is this device a bar computer? */
export async function isBarComputer(
  c: Queryable,
  venueId: string,
  deviceId: string,
): Promise<boolean> {
  const r = await c.query(
    "select 1 from devices where venue_id = $1 and id = $2 and kind = 'bar_computer'",
    [venueId, deviceId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** A bar computer connected: the alert, if any, clears. */
export async function barConnected(c: Queryable, venueId: string): Promise<boolean> {
  const r = await c.query(
    "update bar_presence set lost_at = null where venue_id = $1 and lost_at is not null",
    [venueId],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await emitEvent(c, { venueId, type: "bar.connected", entityId: venueId, entityVersion: 0 });
  return true;
}

/** The last bar computer dropped: during opening hours, the phones buzz and the board shows it. Once per outage. */
export async function barLost(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<boolean> {
  if (!(await venueOpenNow(c, venueId, now))) return false;
  const r = await c.query(
    `insert into bar_presence (venue_id, lost_at) values ($1, $2)
     on conflict (venue_id) do update set lost_at = excluded.lost_at where bar_presence.lost_at is null
     returning venue_id`,
    [venueId, now.toString()],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  // The bar-role people on the clock (M7-01).
  await enqueuePush(c, {
    venueId,
    audience: { kind: "bar_on_clock" },
    message: { key: "bar.lost.push", params: {}, url: "/tonight", tag: "no-bar-device" },
    runAt: now,
  });
  await emitEvent(c, { venueId, type: "bar.disconnected", entityId: venueId, entityVersion: 0 });
  return true;
}

/** Bar computers with a heartbeat in the last two minutes. */
export async function barsHeard(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<number> {
  const r = await c.query<{ n: number }>(
    `select count(*)::int as n from devices d join device_heartbeats h on h.venue_id = d.venue_id and h.device_id = d.id
      where d.venue_id = $1 and d.kind = 'bar_computer' and d.revoked_at is null
        and h.last_seen_at > $2::timestamptz - interval '2 minutes'`,
    [venueId, now.toString()],
  );
  return r.rows[0]!.n;
}

/** The board's alert: since when no bar computer has been connected, while it lasts. */
export async function barLostSince(c: Queryable, venueId: string): Promise<string | null> {
  const r = await c.query<{ lost_at: string | null }>(
    "select to_json(lost_at) #>> '{}' as lost_at from bar_presence where venue_id = $1",
    [venueId],
  );
  return r.rows[0]?.lost_at ?? null;
}
