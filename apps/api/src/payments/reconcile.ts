import type pg from "pg";
import {
  emitEvent,
  enqueue,
  setPaymentIntent,
  stripeAccountOf,
  withVenue,
  type JobHandler,
  type Queryable,
  type Sweep,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { StripeError, StripeUnknownResult } from "../stripe/client.js";
import { createReaderIntent, observeIntent, type StripeIntent } from "../stripe/payments.js";
import { cancelPayment, cancelReplacedHold, checkNow, type PaymentDeps } from "./run.js";
import { holdsToCancel } from "../tabs/pay.js";

/**
 * The reconciler (M4-12; Payment flows step 5; Stripe setup 6 and 11). Every
 * 5 minutes, one job per venue on the critical pool:
 *  1. attempts unknown (or still started) for more than 2 minutes are read
 *     again through the state machine, and canceled if still unclear (the
 *     cancel records a success if it finds one);
 *  2. a payment whose PaymentIntent id was never stored gets it back by sending
 *     its create call again with the same key (<payment_id>:create): Stripe
 *     answers with the same PaymentIntent for 24 hours. It's adopted if it
 *     went through and canceled if no attempt ran;
 *  3. the account's recent PaymentIntents with no row of ours (a break-glass
 *     Tap to Pay payment from Stripe's Dashboard app) are recorded as
 *     unmatched: a `payments` row with method `external`, no allocation, and
 *     a reconciler event, for M7's Unmatched payments list;
 *  4. a bar tab's hold still standing after another card or cash paid the tab
 *     (M6-11) is canceled, keyed <payment_id>:cancel (run before 3).
 * Nothing is ever matched by metadata. Every Stripe call is outside a transaction.
 */
export const RECONCILE_KIND = "payment.reconcile";
export const RECONCILE_EVERY_MS = 5 * 60_000;
export const STALE_AFTER_S = 120;

export interface Reconciled {
  readonly resolved: string[];
  readonly recovered: string[];
  readonly unmatched: string[];
}

export async function reconcileVenue(deps: PaymentDeps, venueId: string): Promise<Reconciled> {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: "reconciler" }, work);
  const now = deps.clock.now();
  const before = new Date(now.subtract({ seconds: STALE_AFTER_S }).epochMilliseconds);
  const account = await inVenue((c) => stripeAccountOf(c, venueId));
  const out: Reconciled = { resolved: [], recovered: [], unmatched: [] };
  if (!account) return out;

  // 1 and 2: open attempts older than 2 minutes, with or without a stored PaymentIntent.
  const stale = await inVenue((c) =>
    c.query<{
      payment_id: string;
      stripe_pi_id: string | null;
      attempt_no: number;
      amount_cents: string;
      check_id: string | null;
    }>(
      `select a.payment_id, p.stripe_pi_id, a.attempt_no, a.amount_cents, a.check_id
         from payment_attempts a join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
        where a.venue_id = $1 and a.state in ('started', 'unknown') and a.started_at < $2
          and p.method in ('card_present', 'card_online', 'card_on_file')
        order by a.started_at`,
      [venueId, before],
    ),
  );
  for (const row of stale.rows) {
    if (!row.stripe_pi_id) {
      // The API died after Stripe made the PaymentIntent and before we stored its id: the same create
      // call with the same key and the same parameters answers with that PaymentIntent.
      const first = await inVenue((c) =>
        c.query<{ amount_cents: string; check_id: string | null }>(
          "select amount_cents, check_id from payment_attempts where venue_id = $1 and payment_id = $2 order by attempt_no limit 1",
          [venueId, row.payment_id],
        ),
      );
      let pi: StripeIntent;
      try {
        pi = await createReaderIntent(deps.stripe, account, {
          amountCents: Number(first.rows[0]!.amount_cents),
          paymentId: row.payment_id,
          checkId: first.rows[0]!.check_id,
        });
      } catch (e) {
        if (e instanceof StripeError || e instanceof StripeUnknownResult) continue;
        throw e;
      }
      await inVenue((c) => setPaymentIntent(c, row.payment_id, pi.id));
      out.recovered.push(row.payment_id);
    }
    const applied = await checkNow(deps, venueId, row.payment_id, "reconciler");
    if (
      applied?.attempt &&
      (applied.attempt.state === "started" || applied.attempt.state === "unknown")
    )
      await cancelPayment(deps, venueId, row.payment_id, "reconciler");
    out.resolved.push(row.payment_id);
  }

  // 4 (M6-11): a bar tab paid another way whose hold is still standing (the API died after the new card
  // or the cash and before the cancel): the hold is canceled now, once, by the same key.
  const replaced = await inVenue((c) => holdsToCancel(c, venueId));
  for (const id of replaced) {
    try {
      await cancelReplacedHold(deps, venueId, id, "reconciler");
      out.resolved.push(id);
    } catch (e) {
      if (!(e instanceof StripeUnknownResult)) throw e;
    }
  }

  // 3: the account's recent PaymentIntents with no row of ours.
  let page: { data: StripeIntent[] };
  try {
    page = await deps.stripe.call<{ data: StripeIntent[] }>(
      "payments",
      "GET",
      "/v1/payment_intents",
      {
        account,
        params: {
          limit: 100,
          created: { gte: Math.floor(now.subtract({ hours: 24 }).epochMilliseconds / 1000) },
          expand: ["data.latest_charge"],
        },
      },
    );
  } catch (e) {
    if (e instanceof StripeError || e instanceof StripeUnknownResult) return out;
    throw e;
  }
  const succeeded = page.data.filter((pi) => pi.status === "succeeded");
  if (succeeded.length === 0) return out;
  const known = await inVenue((c) =>
    c.query<{ id: string }>(
      "select stripe_pi_id as id from payments where stripe_pi_id = any($1::text[])",
      [succeeded.map((pi) => pi.id)],
    ),
  );
  const ours = new Set(known.rows.map((r) => r.id));
  // A PaymentIntent another venue of the organization already recorded is that venue's.
  for (const pi of succeeded.filter((x) => !ours.has(x.id))) {
    const recorded = await recordUnmatched(deps, venueId, pi, now);
    if (recorded) out.unmatched.push(recorded);
  }
  return out;
}

