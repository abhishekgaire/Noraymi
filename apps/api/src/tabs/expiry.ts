import { withVenue, type Queryable, type Sweep } from "@west4/db";
import { holdExpiresAt, holdRunningOut } from "@west4/rules";
import { Temporal } from "@west4/shared";
import type pg from "pg";
import { managerOnDutyAt } from "../approvals/service.js";
import { enqueuePush } from "../push/send-push.js";
import { closingById, latestClosing } from "./close.js";
import { captureSlip } from "./tip.js";

/**
 * The hold watch (M6-17; Payment flows · Bar tab with a growing hold, step 6; Data model · Tabs at the
 * cut-off and at close). Every minute, venue by venue:
 *  - the sweeper: a tab still `awaiting_tip` (its paper slip printed, the tip never entered) 12 hours
 *    before its hold's `capture_before` is captured at its total with a tip of 0, as if the slip said 0,
 *    and flagged (`tab_closings.swept_at`);
 *  - the alert: any hold still standing within 12 hours of running out tells the manager on duty, once
 *    per tab (`tabs.hold_expiry_alerted_at`).
 * Stripe's `capture_before` decides; a hold Stripe hasn't reported on is taken to last two days from when
 * the tab opened, the shortest an in-person hold lasts (packages/rules · holdExpiresAt). The capture is
 * written here and run by the payment worker, outside any transaction, keyed as every capture is.
 */
export const HOLD_WATCH_EVERY_MS = 60_000;

interface Watched {
  id: string;
  name: string;
  state: string;
  capture_before: string | null;
  opened_at: string;
  alerted: boolean;
  closing: string | null;
}

const expiresOf = (t: Watched) =>
  holdExpiresAt({
    captureBefore: t.capture_before ? Temporal.Instant.from(t.capture_before) : null,
    placedAt: Temporal.Instant.from(t.opened_at),
  });

/** Tabs whose hold still stands, with the Close under way on each, if any. */
async function watched(c: Queryable, venueId: string): Promise<Watched[]> {
  const r = await c.query<Watched>(
    `select t.id, t.name, t.state, to_json(p.capture_before) #>> '{}' as capture_before,
            to_json(t.opened_at) #>> '{}' as opened_at, t.hold_expiry_alerted_at is not null as alerted,
            (select x.state from tab_closings x where x.venue_id = t.venue_id and x.tab_id = t.id
              order by x.created_at desc, x.id desc limit 1) as closing
       from tabs t join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and p.status = 'authorized'
        and t.state in ('open', 'tipping', 'awaiting_tip', 'capture_failed')
      order by t.opened_at, t.id`,
    [venueId],
  );
  return r.rows;
}

/** Captures one untouched slip at a tip of 0 (its own transaction). Answers whether it did. */
async function sweepSlip(
  c: Queryable,
  venueId: string,
  tabId: string,
  now: Temporal.Instant,
): Promise<boolean> {
  const tab = (
    await c.query<{ state: string }>(
      "select state from tabs where venue_id = $1 and id = $2 for update",
      [venueId, tabId],
    )
  ).rows[0];
  const latest = await latestClosing(c, venueId, tabId);
  const closing = latest ? await closingById(c, venueId, latest.id, true) : null;
  // Entered meanwhile, or already being captured: nothing to sweep.
  if (tab?.state !== "awaiting_tip" || closing?.state !== "slip") return false;
  await c.query("update tab_closings set swept_at = $3 where venue_id = $1 and id = $2", [
    venueId,
    closing.id,
    now.toString(),
  ]);
  // A tip waiting on a manager is overtaken: the hold can't wait, and an OK after this finds no slip.
  await captureSlip(c, venueId, closing, { tipCents: 0, userId: null, now });
  return true;
}

/** The alert to the manager on duty, once per tab. */
async function alertRunningOut(
  c: Queryable,
  venueId: string,
  tab: Watched,
  now: Temporal.Instant,
): Promise<boolean> {
  const marked = await c.query(
    `update tabs set hold_expiry_alerted_at = $3
      where venue_id = $1 and id = $2 and hold_expiry_alerted_at is null`,
    [venueId, tab.id, now.toString()],
  );
  if (!marked.rowCount) return false;
  const manager = await managerOnDutyAt(c, venueId, now);
  if (!manager) return true;
  await enqueuePush(c, {
    venueId,
    audience: { kind: "person", userId: manager },
    message: {
      key: "tabs.push.holdExpiring",
      params: { name: tab.name },
      url: "/close-the-night",
      tag: `tab-hold-expiring-${tab.id}`,
    },
    runAt: now,
    dedupeKey: `tab-hold-expiring:${tab.id}`,
  });
  return true;
}

export async function runHoldWatch(
  pool: pg.Pool,
  venueId: string,
  now: Temporal.Instant,
): Promise<{ swept: string[]; alerted: string[] }> {
  const inVenue = <T>(fn: (c: Queryable) => Promise<T>) =>
    withVenue(pool, { venueId, requestId: "sweep:tab-holds" }, fn);
  const due = (await inVenue((c) => watched(c, venueId))).filter((t) =>
    holdRunningOut(now, expiresOf(t)),
  );
  const swept: string[] = [];
  const alerted: string[] = [];
  for (const tab of due) {
    if (tab.state === "awaiting_tip" && tab.closing === "slip") {
      if (await inVenue((c) => sweepSlip(c, venueId, tab.id, now))) swept.push(tab.id);
      continue;
    }
    // A Close already capturing (or raising) is about to take the hold: nothing to warn about.
    if (tab.alerted || tab.closing === "capturing" || tab.closing === "raising") continue;
    if (await inVenue((c) => alertRunningOut(c, venueId, tab, now))) alerted.push(tab.id);
  }
  return { swept, alerted };
}

export async function sweepHoldWatch(pool: pg.Pool, now: Temporal.Instant) {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  for (const v of venues.rows) await runHoldWatch(pool, v.id, now);
}

export function holdWatchSweep(pool: pg.Pool): Sweep {
  return {
    name: "tabs.hold-watch",
    everyMs: HOLD_WATCH_EVERY_MS,
    run: async (now) => void (await sweepHoldWatch(pool, now)),
  };
}
