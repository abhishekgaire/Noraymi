import type pg from "pg";
import { withVenue, type Queryable, type Sweep } from "@west4/db";
import {
  TARGETS,
  cardOutcome,
  firingBurnAlerts,
  type Temporal,
  type WindowCounts,
} from "@west4/shared";
import { venueOpenNow } from "../jobs/device-watch.js";
import type { AlertRuleId } from "./alert-rules.js";
import { clearPages, notifyPages, raisePage, type PagerDeps } from "./paging.js";

/**
 * The alert sweep (M8-17; spec 13 · Watching production). Every 30 seconds the scheduler's leader
 * checks each venue, inside that venue's own wall, for money at risk, then pages us for what it
 * found, clears what stopped, and sends or escalates the pages nobody has acknowledged. The
 * burn-rate checks add up the counts of the venues open right now (opening hours only); the
 * CloudWatch alarms (infra/staging/paging.tf) reach the same pages through the alarm hook.
 */
export const ALERT_SWEEP_EVERY_MS = 30_000;
/** Spec 13: webhook lag over a minute pages. */
export const WEBHOOK_LAG_SECONDS = 60;

/**
 * The decline-rate alarm (M8-19; spec 12 · 8, Stripe's card-testing guidance): a burst of declined
 * cards on a venue's booking page, any hour. Cautious defaults, ours to tune once real nights are
 * seen: at least 5 declines within 10 minutes, making up at least half of the page's attempts.
 */
export const DECLINE_ALARM = { windowMinutes: 10, minDeclines: 5, minShare: 0.5 } as const;

/**
 * Refund spikes (M8-19; spec 12 · 12): at least 5 refunds at a venue within 60 minutes pages us,
 * practice refunds aside. A cautious default of ours, to tune once real nights are seen; the
 * owner hears of every refund anyway (owner_alerts).
 */
export const REFUND_SPIKE = { windowMinutes: 60, minRefunds: 5 } as const;

/** Money job kinds: the critical pool, plus payments, refunds, tabs and Stripe events wherever they run. */
const MONEY_KINDS = ["payment.%", "refund.%", "tab.%", "stripe.%"];

/** The burn windows the page-severity alerts read (targets.ts · BURN_ALERTS), in minutes. */
const WINDOWS = [5, 30, 60, 360] as const;

export interface Firing {
  readonly rule: AlertRuleId;
  readonly key: string;
  readonly summary: string;
}

type Counts = Record<number, WindowCounts>;

interface VenueFindings {
  readonly firings: Firing[];
  readonly card: Counts;
  readonly alarm: Counts;
}

const n = async (c: Queryable, sql: string, params: unknown[]) =>
  (await c.query<{ n: number }>(sql, params)).rows[0]!.n;

