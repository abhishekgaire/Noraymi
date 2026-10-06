import type pg from "pg";
import {
  emitEvent,
  recordReadersSeen,
  stripeAccountFor,
  venueReaders,
  venueTerminal,
  withVenue,
  type Sweep,
} from "@west4/db";
import type { Temporal } from "@west4/shared";
import type { StripeClient } from "../stripe/client.js";
import { listReaders } from "../stripe/terminal.js";
import { venueOpenNow } from "./device-watch.js";

/**
 * Reader health (M4-02; spec 09 · Heartbeats): every 30 seconds during
 * opening hours, each venue's readers are read from Stripe (outside any
 * transaction) and every one Stripe calls online gets a heartbeat. The
 * quiet-device sweep then raises device.offline to the manager after two
 * minutes without one, Stripe's own 2-minute rule. Heartbeats never go into
 * the audit log.
 */
export const READER_HEALTH_EVERY_MS = 30_000;

export async function sweepReaders(
  pool: pg.Pool,
  stripe: StripeClient,
  now: Temporal.Instant,
  log?: (line: string) => void,
): Promise<{ venueId: string; online: number; backOnline: string[] }[]> {
  const venues = await pool.query<{ id: string; time_zone: string; day_cutover: string }>(
    "select id, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues_for_scheduler()",
  );
  const out: { venueId: string; online: number; backOnline: string[] }[] = [];
  // Live readers on the live Location; training mode's simulated readers on the sandbox's (M7-04).
  for (const v of venues.rows)
    for (const training of [false, true]) {
      const ctx = { venueId: v.id, requestId: "reader-health" };
      const plan = await withVenue(pool, ctx, async (c) => {
        if (!(await venueOpenNow(c, v, now))) return null;
        const readers = (await venueReaders(c, v.id)).filter(
          (r) => r.stripe_reader_id && r.sandbox === training,
        );
        if (readers.length === 0) return null;
        const account = await stripeAccountFor(c, v.id, training);
        const location = (await venueTerminal(c, v.id, training)).location_id;
        return account && location ? { account, location, readers } : null;
      });
      if (!plan) continue;
      let listed;
      try {
        listed = await listReaders(stripe.forTraining(training), plan.account, plan.location);
      } catch (e) {
        // No answer is no heartbeat: two minutes of that and the readers show offline.
        log?.(`reader health for ${v.id}: ${(e as Error).message}`);
        continue;
      }
      const online = new Set(listed.filter((r) => r.status === "online").map((r) => r.id));
      const seen = plan.readers.filter((r) => online.has(r.stripe_reader_id!)).map((r) => r.id);
      const back = await withVenue(pool, ctx, async (c) => {
        const b = await recordReadersSeen(c, v.id, seen, new Date(now.epochMilliseconds));
        for (const id of b)
          await emitEvent(c, { venueId: v.id, type: "device.online", entityId: id });
        return b;
      });
      out.push({ venueId: v.id, online: seen.length, backOnline: back });
    }
  return out;
}

export function readerHealthSweep(
  pool: pg.Pool,
  stripe: StripeClient,
  log?: (line: string) => void,
): Sweep {
  return {
    name: "readers.health",
    everyMs: READER_HEALTH_EVERY_MS,
    run: async (now) => void (await sweepReaders(pool, stripe, now, log)),
  };
}
