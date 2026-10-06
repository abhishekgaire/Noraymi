import type pg from "pg";
import {
  barComputerPublicIp,
  recordRouterReading,
  routerFailoverTests,
  venueRouters,
  withVenue,
  type RouterReading,
  type RouterRow,
  type Sweep,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { enqueuePush } from "../push/send-push.js";
import { failoverDue } from "../router/failover.js";
import {
  classifyOwner,
  loadIpOwnerUrl,
  makeIpOwnerLookup,
  type IpOwnerLookup,
} from "../router/ip-owner.js";
import { loadPeplinkSettings, makePeplinkAdapter, type RouterAdapter } from "../router/peplink.js";
import { venueOpenNow } from "./device-watch.js";

/**
 * The router as a device (M8-02; spec 09 · Router, Heartbeats). On the
 * 30-second heartbeat (the ticket's cautious default: the spec doesn't say
 * how often to poll) and during opening hours, each venue's router is read
 * outside any transaction: through the maker's documented cloud API while
 * it's linked and switched on, else from the network owner behind the bar
 * computer's public IP. What it learns is the router's heartbeat; a change
 * raises venue.backup_internet. No answer is no heartbeat, so a router
 * nobody can read shows offline after two minutes like any device.
 *
 * The monthly failover test: once it falls due, the managers get one
 * reminder on their phones, and Admin shows it due until a result is kept.
 */
export const ROUTER_WATCH_EVERY_MS = 30_000;
/** The bar computer's IP counts while its heartbeat is this fresh (the 2-minute rule). */
const BAR_IP_FRESH_MS = 120_000;

export interface RouterWatchDeps {
  readonly adapter: RouterAdapter | null;
  readonly ipOwner: IpOwnerLookup;
}

async function readRouter(
  router: RouterRow,
  barIp: string | null,
  deps: RouterWatchDeps,
): Promise<RouterReading | null> {
  const { link } = router;
  if (deps.adapter && link.api_on && link.maker) {
    const m = await deps.adapter.read(link);
    if (m)
      return { cellularBackup: m.backupReady, onBackupNow: m.onBackupNow, source: "maker_api" };
  }
  // Nothing to tell the networks apart by: don't ask anyone.
  if (!barIp || (!link.wired_owner && !link.lte_owner)) return null;
  const network = classifyOwner(await deps.ipOwner(barIp), link);
  return network === null
    ? null
    : { cellularBackup: null, onBackupNow: network === "lte", source: "public_ip" };
}

export async function sweepRouters(
  pool: pg.Pool,
  deps: RouterWatchDeps,
  now: Temporal.Instant,
  log?: (line: string) => void,
): Promise<{ venueId: string; read: string[]; changed: string[]; reminded: string[] }[]> {
  const venues = await pool.query<{ id: string; time_zone: string; day_cutover: string }>(
    "select id, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues_for_scheduler()",
  );
  const at = new Date(now.epochMilliseconds);
  const out: { venueId: string; read: string[]; changed: string[]; reminded: string[] }[] = [];
  for (const v of venues.rows) {
    const ctx = { venueId: v.id, requestId: "router-watch" };
    const today = businessDate(now, v.time_zone, v.day_cutover).businessDate;
    const plan = await withVenue(pool, ctx, async (c) => {
      if (!(await venueOpenNow(c, v, now))) return null;
      const routers = await venueRouters(c, v.id);
      if (routers.length === 0) return null;
      const barIp = await barComputerPublicIp(c, v.id, new Date(at.getTime() - BAR_IP_FRESH_MS));
      // The failover reminder: one push to the managers when a router's test falls due.
      const reminded: string[] = [];
      for (const r of routers) {
        const last = (await routerFailoverTests(c, v.id, r.id, 1))[0] ?? null;
        if (!failoverDue(last?.tested_on ?? null, today).due) continue;
        const job = await enqueuePush(c, {
          venueId: v.id,
          audience: { kind: "role", role: "manager" },
          message: {
            key: "router.push.failoverDue",
            params: { name: r.name },
            url: "/admin/devices",
            tag: `router-failover-${r.id}`,
          },
          runAt: now,
          dedupeKey: `router-failover:${r.id}:${last?.id ?? "never"}`,
        });
        if (job) reminded.push(r.id);
      }
      return { routers, barIp, reminded };
    });
    if (!plan) continue;
    const read: string[] = [];
    const changed: string[] = [];
    for (const router of plan.routers) {
      const reading = await readRouter(router, plan.barIp, deps);
      if (!reading) continue;
      read.push(router.id);
      const result = await withVenue(pool, ctx, (c) =>
        recordRouterReading(c, v.id, router.id, reading, at),
      );
      if (result.changed) {
        changed.push(router.id);
        log?.(
          `router ${router.id}: ${reading.onBackupNow ? "on LTE" : "on the line"} (${reading.source})`,
        );
      }
    }
    out.push({ venueId: v.id, read, changed, reminded: plan.reminded });
  }
  return out;
}

export function routerWatchSweep(pool: pg.Pool, log?: (line: string) => void): Sweep {
  const deps: RouterWatchDeps = {
    adapter: makePeplinkAdapter(loadPeplinkSettings()),
    ipOwner: makeIpOwnerLookup(loadIpOwnerUrl()),
  };
  return {
    name: "routers.watch",
    everyMs: ROUTER_WATCH_EVERY_MS,
    run: async (now) => void (await sweepRouters(pool, deps, now, log)),
  };
}
