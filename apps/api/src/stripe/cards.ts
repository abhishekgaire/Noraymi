import { StripeError, type StripeClient } from "./client.js";

/**
 * Detaching a saved card on the venue's account (M8-12; Security and data
 * retention · How long we keep things): after it the card can't be charged
 * off-session again. Called between transactions, keyed
 * `retention:detach:<source>:<id>` so a rerun after no answer is the same
 * request. A card Stripe no longer has, or one already detached, is "gone".
 */
export async function detachCard(
  stripe: StripeClient,
  account: string,
  paymentMethod: string,
  idempotencyKey: string,
): Promise<"detached" | "gone"> {
  try {
    await stripe.call(
      "payments",
      "POST",
      `/v1/payment_methods/${encodeURIComponent(paymentMethod)}/detach`,
      { account, idempotencyKey },
    );
    return "detached";
  } catch (error) {
    if (
      error instanceof StripeError &&
      (error.code === "resource_missing" ||
        error.code === "payment_method_unexpected_state" ||
        /not attached/i.test(error.message))
    )
      return "gone";
    throw error;
  }
}
