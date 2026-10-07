import {
  asRetention,
  closeErasure,
  decryptSecret,
  erasureById,
  markTwilioBodyPurged,
  recordCardDetach,
  stripeAccountFor,
  twilioIntegration,
  type JobContext,
  type JobHandler,
  type Queryable,
  type RetentionCounts,
} from "@west4/db";
import { detachCard } from "../stripe/cards.js";
import { StripeError } from "../stripe/client.js";
import { savedCardOf } from "../stripe/payments.js";
import type { RetentionDeps } from "./retention.js";

/**
 * The outside half of erasing a guest or a singer (M8-13): the erase route
 * blanks the rows and lists what Stripe and Twilio still hold; this job
 * detaches those saved cards and redacts those message bodies, each call
 * between transactions with its own idempotency key (M8-12's `detachCard()`
 * and `redact()`), then marks the erasure done. No answer fails the job, so
 * the queue tries again with the same keys; a card or body already handled
 * is skipped. The venue comes from the job row; every step runs as
 * app_retention behind its wall.
 */
export const ERASE_KIND = "guests.erase";

export function makeEraseHandler(deps: RetentionDeps = {}): JobHandler {
  return async (context) => {
    await runErase(context, deps);
  };
}

export async function runErase(
  { job, clock, step }: Pick<JobContext, "job" | "clock" | "step">,
  deps: RetentionDeps,
): Promise<{ removed: RetentionCounts; done: boolean }> {
  const venueId = job.venue_id;
  const erasureId = String((job.payload as { erasure_id?: unknown } | null)?.erasure_id ?? "");
  const now = clock.now();
  const as = <T>(work: (c: Queryable) => Promise<T>) =>
    step(async (c) => {
      await asRetention(c);
      return work(c);
    });
  const found = /^[0-9a-f-]{36}$/i.test(erasureId)
    ? await as((c) => erasureById(c, venueId, erasureId))
    : null;
  const removed: RetentionCounts = { cards_detached: 0, message_bodies_at_twilio: 0 };
  if (!found || found.state === "done") return { removed, done: true };
  const cards = found.pending.cards ?? [];
  const messages = found.pending.messages ?? [];
  const skipped: string[] = [];
  let unanswered = 0;

  if (cards.length > 0 && !deps.stripe) skipped.push("no Stripe client in this environment");
  else
    for (const card of cards) {
      const account = await step((c) => stripeAccountFor(c, venueId, card.training));
      if (!account) {
        skipped.push("the venue has no Stripe account");
        continue;
      }
      const stripe = deps.stripe!.forTraining(card.training);
      try {
        let pm = card.payment_method;
        if (!pm && card.deposit_pi)
          // A deposit Stripe no longer has leaves no card to detach.
          pm = await savedCardOf(stripe, account, card.deposit_pi).then(
            (saved) => saved?.paymentMethod ?? null,
            (error: unknown) => {
              if (error instanceof StripeError && error.code === "resource_missing") return null;
              throw error;
            },
          );
        const outcome = pm
          ? await detachCard(stripe, account, pm, `erase:detach:${card.source}:${card.source_id}`)
          : "gone";
        await as((c) => recordCardDetach(c, venueId, card, pm, outcome, now));
        if (outcome === "detached") removed["cards_detached"]! += 1;
      } catch {
        unanswered += 1;
      }
    }

  if (messages.length > 0) {
    const twilio = await step((c) => twilioIntegration(c, venueId));
    const redact = deps.texts?.client.redact?.bind(deps.texts.client);
    if (!redact || !deps.texts) skipped.push("no Twilio client in this environment");
    else if (!twilio) skipped.push("the venue has no Twilio subaccount");
    else {
      const account = {
        accountSid: twilio.accountSid,
        authToken: decryptSecret(deps.texts.secretKey, twilio.secretEnc),
      };
      for (const m of messages) {
        try {
          await redact(account, m.provider_sid, `erase:redact:${m.id}`);
          await as((c) => markTwilioBodyPurged(c, venueId, m.id, now));
          removed["message_bodies_at_twilio"]! += 1;
        } catch {
          unanswered += 1;
        }
      }
    }
  }

  if (unanswered > 0) {
    throw new Error(
      `${unanswered} not answered by Stripe or Twilio; tried again with the same keys`,
    );
  }
  const done = skipped.length === 0;
  await as((c) =>
    closeErasure(
      c,
      venueId,
      erasureId,
      done ? removed : { ...removed, skipped: skipped.join("; ") },
      done ? now : null,
    ),
  );
  return { removed, done };
}
