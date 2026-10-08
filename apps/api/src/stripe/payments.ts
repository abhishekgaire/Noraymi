import type { StripeClient } from "./client.js";

/**
 * PaymentIntents and reader actions (M4-05; Stripe setup 4 and 5). Every call
 * runs on the venue's account with the payments key, outside any
 * transaction, with the attempt's own idempotency key.
 */
export interface StripeIntent {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  /** The card a guest paid with: an id, or the object when expanded (M5-09 keeps it for a deposit). */
  readonly payment_method?: string | { readonly id: string } | null;
  readonly amount_received?: number;
  readonly amount_capturable?: number;
  readonly amount_details?: { readonly tip?: { readonly amount?: number } };
  readonly last_payment_error?: { readonly code?: string; readonly decline_code?: string } | null;
  readonly latest_charge?:
    | string
    | {
        readonly payment_method_details?: {
          readonly card_present?: {
            readonly brand?: string;
            readonly last4?: string;
            readonly funding?: string;
            readonly generated_card?: string | null;
            /** A bar tab's hold (M6-06). */
            readonly fingerprint?: string | null;
            readonly cardholder_name?: string | null;
            readonly incremental_authorization_supported?: boolean;
            readonly overcapture_supported?: boolean;
            readonly amount_authorized?: number;
            readonly capture_before?: number;
          };
          readonly card?: {
            readonly brand?: string;
            readonly last4?: string;
            readonly funding?: string;
          };
        };
      }
    | null;
  readonly metadata?: Record<string, string>;
}

export interface ReaderAction {
  readonly type?: string;
  readonly status?: "in_progress" | "succeeded" | "failed";
  readonly failure_code?: string | null;
  readonly process_payment_intent?: { readonly payment_intent?: string };
  /** The surcharge path's steps (M4-25). */
  readonly collect_payment_method?: { readonly payment_intent?: string };
  readonly confirm_payment_intent?: { readonly payment_intent?: string };
}

/** What a PaymentIntent tells us, read from Stripe's object. */
export interface IntentObservation {
  readonly id: string;
  readonly status: string;
  /** The PaymentMethod that paid, saved for later charges when set up for off-session use (M5-09). */
  readonly paymentMethod: string | null;
  readonly amountReceived: number;
  readonly amountCapturable: number;
  readonly tipCents: number;
  /** The card surcharge Stripe added on the surcharge path (M4-25). */
  readonly surchargeCents: number;
  readonly declineCode: string | null;
  readonly errorCode: string | null;
  readonly card: {
    brand: string | null;
    last4: string | null;
    funding: string | null;
    generatedCard: string | null;
  } | null;
  /** A manual-capture hold's terms, as the charge reports them (M6-06; Payment flows step 2). */
  readonly hold: {
    readonly fingerprint: string | null;
    readonly cardholderName: string | null;
    readonly incrementalSupported: boolean | null;
    readonly overcaptureSupported: boolean | null;
    readonly amountAuthorized: number | null;
    /** ISO time. */
    readonly captureBefore: string | null;
  } | null;
}

export function observeIntent(pi: StripeIntent): IntentObservation {
  const charge = typeof pi.latest_charge === "object" && pi.latest_charge ? pi.latest_charge : null;
  const present = charge?.payment_method_details?.card_present;
  const card: {
    brand?: string;
    last4?: string;
    funding?: string;
    generated_card?: string | null;
  } | null = present ?? charge?.payment_method_details?.card ?? null;
  return {
    id: pi.id,
    status: pi.status,
    paymentMethod:
      typeof pi.payment_method === "string" ? pi.payment_method : (pi.payment_method?.id ?? null),
    amountReceived: pi.amount_received ?? 0,
    amountCapturable: pi.amount_capturable ?? 0,
    tipCents: pi.amount_details?.tip?.amount ?? 0,
    surchargeCents:
      (pi.amount_details as { surcharge?: { amount?: number } } | undefined)?.surcharge?.amount ??
      0,
    declineCode: pi.last_payment_error?.decline_code ?? null,
    errorCode: pi.last_payment_error?.code ?? null,
    card: card
      ? {
          brand: card.brand ?? null,
          last4: card.last4 ?? null,
          funding: card.funding ?? null,
          generatedCard: card.generated_card ?? null,
        }
      : null,
    hold: present
      ? {
          fingerprint: present.fingerprint ?? null,
          cardholderName: present.cardholder_name ?? null,
          incrementalSupported: present.incremental_authorization_supported ?? null,
          overcaptureSupported: present.overcapture_supported ?? null,
          amountAuthorized: present.amount_authorized ?? null,
          captureBefore: present.capture_before
            ? new Date(present.capture_before * 1000).toISOString()
            : null,
        }
      : null,
  };
}

