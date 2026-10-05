import type { StripeClient } from "./client.js";
import type { StripeIntent } from "./payments.js";

/**
 * A bar tab's opening hold (M6-06; Payment flows · Bar tab with a growing hold,
 * step 1): a Customer, a manual-capture PaymentIntent that asks for
 * incremental authorization and saves the card, and the bar reader collecting
 * the card first, so the API can check the card before the hold is confirmed.
 * Every call runs outside any transaction with its own idempotency key.
 */
export async function createTabCustomer(
  stripe: StripeClient,
  account: string,
  paymentId: string,
): Promise<{ id: string }> {
  return stripe.call("payments", "POST", "/v1/customers", {
    account,
    idempotencyKey: `${paymentId}:customer`,
    params: { metadata: { payment_id: paymentId } },
  });
}

export async function createTabIntent(
  stripe: StripeClient,
  account: string,
  input: { amountCents: number; paymentId: string; customer: string },
): Promise<StripeIntent> {
  return stripe.call("payments", "POST", "/v1/payment_intents", {
    account,
    // One PaymentIntent per payment, as every reader payment (M4-12).
    idempotencyKey: `${input.paymentId}:create`,
    params: {
      amount: input.amountCents,
      currency: "usd",
      payment_method_types: ["card_present"],
      capture_method: "manual",
      payment_method_options: {
        card_present: { request_incremental_authorization_support: true },
      },
      setup_future_usage: "off_session",
      customer: input.customer,
      metadata: { payment_id: input.paymentId, purpose: "tab_hold" },
    },
  });
}

/**
 * The reader reads the card and attaches it; nothing is held until confirm. No tip on a hold, and
 * `allow_redisplay=limited`, which Stripe requires with `setup_future_usage` since 2024-09-30.acacia.
 */
export async function collectForTab(
  stripe: StripeClient,
  account: string,
  input: { readerId: string; piId: string },
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
        collect_config: { skip_tipping: true, allow_redisplay: "limited" },
      },
    },
  );
}

/** The collected card: brand, last four, fingerprint, and the cardholder's name from a dip or swipe. */
export interface CollectedCard {
  readonly status: string;
  readonly brand: string | null;
  readonly last4: string | null;
  readonly fingerprint: string | null;
  readonly cardholderName: string | null;
}

export async function retrieveCollectedCard(
  stripe: StripeClient,
  account: string,
  piId: string,
): Promise<CollectedCard> {
  const pi = await stripe.call<{
    status: string;
    payment_method?:
      | {
          card_present?: {
            brand?: string;
            last4?: string;
            fingerprint?: string | null;
            cardholder_name?: string | null;
          };
        }
      | string
      | null;
  }>("payments", "GET", `/v1/payment_intents/${encodeURIComponent(piId)}`, {
    account,
    params: { expand: ["payment_method"] },
  });
  const card =
    typeof pi.payment_method === "object" && pi.payment_method
      ? pi.payment_method.card_present
      : undefined;
  return {
    status: pi.status,
    brand: card?.brand ?? null,
    last4: card?.last4 ?? null,
    fingerprint: card?.fingerprint ?? null,
    cardholderName: card?.cardholder_name ?? null,
  };
}
