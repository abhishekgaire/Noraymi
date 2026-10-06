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

/**
 * Grows a bar tab's hold (M6-07; Payment flows · Bar tab with a growing hold, step 3): `amount` is the
 * new total. The key is the attempt's, `<payment_id>:increment:<attempt_no>:<target>`, so a retried
 * call can only ever ask for the same amount. A decline is a 402 `card_declined`; the old hold stays.
 */
export async function incrementHold(
  stripe: StripeClient,
  account: string,
  input: { piId: string; targetCents: number },
  idempotencyKey: string,
): Promise<StripeIntent> {
  return stripe.call(
    "payments",
    "POST",
    `/v1/payment_intents/${encodeURIComponent(input.piId)}/increment_authorization`,
    { account, idempotencyKey, params: { amount: input.targetCents } },
  );
}

/**
 * Closes a tab on its hold (M6-08; Payment flows step 5): the total plus the tip in one call. The key is
 * the attempt's, `<payment_id>:capture:<attempt_no>:<amount>`, so a retried call can only ever capture
 * the same amount.
 */
export async function captureHold(
  stripe: StripeClient,
  account: string,
  input: { piId: string; amountCents: number },
  idempotencyKey: string,
): Promise<StripeIntent> {
  return stripe.call(
    "payments",
    "POST",
    `/v1/payment_intents/${encodeURIComponent(input.piId)}/capture`,
    {
      account,
      idempotencyKey,
      params: { amount_to_capture: input.amountCents, expand: ["latest_charge"] },
    },
  );
}

/** One question on the reader's screen (Stripe · collect inputs): a selection, a number or a phone. */
export type ReaderInput =
  | {
      readonly type: "selection";
      readonly title: string;
      readonly choices: readonly { readonly id: string; readonly text: string }[];
    }
  | { readonly type: "numeric" | "phone"; readonly title: string; readonly description?: string };

/** What the reader's collect_inputs action answered, once it's done. */
export interface InputsAnswer {
  readonly status: "in_progress" | "succeeded" | "failed";
  readonly failureCode: string | null;
  /** Our own tag on the question (metadata), so an answer is matched to the step that asked it. */
  readonly step: string | null;
  /** The choice's id, or the number or phone typed. */
  readonly value: string | null;
}

export async function collectInputs(
  stripe: StripeClient,
  account: string,
  input: { readerId: string; question: ReaderInput; step: string },
  idempotencyKey: string,
): Promise<unknown> {
  const q = input.question;
  return stripe.call(
    "payments",
    "POST",
    `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/collect_inputs`,
    {
      account,
      idempotencyKey,
      params: {
        inputs: [
          q.type === "selection"
            ? {
                type: "selection",
                required: true,
                custom_text: { title: q.title },
                selection: {
                  choices: q.choices.map((x, i) => ({
                    id: x.id,
                    text: x.text,
                    style: i < q.choices.length - 2 ? "primary" : "secondary",
                  })),
                },
              }
            : {
                type: q.type,
                required: true,
                custom_text: {
                  title: q.title,
                  ...(q.description ? { description: q.description } : {}),
                },
              },
        ],
        metadata: { step: input.step },
      },
    },
  );
}

/** Reads a reader's collect_inputs action: null when the reader is on something else. */
export function inputsAnswerOf(reader: { action?: unknown }): InputsAnswer | null {
  const action = reader.action as
    | {
        type?: string;
        status?: InputsAnswer["status"];
        failure_code?: string | null;
        collect_inputs?: {
          inputs?: {
            type?: string;
            selection?: { id?: string; value?: string } | null;
            numeric?: { value?: string } | null;
            phone?: { value?: string } | null;
          }[];
          metadata?: Record<string, string>;
        };
      }
    | null
    | undefined;
  if (!action || action.type !== "collect_inputs" || !action.collect_inputs) return null;
  const first = action.collect_inputs.inputs?.[0];
  const value =
    first?.selection?.id ??
    first?.selection?.value ??
    first?.numeric?.value ??
    first?.phone?.value ??
    null;
  return {
    status: action.status ?? "in_progress",
    failureCode: action.failure_code ?? null,
    step: action.collect_inputs.metadata?.["step"] ?? null,
    value: value === "" ? null : value,
  };
}
