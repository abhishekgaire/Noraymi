import type { StripeClient } from "./client.js";
import type { StripeIntent } from "./payments.js";

/**
 * The card fee's Stripe calls (M4-25; Money rules 10; Payment flows · Card fee at the reader): collect,
 * the surcharge through Stripe's preview surcharge API, and confirm. The only place the preview version
 * is used (scripts/check-stripe-versions.sh keeps it here).
 */
/** Stripe's surcharge API needs this preview version, on this path only (Money rules 10; M4-25). */
export const SURCHARGE_PREVIEW_VERSION = "2026-03-25.preview";

/** The surcharge path's first step: the reader reads the card and attaches it; nothing is charged yet. */
export async function collectOnReader(
  stripe: StripeClient,
  account: string,
  input: {
    readerId: string;
    piId: string;
    skipTipping: boolean;
    amountEligibleCents?: number | null;
  },
  idempotencyKey: string,
): Promise<unknown> {
  return stripe.call(
    "payments",
    "POST",
    `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/collect_payment_method`,
    {
      account,
      idempotencyKey,
      params: {
        payment_intent: input.piId,
        ...(input.skipTipping
          ? { collect_config: { skip_tipping: true } }
          : input.amountEligibleCents
            ? { collect_config: { tipping: { amount_eligible: input.amountEligibleCents } } }
            : {}),
      },
    },
  );
}

/** A collected PaymentIntent with its card, to read the funding type. */
export async function retrieveCollected(
  stripe: StripeClient,
  account: string,
  piId: string,
): Promise<
  StripeIntent & {
    amount: number;
    payment_method?: { card_present?: { funding?: string } } | string | null;
    amount_details?: { surcharge?: { amount?: number }; tip?: { amount?: number } };
  }
> {
  return stripe.call("payments", "GET", `/v1/payment_intents/${encodeURIComponent(piId)}`, {
    account,
    params: { expand: ["payment_method"] },
  });
}

/** The new total with the surcharge, between collect and confirm (Stripe's 30-second window). */
export async function setSurcharge(
  stripe: StripeClient,
  account: string,
  piId: string,
  input: { amountCents: number; surchargeCents: number },
  idempotencyKey: string,
): Promise<unknown> {
  return stripe.call("payments", "POST", `/v1/payment_intents/${encodeURIComponent(piId)}`, {
    account,
    idempotencyKey,
    version: SURCHARGE_PREVIEW_VERSION,
    params: {
      amount: input.amountCents,
      amount_details: { surcharge: { amount: input.surchargeCents } },
    },
  });
}

export async function confirmOnReader(
  stripe: StripeClient,
  account: string,
  input: { readerId: string; piId: string },
  idempotencyKey: string,
): Promise<unknown> {
  return stripe.call(
    "payments",
    "POST",
    `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/confirm_payment_intent`,
    { account, idempotencyKey, params: { payment_intent: input.piId } },
  );
}