/** One venue's checks, run inside its wall. `open` is whether it is inside opening hours now. */
export async function checkVenue(
  c: Queryable,
  venueId: string,
  open: boolean,
  now: Temporal.Instant,
): Promise<VenueFindings> {
  const firings: Firing[] = [];
  const at = now.toString();

  // Both readers (every live reader) offline during opening hours: no card can be taken.
  if (open) {
    const readers = await c.query<{ total: number; offline: number }>(
      `select count(*)::int as total, count(h.offline_since)::int as offline
         from devices d left join device_heartbeats h on h.device_id = d.id and h.venue_id = d.venue_id
        where d.venue_id = $1 and d.kind = 'reader' and not d.training
          and d.revoked_at is null and d.disabled_at is null`,
      [venueId],
    );
    const r = readers.rows[0]!;
    if (r.total > 0 && r.offline === r.total)
      firings.push({
        rule: "readers-offline",
        key: `readers-offline:${venueId}`,
        summary: `All ${r.total} card readers offline during opening hours at venue ${venueId}`,
      });
  }

  // The hold watch swept a tab to capture and the capture failed.
  const capture = await n(
    c,
    `select count(*)::int as n from tab_closings tc
       join tabs t on t.venue_id = tc.venue_id and t.id = tc.tab_id
      where tc.venue_id = $1 and tc.swept_at is not null and t.state = 'capture_failed'`,
    [venueId],
  );
  if (capture > 0)
    firings.push({
      rule: "capture-sweep-failed",
      key: `capture-sweep-failed:${venueId}`,
      summary: `${capture} swept tab(s) failed to capture at venue ${venueId}`,
    });

  // Money jobs that ran out of attempts.
  const dead = await n(
    c,
    `select count(*)::int as n from jobs
      where venue_id = $1 and status = 'dead' and (pool = 'critical' or kind like any($2::text[]))`,
    [venueId, MONEY_KINDS],
  );
  if (dead > 0)
    firings.push({
      rule: "money-dead-letters",
      key: `money-dead-letters:${venueId}`,
      summary: `${dead} money job(s) in the dead-letter queue at venue ${venueId}`,
    });

  // Stripe webhooks received but not processed for over a minute.
  const lagging = await n(
    c,
    `select count(*)::int as n from webhook_events
      where venue_id = $1 and provider = 'stripe' and processed_at is null and received_at <= $2`,
    [venueId, now.subtract({ seconds: WEBHOOK_LAG_SECONDS }).toString()],
  );
  if (lagging > 0)
    firings.push({
      rule: "webhook-lag",
      key: `webhook-lag:${venueId}`,
      summary: `${lagging} Stripe webhook(s) waiting over a minute at venue ${venueId}`,
    });

  // A payout that doesn't reconcile: one page per payout, ever.
  const payouts = await c.query<{ stripe_payout_id: string }>(
    "select stripe_payout_id from payouts where venue_id = $1 and not reconciled",
    [venueId],
  );
  for (const p of payouts.rows)
    firings.push({
      rule: "payout-unreconciled",
      key: `payout-unreconciled:${p.stripe_payout_id}`,
      summary: `Payout ${p.stripe_payout_id} doesn't reconcile at venue ${venueId}`,
    });

  const refunds = await n(
    c,
    `select count(*)::int as n from refunds r
       join payments p on p.venue_id = r.venue_id and p.id = r.payment_id
      where r.venue_id = $1 and not p.training and r.status in ('pending', 'succeeded')
        and r.requested_at > $2 and r.requested_at <= $3`,
    [venueId, now.subtract({ minutes: REFUND_SPIKE.windowMinutes }).toString(), at],
  );
  if (refunds >= REFUND_SPIKE.minRefunds)
    firings.push({
      rule: "refund-spike",
      key: `refund-spike:${venueId}`,
      summary: `${refunds} refunds in ${REFUND_SPIKE.windowMinutes} min at venue ${venueId}`,
    });

  // Card testing on the booking page: its attempts carry the booking (M5-09 records them).
  const booking = await c.query<{ state: string; decline_code: string | null; n: number }>(
    `select state, decline_code, count(*)::int as n from payment_attempts
      where venue_id = $1 and booking_id is not null and state in ('succeeded', 'failed', 'unknown')
        and coalesce(resolved_at, started_at) > $2 and coalesce(resolved_at, started_at) <= $3
      group by 1, 2`,
    [venueId, now.subtract({ minutes: DECLINE_ALARM.windowMinutes }).toString(), at],
  );
  let declines = 0;
  let attempts = 0;
  for (const a of booking.rows) {
    attempts += a.n;
    if (cardOutcome(a.state, a.decline_code) === "declined") declines += a.n;
  }
  if (declines >= DECLINE_ALARM.minDeclines && declines >= attempts * DECLINE_ALARM.minShare)
    firings.push({
      rule: "decline-rate",
      key: `decline-rate:${venueId}`,
      summary: `${declines} of ${attempts} card attempts declined in ${DECLINE_ALARM.windowMinutes} min on the booking page at venue ${venueId}`,
    });

  const card: Counts = {};
  const alarm: Counts = {};
  if (open)
    for (const minutes of WINDOWS) {
      const since = now.subtract({ minutes }).toString();
      const attempts = await c.query<{ state: string; decline_code: string | null; n: number }>(
        `select state, decline_code, count(*)::int as n from payment_attempts
          where venue_id = $1 and state in ('succeeded', 'failed', 'unknown')
            and coalesce(resolved_at, started_at) > $2 and coalesce(resolved_at, started_at) <= $3
          group by 1, 2`,
        [venueId, since, at],
      );
      let bad = 0;
      let total = 0;
      for (const a of attempts.rows) {
        const outcome = cardOutcome(a.state, a.decline_code);
        if (outcome === "declined" || outcome === null) continue;
        total += a.n;
        if (outcome === "our_side") bad += a.n;
      }
      card[minutes] = { bad, total };
      const rang = await c.query<{ bad: number; total: number }>(
        `select count(*) filter (where rang_at - placed_at >= make_interval(secs => $4::float8 / 1000))::int as bad,
                count(*)::int as total
           from order_traces where venue_id = $1 and rang_at > $2 and rang_at <= $3`,
        [venueId, since, at, TARGETS.orderToAlarm.thresholdMs],
      );
      alarm[minutes] = rang.rows[0]!;
    }
  return { firings, card, alarm };
}

