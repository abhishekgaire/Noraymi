import {
  asRetention,
  decryptSecret,
  dueCards,
  dueNightKeys,
  markNightKeyDestroyed,
  dueTwilioBodies,
  hashOptOuts,
  markTwilioBodyPurged,
  pseudonymize,
  recordCardDetach,
  recordRetentionRun,
  removeExpired,
  removeTexts,
  retentionCutoffs,
  stripeAccountFor,
  twilioIntegration,
  type JobContext,
  type JobHandler,
  type RetentionCounts,
  type Schedule,
} from "@west4/db";
import type { IdKeyStore } from "../id-keys/store.js";
import { venueClock } from "../rooms/assignment.js";
import { builtInRulePacks } from "@west4/shared";
import { detachCard } from "../stripe/cards.js";
import type { StripeClient } from "../stripe/client.js";
import { savedCardOf } from "../stripe/payments.js";
import type { VenueTextClient } from "../texts/venue.js";

/**
 * The nightly retention job (M8-12; Security and data retention · How long we
 * keep things): one job per venue, its venue taken from the job row. Every
 * database step runs as app_retention, which sees and changes only this
 * venue's rows and only what the policy table lets go. Cards are detached at
 * Stripe and bodies redacted at Twilio between steps, never inside one, each
 * call with its own idempotency key. The run's log is counts per kind, kept
 * in retention_runs; a second run removes nothing new.
 */
export const RETENTION_KIND = "retention.nightly";

/** A night's key that sealed no scan goes after the default `idScan.keepDays` (7, until the lawyer answers). */
const ORPHAN_KEY_DAYS = builtInRulePacks[0]!.idScan.keepDays;

/** 5:15 AM on the business date's morning: after the 4 AM close, before the 6 AM cutover. */
export const retentionSchedule: Schedule = { kind: RETENTION_KIND, at: "05:15", pool: "bulk" };

export interface RetentionDeps {
  readonly stripe?: StripeClient;
  /** The ID-scan key store (M8-14). */
  readonly idKeys?: IdKeyStore;
  readonly texts?: { readonly client: VenueTextClient; readonly secretKey: Buffer };
  readonly log?: (line: string) => void;
}

export function makeRetentionHandler(deps: RetentionDeps = {}): JobHandler {
  return async (context) => {
    await runRetention(context, deps);
  };
}

