import { paymentByIntent } from "@west4/db";
import { stripeEventHandlers, type StripeEventHandler } from "../stripe/webhooks.js";
import { checkNow } from "./run.js";
import { confirmCollected } from "./surcharge.js";
import { checkClose } from "../tabs/close.js";
import { checkSavedCard, confirmOfStep } from "../tabs/saved-card.js";

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
  if (!piId) {
    // A question on the bar reader at a tab's close (M6-08): its answer is read through the closing.
    const step = (
      data?.object?.["action"] as
        { collect_inputs?: { metadata?: Record<string, string> } } | undefined
    )?.collect_inputs?.metadata?.["step"];
    // Charge the saved card on a reopened tab (M6-12): the guest's Yes or No.
    const confirmId = confirmOfStep(step);
    if (confirmId) {
      await checkSavedCard(
        { pool: ctx.pool, stripe: ctx.stripe, clock: { now: () => ctx.now } },
        ctx.venueId,
        confirmId,
      );
      return;
    }
    const closingId = step?.split(":")[0];
    if (closingId && /^[0-9a-f-]{36}$/.test(closingId))
      await checkClose(
        { pool: ctx.pool, stripe: ctx.stripe, clock: { now: () => ctx.now } },
        ctx.venueId,
        closingId,
      );
    return;
  }
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
