import { emitEvent } from "./events.js";
import type { Queryable } from "./tenancy.js";

/**
 * The router as a device (M8-02; spec 09 · Router). The server reads the
 * dual-WAN router every 30 seconds, through the maker's documented cloud API
 * or, without one, from the network owner behind the bar computer's public
 * IP, and writes what it learns as the router's heartbeat: `cellular_backup`
 * (the LTE backup is ready), `on_backup_now` (the venue runs on LTE) and
 * `source`. Heartbeats never reach the audit log. A change raises
 * venue.backup_internet, which makes the staff screens fetch the connection.
 */
export type RouterMaker = "peplink";
export const ROUTER_MAKERS: readonly RouterMaker[] = ["peplink"];
export type RouterSource = "maker_api" | "public_ip";

export interface RouterLink {
  readonly maker: RouterMaker | null;
  readonly maker_org_id: string | null;
  readonly maker_device_id: string | null;
  readonly api_on: boolean;
  readonly wired_owner: string | null;
  readonly lte_owner: string | null;
}

export interface RouterRow {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly last_seen_at: string | null;
  readonly network: Record<string, unknown> | null;
  readonly link: RouterLink;
}

const NO_LINK: RouterLink = {
  maker: null,
  maker_org_id: null,
  maker_device_id: null,
  api_on: true,
  wired_owner: null,
  lte_owner: null,
};

/** The venue's live routers, with how each is read and what its heartbeat last said. */
export async function venueRouters(c: Queryable, venueId: string): Promise<RouterRow[]> {
  const r = await c.query<{
    id: string;
    name: string;
    online: boolean;
    last_seen_at: string | null;
    network: Record<string, unknown> | null;
    link: RouterLink | null;
  }>(
    `select d.id, d.name, (h.last_seen_at is not null and h.offline_since is null) as online,
            h.last_seen_at::text, h.network,
            case when l.device_id is null then null else jsonb_build_object(
              'maker', l.maker, 'maker_org_id', l.maker_org_id, 'maker_device_id', l.maker_device_id,
              'api_on', l.api_on, 'wired_owner', l.wired_owner, 'lte_owner', l.lte_owner) end as link
       from devices d
       left join device_heartbeats h on h.venue_id = d.venue_id and h.device_id = d.id
       left join router_links l on l.venue_id = d.venue_id and l.device_id = d.id
      where d.venue_id = $1 and d.kind = 'router' and d.revoked_at is null
        and d.disabled_at is null and not d.sandbox
      order by d.name`,
    [venueId],
  );
  return r.rows.map((row) => ({ ...row, link: row.link ?? NO_LINK }));
}

/** Sets how a router is read. Null when the device isn't one of this venue's live routers. */
export async function setRouterLink(
  c: Queryable,
  venueId: string,
  deviceId: string,
  link: RouterLink,
): Promise<RouterLink | null> {
  const found = await c.query(
    `select 1 from devices where venue_id = $1 and id = $2 and kind = 'router' and revoked_at is null`,
    [venueId, deviceId],
  );
  if (found.rowCount === 0) return null;
  await c.query(
    `insert into router_links (device_id, venue_id, maker, maker_org_id, maker_device_id, api_on, wired_owner, lte_owner)
     values ($2, $1, $3, $4, $5, $6, $7, $8)
     on conflict (device_id) do update set maker = excluded.maker, maker_org_id = excluded.maker_org_id,
       maker_device_id = excluded.maker_device_id, api_on = excluded.api_on,
       wired_owner = excluded.wired_owner, lte_owner = excluded.lte_owner, updated_at = now()`,
    [
      venueId,
      deviceId,
      link.maker,
      link.maker_org_id,
      link.maker_device_id,
      link.api_on,
      link.wired_owner,
      link.lte_owner,
    ],
  );
  return link;
}

export interface RouterReading {
  /** The LTE backup is ready; null when the source can't tell (the fallback, while on the line). */
  readonly cellularBackup: boolean | null;
  readonly onBackupNow: boolean;
  readonly source: RouterSource;
}

/**
 * Writes one reading as the router's heartbeat and raises what it implies:
 * venue.backup_internet when the venue moves onto or off LTE or the backup's
 * readiness changes, device.online when the router had been flagged offline.
 */
