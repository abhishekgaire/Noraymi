import type { Temporal } from "@west4/shared";
import { emitEvent } from "./events.js";
import type { Queryable } from "./tenancy.js";

/**
 * Heartbeats (spec 09 · Clocks, Heartbeats; M1-16). Every device checks in
 * every 30 seconds; the row in device_heartbeats is rewritten each time and
 * never audited. Two minutes of silence during opening hours is "offline"
 * (the sweep in the worker decides that); a clock more than 30 seconds off
 * raises device.clock_skew to the managers.
 */
export const HEARTBEAT_EVERY_MS = 30_000;
export const DEVICE_SILENCE_MS = 120_000;
export const CLOCK_SKEW_LIMIT_MS = 30_000;
/** Kinds with no clock or network of their own: they report through their host computer's heartbeat. */
export const ATTACHED_KINDS = ["printer", "nfc_reader"] as const;

export interface HeartbeatInput {
  readonly venueId: string;
  readonly deviceId: string;
  /** The venue's clock at the heartbeat, not the device's. */
  readonly now: Temporal.Instant;
  readonly appVersion: string | null;
  readonly network: Record<string, unknown> | null;
  /** The device's clock minus the server's real clock, in ms. */
  readonly clockSkewMs: number;
  /** Attached printers and NFC readers the host can see right now. */
  readonly attached: readonly string[];
}

export interface HeartbeatResult {
  /** Devices that had been flagged offline and are back: the host and any attached ones. */
  readonly backOnline: readonly string[];
  /** True when this heartbeat ended a venue-wide outage. */
  readonly venueBackOnline: boolean;
  readonly clockAlert: "raised" | "cleared" | null;
  /** Attached ids that weren't this venue's printers or NFC readers, so nothing was recorded for them. */
  readonly attachedIgnored: readonly string[];
}

/** Records one heartbeat inside the venue's transaction and raises the online and clock events it implies. */
export async function recordHeartbeat(
  c: Queryable,
  input: HeartbeatInput,
): Promise<HeartbeatResult> {
  const now = new Date(input.now.epochMilliseconds);
  const before = await c.query<{ device_id: string; offline: boolean; clock_alerted: boolean }>(
    `select device_id, offline_since is not null as offline, clock_alerted_at is not null as clock_alerted
       from device_heartbeats
      where venue_id = $1 and device_id = any($2::uuid[])
      for update`,
    [input.venueId, [input.deviceId, ...input.attached]],
  );
  const wasOffline = new Set(before.rows.filter((r) => r.offline).map((r) => r.device_id));
  const host = before.rows.find((r) => r.device_id === input.deviceId);

  const skewOff = Math.abs(input.clockSkewMs) > CLOCK_SKEW_LIMIT_MS;
  let clockAlert: HeartbeatResult["clockAlert"] = null;
  if (skewOff && !host?.clock_alerted) clockAlert = "raised";
  if (!skewOff && host?.clock_alerted) clockAlert = "cleared";
  // int4 holds about ±24 days of skew; a wildly wrong clock is clamped, not refused.
  const skew = Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(input.clockSkewMs)));

  await c.query(
    `insert into device_heartbeats (device_id, venue_id, last_seen_at, app_version, network, clock_skew_ms, clock_alerted_at)
     values ($1, $2, $3::timestamptz, $4, $5, $6, case when $7::boolean then $3::timestamptz end)
     on conflict (device_id) do update
       set last_seen_at = excluded.last_seen_at,
           app_version = excluded.app_version,
           network = excluded.network,
           clock_skew_ms = excluded.clock_skew_ms,
           offline_since = null,
           clock_alerted_at = case when $7::boolean then coalesce(device_heartbeats.clock_alerted_at, excluded.last_seen_at) end`,
    [input.deviceId, input.venueId, now, input.appVersion, input.network, skew, skewOff],
  );

  const backOnline: string[] = wasOffline.has(input.deviceId) ? [input.deviceId] : [];
  let attachedIgnored: string[] = [];
  if (input.attached.length > 0) {
    const recorded = await c.query<{ device_id: string }>(
      `insert into device_heartbeats (device_id, venue_id, last_seen_at)
       select d.id, d.venue_id, $3
         from devices d
        where d.venue_id = $1 and d.id = any($2::uuid[]) and d.kind = any($4::text[])
          and d.revoked_at is null and d.disabled_at is null
       on conflict (device_id) do update
         set last_seen_at = excluded.last_seen_at, offline_since = null
       returning device_id`,
      [input.venueId, input.attached, now, [...ATTACHED_KINDS]],
    );
    const seen = new Set(recorded.rows.map((r) => r.device_id));
    attachedIgnored = input.attached.filter((id) => !seen.has(id));
    for (const id of input.attached) if (seen.has(id) && wasOffline.has(id)) backOnline.push(id);
  }

  const outage = await c.query<{ venue_id: string }>(
    `update venue_outages set offline_since = null where venue_id = $1 and offline_since is not null returning venue_id`,
    [input.venueId],
  );
  const venueBackOnline = (outage.rowCount ?? 0) > 0;

  if (venueBackOnline)
    await emitEvent(c, {
      venueId: input.venueId,
      type: "venue.online",
      entityId: input.venueId,
      audience: "managers",
    });
  for (const id of backOnline)
    await emitEvent(c, { venueId: input.venueId, type: "device.online", entityId: id });
  if (clockAlert === "raised")
    await emitEvent(c, {
      venueId: input.venueId,
      type: "device.clock_skew",
      entityId: input.deviceId,
      audience: "managers",
    });

  return { backOnline, venueBackOnline, clockAlert, attachedIgnored };
}