async function recordUnmatched(
  deps: PaymentDeps,
  venueId: string,
  pi: StripeIntent,
  now: Temporal.Instant,
): Promise<string | null> {
  const seen = observeIntent(pi);
  return withVenue(deps.pool, { venueId, requestId: "reconciler" }, async (c) => {
    const v = (
      await c.query<{ time_zone: string; day_cutover: string }>(
        "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
        [venueId],
      )
    ).rows[0]!;
    const date = businessDate(now, v.time_zone, v.day_cutover).businessDate.toString();
    const r = await c.query<{ id: string }>(
      `insert into payments (venue_id, method, status, stripe_pi_id, amount_cents, card_brand, card_last4, card_funding,
         business_date)
       values ($1, 'external', 'captured', $2, $3, $4, $5, $6, $7)
       on conflict (stripe_pi_id) do nothing returning id`,
      [
        venueId,
        pi.id,
        seen.amountReceived,
        seen.card?.brand ?? null,
        seen.card?.last4 ?? null,
        seen.card?.funding ?? null,
        date,
      ],
    );
    const id = r.rows[0]?.id;
    if (!id) return null;
    await c.query(
      "insert into payment_events (venue_id, payment_id, from_status, to_status, source) values ($1, $2, null, 'captured', 'reconciler')",
      [venueId, id],
    );
    await emitEvent(c, { venueId, type: "payment.unmatched", entityId: id, audience: "managers" });
    return id;
  });
}

export function makeReconcileHandler(deps: PaymentDeps): JobHandler {
  return async (job) => {
    await reconcileVenue(deps, job.job.venue_id);
  };
}

/** The scheduler's leader queues one reconcile job per venue every 5 minutes. */
export function reconcileSweep(pool: pg.Pool): Sweep {
  return {
    name: "payments.reconcile",
    everyMs: RECONCILE_EVERY_MS,
    run: async (now) => {
      const slot = Math.floor(now.epochMilliseconds / RECONCILE_EVERY_MS);
      const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
      for (const v of venues.rows)
        await withVenue(pool, { venueId: v.id, requestId: "reconcile-sweep" }, (c) =>
          enqueue(c, {
            venueId: v.id,
            kind: RECONCILE_KIND,
            pool: "critical",
            dedupeKey: `${RECONCILE_KIND}:${v.id}:${slot}`,
            payload: {},
            runAt: now,
            maxAttempts: 2,
          }),
        );
    },
  };
}
