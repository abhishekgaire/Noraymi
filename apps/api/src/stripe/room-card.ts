import type { StripeClient } from "./client.js";

/**
 * A card tapped for a room (M6-13; Payment flows · Moving a tab into a room): a Customer, a SetupIntent
 * for a card present on the reader, and `process_setup_intent` on the reader, which saves the card
 * without charging it. The reusable card is the one the reader generates from the tap
 * (`generated_card`). Every call runs outside any transaction with its own idempotency key, built from the
 * tap's id.
 */
export async function createRoomCustomer(
  stripe: StripeClient,
  account: string,
  tapId: string,
): Promise<{ id: string }> {
  return stripe.call("payments", "POST", "/v1/customers", {
    account,
    idempotencyKey: `${tapId}:customer`,
    params: { metadata: { check_card_id: tapId } },
  });
}

export interface StripeSetupIntent {
  readonly id: string;
  readonly status: string;
  readonly payment_method?: string | { id: string } | null;
  readonly last_setup_error?: { code?: string; decline_code?: string } | null;
  readonly latest_attempt?:
    | string
    | {
        readonly payment_method_details?: {
          readonly card_present?: {
            readonly brand?: string | null;
            readonly last4?: string | null;
            readonly generated_card?: string | null;
          };
        };
      }
    | null;
}

export async function createRoomSetupIntent(
  stripe: StripeClient,
  account: string,
  input: { tapId: string; customer: string; checkId: string },
): Promise<StripeSetupIntent> {
  return stripe.call("payments", "POST", "/v1/setup_intents", {
    account,
    idempotencyKey: `${input.tapId}:create`,
    params: {
      customer: input.customer,
      payment_method_types: ["card_present"],
      usage: "off_session",
      metadata: { check_card_id: input.tapId, check_id: input.checkId, purpose: "room_card" },
    },
  });
}

/** The reader asks for the card; `allow_redisplay` is required for a saved card. */
export async function processRoomSetupIntent(
  stripe: StripeClient,
  account: string,
  input: { tapId: string; readerId: string; setupIntent: string },
): Promise<unknown> {
  return stripe.call(
    "payments",
    "POST",
    `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/process_setup_intent`,
    {
      account,
      idempotencyKey: `${input.tapId}:process`,
      params: { setup_intent: input.setupIntent, allow_redisplay: "limited" },
    },
  );
}

export async function retrieveRoomSetupIntent(
  stripe: StripeClient,
  account: string,
  id: string,
): Promise<StripeSetupIntent> {
  return stripe.call("payments", "GET", `/v1/setup_intents/${encodeURIComponent(id)}`, {
    account,
    params: { expand: ["latest_attempt"] },
  });
}

export async function cancelRoomSetupIntent(
  stripe: StripeClient,
  account: string,
  input: { tapId: string; setupIntent: string },
): Promise<StripeSetupIntent> {
  return stripe.call(
    "payments",
    "POST",
    `/v1/setup_intents/${encodeURIComponent(input.setupIntent)}/cancel`,
    { account, idempotencyKey: `${input.tapId}:cancel`, params: {} },
  );
}

/** The reader's current action, to read a tap that failed on the reader. */
export async function readerAction(
  stripe: StripeClient,
  account: string,
  readerId: string,
): Promise<{ type?: string; status?: string; failure_code?: string | null } | null> {
  const reader = await stripe.call<{
    action: { type?: string; status?: string; failure_code?: string | null } | null;
  }>("payments", "GET", `/v1/terminal/readers/${encodeURIComponent(readerId)}`, { account });
  return reader.action ?? null;
}

export async function cancelReaderAction(
  stripe: StripeClient,
  account: string,
  input: { tapId: string; readerId: string },
): Promise<unknown> {
  return stripe.call(
    "payments",
    "POST",
    `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/cancel_action`,
    { account, idempotencyKey: `${input.tapId}:cancel_action`, params: {} },
  );
}