export async function recordRouterReading(
  c: Queryable,
  venueId: string,
  deviceId: string,
  reading: RouterReading,
  now: Date,
): Promise<{ changed: boolean; backOnline: boolean }> {
  const before = await c.query<{ network: Record<string, unknown> | null; offline: boolean }>(
    `select network, offline_since is not null as offline from device_heartbeats
      where venue_id = $1 and device_id = $2 for update`,
    [venueId, deviceId],
  );
  const prev = before.rows[0]?.network ?? {};
  const prevBackup = typeof prev["cellular_backup"] === "boolean" ? prev["cellular_backup"] : null;
  // On LTE the backup is plainly working; a source that can't tell keeps the last answer.
  const cellularBackup = reading.onBackupNow ? true : (reading.cellularBackup ?? prevBackup);
  const network = {
    ...prev,
    cellular_backup: cellularBackup,
    on_backup_now: reading.onBackupNow,
    source: reading.source,
  };
  await c.query(
    `insert into device_heartbeats (device_id, venue_id, last_seen_at, network)
     select d.id, d.venue_id, $3, $4 from devices d
      where d.venue_id = $1 and d.id = $2 and d.kind = 'router' and d.revoked_at is null
     on conflict (device_id) do update set last_seen_at = excluded.last_seen_at,
       network = excluded.network, offline_since = null`,
    [venueId, deviceId, now, network],
  );
  const changed =
    (prev["on_backup_now"] === true) !== reading.onBackupNow || prevBackup !== cellularBackup;
  const backOnline = before.rows[0]?.offline === true;
  if (changed) await emitEvent(c, { venueId, type: "venue.backup_internet", entityId: deviceId });
  if (backOnline) await emitEvent(c, { venueId, type: "device.online", entityId: deviceId });
  return { changed, backOnline };
}

/** The public IP the bar computer's latest live heartbeat came from (since `since`), for the fallback. */
export async function barComputerPublicIp(
  c: Queryable,
  venueId: string,
  since: Date,
): Promise<string | null> {
  const r = await c.query<{ ip: string | null }>(
    `select h.network ->> 'public_ip' as ip
       from devices d join device_heartbeats h on h.venue_id = d.venue_id and h.device_id = d.id
      where d.venue_id = $1 and d.kind = 'bar_computer' and d.revoked_at is null and not d.sandbox
        and h.offline_since is null and h.last_seen_at >= $2 and h.network ? 'public_ip'
      order by h.last_seen_at desc limit 1`,
    [venueId, since],
  );
  return r.rows[0]?.ip ?? null;
}

export interface FailoverTest {
  readonly id: string;
  readonly tested_at: string;
  readonly tested_on: string;
  readonly passed: boolean;
  readonly switch_seconds: number | null;
  readonly recorded_by: string | null;
}

/** The router's failover tests, newest first. */
export async function routerFailoverTests(
  c: Queryable,
  venueId: string,
  deviceId: string,
  limit = 12,
): Promise<FailoverTest[]> {
  const r = await c.query<FailoverTest>(
    `select id, tested_at::text, tested_on::text, passed, switch_seconds, recorded_by
       from router_failover_tests where venue_id = $1 and device_id = $2
      order by tested_at desc limit $3`,
    [venueId, deviceId, limit],
  );
  return r.rows;
}

/** Records one failover test. Null when the device isn't one of this venue's live routers. */
export async function recordFailoverTest(
  c: Queryable,
  args: {
    readonly venueId: string;
    readonly deviceId: string;
    readonly testedAt: Date;
    readonly testedOn: string;
    readonly passed: boolean;
    readonly switchSeconds: number | null;
    readonly recordedBy: string | null;
  },
): Promise<FailoverTest | null> {
  const r = await c.query<FailoverTest>(
    `insert into router_failover_tests (venue_id, device_id, tested_at, tested_on, passed, switch_seconds, recorded_by)
     select d.venue_id, d.id, $3, $4, $5, $6, $7 from devices d
      where d.venue_id = $1 and d.id = $2 and d.kind = 'router' and d.revoked_at is null
     returning id, tested_at::text, tested_on::text, passed, switch_seconds, recorded_by`,
    [
      args.venueId,
      args.deviceId,
      args.testedAt,
      args.testedOn,
      args.passed,
      args.switchSeconds,
      args.recordedBy,
    ],
  );
  return r.rows[0] ?? null;
}