export async function createReaderIntent(
  stripe: StripeClient,
  account: string,
  input: { amountCents: number; paymentId: string; checkId: string | null },
): Promise<StripeIntent> {
  return stripe.call("payments", "POST", "/v1/payment_intents", {
    account,
    // One PaymentIntent per payment: the reconciler can find one the API died before storing (M4-12).
    idempotencyKey: `${input.paymentId}:create`,
    params: {
      amount: input.amountCents,
      currency: "usd",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      metadata: {
        payment_id: input.paymentId,
        ...(input.checkId ? { check_id: input.checkId } : {}),
      },
    },
  });
}

export async function retrieveIntent(
  stripe: StripeClient,
  account: string,
  piId: string,
): Promise<StripeIntent> {
  return stripe.call("payments", "GET", `/v1/payment_intents/${encodeURIComponent(piId)}`, {
    account,
    params: { expand: ["latest_charge"] },
  });
}

export async function cancelIntent(
  stripe: StripeClient,
  account: string,
  piId: string,
  idempotencyKey: string,
): Promise<StripeIntent> {
  return stripe.call("payments", "POST", `/v1/payment_intents/${encodeURIComponent(piId)}/cancel`, {
    account,
    idempotencyKey,
  });
}

/**
 * Room checks carry the gratuity, so their taps skip the reader's tip screen (Stripe setup 4).
 * A bar or quick sale tips on the drinks before tax (M6-05): `tipping[amount_eligible]`.
 */
export async function processOnReader(
  stripe: StripeClient,
  account: string,
  input: {
    readerId: string;
    piId: string;
    skipTipping: boolean;
    amountEligibleCents?: number | null;
  },
  idempotencyKey: string,
): Promise<{ id: string; action?: ReaderAction | null }> {
  return stripe.call(
    "payments",
    "POST",
    `/v1/terminal/readers/${encodeURIComponent(input.readerId)}/process_payment_intent`,
    {
      account,
      idempotencyKey,
      params: {
        payment_intent: input.piId,
        ...(input.skipTipping
          ? { process_config: { skip_tipping: true } }
          : input.amountEligibleCents
            ? { process_config: { tipping: { amount_eligible: input.amountEligibleCents } } }
            : {}),
      },
    },
  );
}

export async function cancelReaderAction(
  stripe: StripeClient,
  account: string,
  readerId: string,
  idempotencyKey: string,
): Promise<void> {
  await stripe.call(
    "payments",
    "POST",
    `/v1/terminal/readers/${encodeURIComponent(readerId)}/cancel_action`,
    {
      account,
      idempotencyKey,
    },
  );
}

/**
 * An online payment's PaymentIntent (M4-15; Stripe setup 10): a direct charge on the venue's account
 * for the Payment Element (Apple Pay, Google Pay, card) on our payment page. One per payment.
 */
export async function createOnlineIntent(
  stripe: StripeClient,
  account: string,
  input: {
    amountCents: number;
    paymentId: string;
    checkId: string | null;
    saveCard?: boolean;
    customer?: string;
    /** A booking's deposit (M5-09): `payment_method_types[]=card` (Apple Pay and Google Pay come as cards). */
    cardOnly?: boolean;
    bookingId?: string | null;
  },
): Promise<StripeIntent & { client_secret: string }> {
  return stripe.call("payments", "POST", "/v1/payment_intents", {
    account,
    idempotencyKey: `${input.paymentId}:create`,
    params: {
      amount: input.amountCents,
      currency: "usd",
      ...(input.cardOnly
        ? { payment_method_types: ["card"] }
        : { automatic_payment_methods: { enabled: true } }),
      ...(input.saveCard ? { setup_future_usage: "off_session" } : {}),
      ...(input.customer ? { customer: input.customer } : {}),
      metadata: {
        payment_id: input.paymentId,
        ...(input.checkId ? { check_id: input.checkId } : {}),
        ...(input.bookingId ? { booking_id: input.bookingId } : {}),
      },
    },
  });
}