const add = (a: Counts, b: Counts): Counts => {
  const out: Counts = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const m = Number(k);
    out[m] = { bad: (out[m]?.bad ?? 0) + v.bad, total: (out[m]?.total ?? 0) + v.total };
  }
  return out;
};

/** The sweep's checks over every venue, then the burn rates over the venues open now. */
export async function findFirings(pool: pg.Pool, now: Temporal.Instant): Promise<Firing[]> {
  const venues = await pool.query<{ id: string; time_zone: string; day_cutover: string }>(
    "select id, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues_for_scheduler()",
  );
  const firings: Firing[] = [];
  let card: Counts = {};
  let alarm: Counts = {};
  for (const v of venues.rows) {
    const found = await withVenue(pool, { venueId: v.id, requestId: "alert-sweep" }, async (c) =>
      checkVenue(c, v.id, await venueOpenNow(c, v, now), now),
    );
    firings.push(...found.firings);
    card = add(card, found.card);
    alarm = add(alarm, found.alarm);
  }
  const pages = (objective: number, counts: Counts) =>
    firingBurnAlerts(objective, counts).filter((a) => a.severity === "page");
  const cardBurn = pages(TARGETS.cardPayments.objective, card)[0];
  if (cardBurn)
    firings.push({
      rule: "payment-failures",
      key: "payment-failures",
      summary: `Card payments failing on our side: burning ${cardBurn.rate}x over ${cardBurn.longMinutes} min`,
    });
  const alarmBurn = pages(TARGETS.orderToAlarm.objective, alarm)[0];
  if (alarmBurn)
    firings.push({
      rule: "target-burn",
      key: "target-burn:order-to-alarm",
      summary: `Order to bar alarm over 3 s: burning ${alarmBurn.rate}x over ${alarmBurn.longMinutes} min`,
    });
  return firings;
}

const SWEEP_RULES: readonly AlertRuleId[] = [
  "readers-offline",
  "capture-sweep-failed",
  "money-dead-letters",
  "webhook-lag",
  "payment-failures",
  "decline-rate",
  "refund-spike",
];

/** Opens a page per firing and clears what the sweep no longer finds. */
export async function applyFirings(
  pool: pg.Pool,
  firings: readonly Firing[],
  now: Temporal.Instant,
): Promise<string[]> {
  const opened: string[] = [];
  for (const f of firings) {
    const made = await raisePage(pool, f, now);
    if (made?.opened) opened.push(made.page.id);
  }
  for (const rule of SWEEP_RULES)
    await clearPages(
      pool,
      rule,
      firings.filter((f) => f.rule === rule).map((f) => f.key),
      now,
    );
  // target-burn also comes from CloudWatch (keys cw:…); the sweep clears only its own.
  await clearPages(
    pool,
    "target-burn",
    firings.filter((f) => f.rule === "target-burn").map((f) => f.key),
    now,
    "target-burn:",
  );
  return opened;
}

export async function runAlertSweep(
  pool: pg.Pool,
  pager: PagerDeps,
  now: Temporal.Instant,
  log?: (line: string) => void,
) {
  const opened = await applyFirings(pool, await findFirings(pool, now), now);
  for (const id of opened) log?.(`paging: page ${id} opened`);
  return { opened, notified: await notifyPages(pool, pager, now, log) };
}

export function alertSweep(pool: pg.Pool, pager: PagerDeps, log?: (line: string) => void): Sweep {
  return {
    name: "alerts.page",
    everyMs: ALERT_SWEEP_EVERY_MS,
    run: async (now) => void (await runAlertSweep(pool, pager, now, log)),
  };
}