export async function runRetention(
  { job, clock, step }: Pick<JobContext, "job" | "clock" | "step">,
  deps: RetentionDeps,
): Promise<{ removed: RetentionCounts; skipped: Record<string, string> }> {
  const venueId = job.venue_id;
  const now = clock.now();
  const { timeZone } = await step((c) => venueClock(c, venueId));
  const cut = retentionCutoffs(now, timeZone);
  const removed: RetentionCounts = {};
  const skipped: Record<string, string> = {};

  // Opt-outs become keyed hashes first, so nothing below can lose one.
  removed["opt_out_hashes"] = await step(async (c) => {
    await asRetention(c);
    return hashOptOuts(c, venueId);
  });

  // Saved cards at Stripe: the booking's 30 days after it closes, a tab's 7 days after.
  removed["booking_cards"] = 0;
  removed["tab_cards"] = 0;
  if (!deps.stripe) skipped["cards"] = "no Stripe client in this environment";
  else {
    const cards = await step(async (c) => {
      await asRetention(c);
      return dueCards(c, venueId, cut);
    });
    let unanswered = 0;
    for (const card of cards) {
      const account = await step((c) => stripeAccountFor(c, venueId, card.training));
      if (!account) {
        skipped["cards"] = "the venue has no Stripe account";
        continue;
      }
      const stripe = deps.stripe.forTraining(card.training);
      try {
        let pm = card.payment_method;
        if (!pm && card.deposit_pi)
          pm = (await savedCardOf(stripe, account, card.deposit_pi))?.paymentMethod ?? null;
        const outcome = pm
          ? await detachCard(
              stripe,
              account,
              pm,
              `retention:detach:${card.source}:${card.source_id}`,
            )
          : "gone";
        await step(async (c) => {
          await asRetention(c);
          await recordCardDetach(c, venueId, card, pm, outcome, now);
        });
        if (outcome === "detached")
          removed[card.source === "booking" ? "booking_cards" : "tab_cards"]! += 1;
      } catch {
        // No answer: the same key is sent again on the next run; nothing is recorded until Stripe answers.
        unanswered += 1;
      }
    }
    if (unanswered > 0)
      skipped["cards"] = `${unanswered} not answered by Stripe; tried again next run`;
  }

  // Message bodies at Twilio after 30 days; our own copy follows the messages row.
  removed["message_bodies_at_twilio"] = 0;
  const redact = deps.texts?.client.redact?.bind(deps.texts.client);
  const due = await step(async (c) => {
    const twilio = await twilioIntegration(c, venueId);
    await asRetention(c);
    return { twilio, bodies: await dueTwilioBodies(c, venueId, cut) };
  });
  if (due.bodies.length > 0) {
    if (!redact || !deps.texts)
      skipped["message_bodies_at_twilio"] = "no Twilio client in this environment";
    else if (!due.twilio)
      skipped["message_bodies_at_twilio"] = "the venue has no Twilio subaccount";
    else {
      const account = {
        accountSid: due.twilio.accountSid,
        authToken: decryptSecret(deps.texts.secretKey, due.twilio.secretEnc),
      };
      let unanswered = 0;
      for (const m of due.bodies) {
        try {
          await redact(account, m.provider_sid, `retention:redact:${m.id}`);
          await step(async (c) => {
            await asRetention(c);
            await markTwilioBodyPurged(c, venueId, m.id, now);
          });
          removed["message_bodies_at_twilio"] += 1;
        } catch {
          unanswered += 1;
        }
      }
      if (unanswered > 0)
        skipped["message_bodies_at_twilio"] =
          `${unanswered} not answered by Twilio; tried again next run`;
    }
  }

  // ID-scan keys (M8-14): each night's key is destroyed in the key store once every scan sealed with
  // it is past its delete_after (the night plus `idScan.keepDays`), then its row is marked (an audit
  // row each). The id_checks rows and their count stay.
  removed["id_scan_keys"] = 0;
  const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
  const keys = await step(async (c) => {
    await asRetention(c);
    return dueNightKeys(c, venueId, today.toString(), ORPHAN_KEY_DAYS);
  });
  if (keys.length > 0) {
    if (!deps.idKeys) skipped["id_scan_keys"] = "no key store in this environment";
    else {
      let unanswered = 0;
      for (const k of keys) {
        try {
          if (k.key_ref) await deps.idKeys.destroy(k.key_ref);
          await step(async (c) => {
            await asRetention(c);
            await markNightKeyDestroyed(c, venueId, k.id, now.toString());
          });
          removed["id_scan_keys"] += 1;
          deps.log?.(`retention ${venueId}: destroyed the ID-scan key for ${k.business_date}`);
        } catch {
          unanswered += 1; // tried again on the next run; the row stays until the key store answers
        }
      }
      if (unanswered > 0)
        skipped["id_scan_keys"] =
          `${unanswered} not destroyed by the key store; tried again next run`;
    }
  }

  // Then the rows: after the outside calls, so a message is deleted only once Twilio has blanked it.
  Object.assign(
    removed,
    await step(async (c) => {
      await asRetention(c);
      return pseudonymize(c, venueId, cut, now);
    }),
    await step(async (c) => {
      await asRetention(c);
      return removeTexts(c, venueId, cut);
    }),
    await step(async (c) => {
      await asRetention(c);
      return removeExpired(c, venueId, cut, now);
    }),
  );

  await step(async (c) => {
    await asRetention(c);
    await recordRetentionRun(c, venueId, removed, skipped, now);
  });
  deps.log?.(
    `retention ${venueId}: ${Object.entries(removed)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
  return { removed, skipped };
}