export interface QuietSweepResult {
  /** Devices flagged offline by this pass. */
  readonly offline: readonly string[];
  /** True when every device went quiet and one venue.offline was raised instead of one event each. */
  readonly venueOffline: boolean;
}

/**
 * One venue's quiet-device pass, inside its transaction, at an instant the
 * caller has already checked is during opening hours. A device is quiet when
 * its last heartbeat is silenceMs or more ago. Devices on cellular aren't on
 * the venue's line, so they don't count toward "the whole venue dropped".
 */
export async function flagQuietDevices(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  silenceMs: number = DEVICE_SILENCE_MS,
): Promise<QuietSweepResult> {
  const rows = await c.query<{ device_id: string; quiet: boolean; flagged: boolean }>(
    `select h.device_id, h.last_seen_at <= $2 as quiet, h.offline_since is not null as flagged
       from device_heartbeats h join devices d on d.venue_id = h.venue_id and d.id = h.device_id
      where h.venue_id = $1 and d.revoked_at is null and d.disabled_at is null
        and coalesce(h.network ->> 'type', '') <> 'cellular'`,
    [venueId, new Date(now.epochMilliseconds - silenceMs)],
  );
  const newly = rows.rows.filter((r) => r.quiet && !r.flagged).map((r) => r.device_id);
  if (newly.length === 0) return { offline: [], venueOffline: false };
  const at = new Date(now.epochMilliseconds);

  let venueOffline = false;
  if (rows.rows.every((r) => r.quiet)) {
    const outage = await c.query<{ venue_id: string }>(
      `insert into venue_outages (venue_id, offline_since) values ($1, $2)
       on conflict (venue_id) do update set offline_since = excluded.offline_since
         where venue_outages.offline_since is null
       returning venue_id`,
      [venueId, at],
    );
    venueOffline = (outage.rowCount ?? 0) > 0;
  }
  await c.query(
    `update device_heartbeats set offline_since = $2 where venue_id = $1 and device_id = any($3::uuid[])`,
    [venueId, at, newly],
  );
  if (venueOffline) {
    await emitEvent(c, { venueId, type: "venue.offline", entityId: venueId, audience: "managers" });
  } else {
    for (const id of newly) await emitEvent(c, { venueId, type: "device.offline", entityId: id });
  }
  return { offline: newly, venueOffline };
}