export async function retrieveIntentSecret(
  stripe: StripeClient,
  account: string,
  piId: string,
): Promise<StripeIntent & { client_secret: string }> {
  return stripe.call("payments", "GET", `/v1/payment_intents/${encodeURIComponent(piId)}`, {
    account,
  });
}

/**
 * Registers the payment page's hostname on the venue's account (M4-15), which Apple Pay and Google
 * Pay need before the Payment Element offers them. Registering a known domain again is harmless.
 */
export async function registerPayDomain(
  stripe: StripeClient,
  account: string,
  domain: string,
): Promise<{ id: string; domain_name: string; enabled: boolean }> {
  return stripe.call("payments", "POST", "/v1/payment_method_domains", {
    account,
    idempotencyKey: `pmd:${account}:${domain}`,
    params: { domain_name: domain, enabled: true },
  });
}

/** The Customer and saved card behind a deposit's PaymentIntent (M4-17), read from Stripe itself. */
export async function savedCardOf(
  stripe: StripeClient,
  account: string,
  depositPiId: string,
): Promise<{ customer: string; paymentMethod: string } | null> {
  const pi = await stripe.call<{ customer: string | null; payment_method: string | null }>(
    "payments",
    "GET",
    `/v1/payment_intents/${encodeURIComponent(depositPiId)}`,
    { account },
  );
  return pi.customer && pi.payment_method
    ? { customer: pi.customer, paymentMethod: pi.payment_method }
    : null;
}

/**
 * A charge on the saved card with the guest away from the payment (M4-17; Payment flows · Card on
 * file): `off_session=true` and `confirm=true`, keyed `<payment_id>:off_session:<n>`. A decline, or a
 * bank asking for authentication, comes back as a StripeError with the PaymentIntent it left.
 */
export async function createOffSessionIntent(
  stripe: StripeClient,
  account: string,
  input: {
    amountCents: number;
    paymentId: string;
    checkId: string | null;
    customer: string;
    paymentMethod: string;
  },
  idempotencyKey: string,
): Promise<StripeIntent> {
  return stripe.call("payments", "POST", "/v1/payment_intents", {
    account,
    idempotencyKey,
    params: {
      amount: input.amountCents,
      currency: "usd",
      customer: input.customer,
      payment_method: input.paymentMethod,
      off_session: true,
      confirm: true,
      expand: ["latest_charge"],
      metadata: {
        payment_id: input.paymentId,
        ...(input.checkId ? { check_id: input.checkId } : {}),
      },
    },
  });
}

export interface StripeRefund {
  readonly id: string;
  readonly status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  readonly amount: number;
  readonly failure_reason?: string | null;
  readonly metadata?: Record<string, string>;
}

/** A refund on the venue's account (M4-21; Payment flows · Refunds), keyed `<payment_id>:refund:<n>`. */
export async function createRefund(
  stripe: StripeClient,
  account: string,
  input: { piId: string; amountCents: number; refundId: string },
  idempotencyKey: string,
): Promise<StripeRefund> {
  return stripe.call("refunds", "POST", "/v1/refunds", {
    account,
    idempotencyKey,
    params: {
      payment_intent: input.piId,
      amount: input.amountCents,
      metadata: { refund_id: input.refundId },
    },
  });
}

export async function retrieveRefund(
  stripe: StripeClient,
  account: string,
  stripeRefundId: string,
): Promise<StripeRefund> {
  return stripe.call("refunds", "GET", `/v1/refunds/${encodeURIComponent(stripeRefundId)}`, {
    account,
  });
}
