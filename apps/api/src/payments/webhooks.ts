import { paymentByIntent } from "@west4/db";
import { stripeEventHandlers, type StripeEventHandler } from "../stripe/webhooks.js";
import { checkNow } from "./run.js";
import { confirmCollected } from "./surcharge.js";

/**
 * Payment events (M4-05; Stripe setup 6): each finds our payment by the
 * PaymentIntent's id (never by metadata, which the owner can edit in their
 * Dashboard), reads the PaymentIntent and the reader again from Stripe, and
 * records it through the same state machine as check-status and the
 * reconciler. An event for a payment we don't have changes nothing here; the
 * reconciler (M4-12) looks for those.
 */
const intentOf = (object: Record<string, unknown> | undefined, type: string): string | null => {
  if (!object) return null;
  if (type.startsWith("terminal.reader.")) {
    type Step = { payment_intent?: string } | undefined;
    const action = object["action"] as
      | {
          process_payment_intent?: Step;
          collect_payment_method?: Step;
          confirm_payment_intent?: Step;
        }
      | undefined;
    // Process, or the surcharge path's collect and confirm (M4-25).
    return (
      action?.process_payment_intent?.payment_intent ??
      action?.collect_payment_method?.payment_intent ??
      action?.confirm_payment_intent?.payment_intent ??
      null
    );
  }
  return typeof object["id"] === "string" ? object["id"] : null;
};

const handlePayment: StripeEventHandler = async (ctx) => {
  const data = ctx.event.payload["data"] as { object?: Record<string, unknown> } | undefined;
  const piId = intentOf(data?.object, ctx.event.type);
  if (!piId) return;
  const payment = await ctx.inVenue((c) => paymentByIntent(c, ctx.venueId, piId));
  if (!payment) return;
  // A card collected on the surcharge path (M4-25): the fee, then confirm.
  if (ctx.event.type === "terminal.reader.action_succeeded")
    await confirmCollected(
      { pool: ctx.pool, stripe: ctx.stripe, clock: { now: () => ctx.now } },
      ctx.venueId,
      payment.id,
    );
  await checkNow(
    { pool: ctx.pool, stripe: ctx.stripe, clock: { now: () => ctx.now } },
    ctx.venueId,
    payment.id,
    "webhook",
    ctx.event.event_id,
  );
};

for (const type of [
  "payment_intent.succeeded",
  "payment_intent.amount_capturable_updated",
  "payment_intent.payment_failed",
  "payment_intent.requires_action",
  "payment_intent.canceled",
  "terminal.reader.action_succeeded",
  "terminal.reader.action_failed",
  "terminal.reader.action_updated",
])
  stripeEventHandlers.set(type, handlePayment);
