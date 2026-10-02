import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import {
  markStripeEventProcessed,
  stripeEventRow,
  withVenue,
  type JobHandler,
  type Queryable,
  type StripeEventRow,
} from "@west4/db";
import type { Temporal } from "@west4/shared";
import type { StripeClient } from "./client.js";
import type { StripeEndpoint } from "./settings.js";
import { syncAccount } from "./account-sync.js";

/**
 * Stripe webhooks (M4-03; Stripe setup 6). The routes check the endpoint's own
 * signature and the livemode, store the event once and queue `stripe.event`;
 * this job applies it: reader events on the critical pool, venue payments on
 * the normal one. Each event type has a handler, added by the ticket that
 * needs it; a type with none yet (payouts in M7, our billing in M8) stays
 * stored and unprocessed for that handler to pick up. Handlers read the object
 * again from Stripe and find our rows by Stripe's ids, never by metadata.
 */
export const STRIPE_EVENT_KIND = "stripe.event";
/** Stripe's default tolerance between the signature's time and ours. */
export const SIGNATURE_TOLERANCE_S = 300;

export const ENDPOINT_EVENTS: Readonly<Record<StripeEndpoint, readonly string[]>> = {
  readers: [
    "terminal.reader.action_succeeded",
    "terminal.reader.action_failed",
    "terminal.reader.action_updated",
  ],
  connect: [
    "payment_intent.succeeded",
    "payment_intent.amount_capturable_updated",
    "payment_intent.payment_failed",
    "payment_intent.requires_action",
    "payment_intent.canceled",
    "charge.refunded",
    "refund.updated",
    "refund.failed",
    "charge.dispute.created",
    "charge.dispute.closed",
    "charge.dispute.funds_withdrawn",
    "charge.dispute.funds_reinstated",
    "payout.reconciliation_completed",
    "account.updated",
  ],
  platform: [
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
  ],
};

/** Stripe-Signature: t=…,v1=… (one or more v1). Checked against the endpoint's own secret. */
export function validStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string,
  nowSeconds: number,
  toleranceS = SIGNATURE_TOLERANCE_S,
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isFinite(t) || sigs.length === 0) return false;
  if (Math.abs(nowSeconds - t) > toleranceS) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex"),
  );
  return sigs.some((s) => {
    const got = Buffer.from(s);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export interface StripeEventContext {
  readonly pool: pg.Pool;
  readonly stripe: StripeClient;
  readonly venueId: string;
  readonly event: StripeEventRow;
  readonly now: Temporal.Instant;
  /** A short transaction with the venue set. */
  readonly inVenue: <T>(work: (c: Queryable) => Promise<T>) => Promise<T>;
}
export type StripeEventHandler = (ctx: StripeEventContext) => Promise<void>;

/** Each event type's handler; later tickets add theirs (payments in M4-05, refunds, disputes). */
export const stripeEventHandlers = new Map<string, StripeEventHandler>([
  // The account's status, read again from Stripe, into Admin → Payments (M4-01).
  [
    "account.updated",
    async (ctx) => {
      await syncAccount(ctx.inVenue, ctx.stripe, ctx.venueId, ctx.now.toString());
    },
  ],
]);

/** The `stripe.event` job: apply the stored event once, then mark it processed. */
export function makeStripeEventHandler(pool: pg.Pool, stripe: StripeClient): JobHandler {
  return async (job) => {
    const venueId = job.job.venue_id;
    const rowId = (job.job.payload as { webhook_event_id?: string }).webhook_event_id;
    if (!rowId) return;
    const event = await job.step((c) => stripeEventRow(c, venueId, rowId));
    if (!event || event.processed_at) return;
    const handler = stripeEventHandlers.get(event.type);
    if (!handler) return; // stored for the ticket whose handler comes later
    await handler({
      pool,
      stripe,
      venueId,
      event,
      now: job.clock.now(),
      inVenue: (work) => withVenue(pool, { venueId, requestId: `stripe:${event.event_id}` }, work),
    });
    await job.step((c) => markStripeEventProcessed(c, venueId, rowId));
  };
}
