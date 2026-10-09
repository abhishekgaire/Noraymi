import {
  checkIsTraining,
  allocate,
  insertPayment,
  latestAttempt,
  payLinkByHash,
  paymentById,
  payTokenHash,
  setPayLinkPayment,
  setPayLinkSetupIntent,
  setPaymentIntent,
  startAttempt,
  stripeAccountOf,
  venueForPayToken,
  withVenue,
  type Queryable,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { StripeError, StripeUnknownResult } from "../stripe/client.js";
import { createOnlineIntent, retrieveIntentSecret } from "../stripe/payments.js";
import { createTabCustomer } from "../stripe/tabs.js";
import { acceptTerms, depositBooking, moreTime } from "../bookings/online.js";
import { checkNow, type PaymentDeps } from "./run.js";
import { cardSaved, createCardHoldSetup, retrieveSetup } from "./card-hold.js";
import { screenState } from "./machine.js";

/**
 * Pay links on our payment page (M4-15; Stripe setup 10; Security 1 and 9).
 * The first visit writes the payment (card_online, pending), its attempt and
 * an in-progress allocation, then makes its one PaymentIntent (key
 * <payment_id>:create) on the venue's account; every retry answers the same
 * PaymentIntent's client secret. A wrong or expired token is not found.
 */
export interface PayPage {
  /** `lapsed`: a deposit's hold ran out before it was paid (M5-09), and the guest picks a time again. */
  readonly status: "open" | "paid" | "checking" | "declined" | "lapsed" | "refunded";
  /** M5-13: `card_hold` saves the card with a SetupIntent and charges nothing. */
  readonly kind: "balance" | "deposit" | "card_hold";
  /** A booking's deposit (M5-09): the hold's countdown, the policy above the pay button, and where to pick again. */
  readonly deposit: {
    readonly seconds_left: number | null;
    readonly more_time_left: number;
    readonly cutoff_words: string | null;
    readonly policy: { id: string; version: number; text: string; hash: string } | null;
    readonly pick_again_url: string | null;
    /** M5-10: the booking once paid (confirmed), and a late payment refunded in full because the room went. */
    readonly booking_status: string;
    readonly late_refund_cents: number | null;
  } | null;
  readonly amount_cents: number;
  readonly venue_name: string;
  readonly client_secret: string | null;
  readonly publishable_key: string;
  readonly stripe_account: string;
  readonly mode: "stripe" | "fake" | "off";
}

const notFound = () => new ApiError("not_found", "this link isn't valid");

async function resolve(deps: PaymentDeps, token: string) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw notFound();
  const hash = payTokenHash(token);
  const venueId = await venueForPayToken(deps.pool, hash);
  if (!venueId) throw notFound();
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: "pay-link" }, work);
  return { hash, venueId, inVenue };
}

function statusOf(
  payment: { status: string } | null,
  attempt: { state: string } | null,
): PayPage["status"] {
  if (!payment) return "open";
  if (payment.status === "captured") return "paid";
  const s = screenState(payment as never, attempt as never);
  if (s === "unknown") return "checking";
  if (s === "declined") return "declined";
  return "open";
}

export type PayLinkDeps = PaymentDeps & { readonly guestAppUrl?: string | null };

export async function openPayLink(
  deps: PayLinkDeps,
  token: string,
  /** A page load starts a new attempt after a decline; confirm's answer only reports what happened. */
  options: { retry?: boolean } = {},
): Promise<PayPage> {
  const retry = options.retry ?? true;
  const { hash, venueId, inVenue } = await resolve(deps, token);
  const now = deps.clock.now();
  if ((await inVenue((c) => payLinkByHash(c, venueId, hash)))?.purpose === "card_hold")
    return openCardHold(deps, venueId, hash, inVenue);
  const written = await inVenue(async (c) => {
    const link = await payLinkByHash(c, venueId, hash, true);
    if (!link || Temporal.Instant.compare(Temporal.Instant.from(link.expires_at), now) <= 0)
      throw notFound();
    const venue = (
      await c.query<{ name: string; time_zone: string; day_cutover: string }>(
        "select name, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
        [venueId],
      )
    ).rows[0]!;
    // A practice check pays only on a simulated reader (M7-04): its link never opens a live payment.
    if (link.check_id && (await checkIsTraining(c, venueId, link.check_id))) throw notFound();
    const account = await stripeAccountOf(c, venueId);
    if (!account) throw new ApiError("invalid_request", "this venue can't take card payments yet");
    const booking =
      link.purpose === "deposit" && link.booking_id
        ? await depositBooking(c, venueId, link.booking_id, now)
        : null;
    let paymentId = link.payment_id;
    // A deposit's payment is made when the guest leaves Terms (M5-09); a hold that ran out takes none.
    if (!paymentId && booking) throw notFound();
    if (!paymentId) {
      paymentId = await insertPayment(c, venueId, {
        method: "card_online",
        status: "pending",
        businessDate: businessDate(now, venue.time_zone, venue.day_cutover).businessDate.toString(),
        bookingId: link.booking_id,
      });
      if (link.check_id) {
        await allocate(c, venueId, {
          paymentId,
          checkId: link.check_id,
          amountCents: link.amount_cents,
          state: "in_progress",
        });
      }
      await startAttempt(c, venueId, {
        paymentId,
        checkId: link.check_id,
        bookingId: link.booking_id,
        portionKey: `link:${link.id}`,
        action: "confirm",
        amountCents: link.amount_cents,
        startedAt: now.toString(),
      });
      await setPayLinkPayment(c, venueId, link.id, paymentId);
    }
    const payment = await paymentById(c, venueId, paymentId);
    // A newer link from the same bill replaced this one (M4-16): its payment was cancelled.
    if (payment!.status === "canceled") throw notFound();
    let attempt = await latestAttempt(c, venueId, paymentId);
    // After a declined card the guest tries again on the same PaymentIntent: a new attempt.
    if (
      retry &&
      !booking?.lapsed &&
      payment!.status === "pending" &&
      attempt &&
      (attempt.state === "failed" || attempt.state === "canceled")
    ) {
      await startAttempt(c, venueId, {
        paymentId,
        checkId: link.check_id,
        bookingId: link.booking_id,
        portionKey: booking ? "deposit" : `link:${link.id}`,
        action: "confirm",
        amountCents: link.amount_cents,
        startedAt: now.toString(),
      });
      attempt = await latestAttempt(c, venueId, paymentId);
    }
    return { link, venue, account, payment: payment!, attempt, booking };
  });
  const settings = deps.stripe.settings;
  const base = {
    amount_cents: written.link.amount_cents,
    venue_name: written.venue.name,
    publishable_key: settings.publishableKey,
    stripe_account: written.account,
    mode: settings.mode,
    kind: written.booking ? ("deposit" as const) : ("balance" as const),
    deposit: written.booking
      ? {
          seconds_left: written.booking.seconds_left,
          more_time_left: written.booking.more_time_left,
          cutoff_words: written.booking.cutoff_words,
          policy: written.booking.policy,
          pick_again_url: deps.guestAppUrl
            ? `${deps.guestAppUrl}/v/${written.booking.slug}/book`
            : null,
          booking_status: written.booking.status,
          late_refund_cents: written.booking.late_refund?.amount_cents ?? null,
        }
      : null,
  };
  // Paid after the hold lapsed, with the room gone: refunded in full (M5-10), never offered again.
  if (written.booking?.late_refund) return { ...base, status: "refunded", client_secret: null };
  const status = statusOf(written.payment, written.attempt);
  if (status === "paid") return { ...base, status, client_secret: null };
  // The hold ran out before the money went through: back to pick a time (no PaymentIntent is made).
  if (written.booking?.lapsed && status !== "checking")
    return { ...base, status: "lapsed", client_secret: null };
  // Its one PaymentIntent: made once, then the same one on every retry.
  try {
    const pi = written.payment.stripe_pi_id
      ? await retrieveIntentSecret(deps.stripe, written.account, written.payment.stripe_pi_id)
      : await createOnlineIntent(deps.stripe, written.account, {
          amountCents: written.link.amount_cents,
          paymentId: written.payment.id,
          checkId: written.link.check_id,
          // A deposit saves the card, under a Customer on the venue's account (Payment flows step 2).
          ...(written.booking
            ? {
                saveCard: true,
                cardOnly: true,
                bookingId: written.booking.id,
                customer: (
                  await createTabCustomer(deps.stripe, written.account, written.payment.id)
                ).id,
              }
            : {}),
        });
    if (!written.payment.stripe_pi_id)
      await inVenue((c) => setPaymentIntent(c, written.payment.id, pi.id));
    return { ...base, status, client_secret: pi.client_secret };
  } catch (e) {
    if (e instanceof StripeError || e instanceof StripeUnknownResult)
      return { ...base, status: "checking", client_secret: null };
    throw e;
  }
}

/**
 * After the Payment Element confirms in the browser: read Stripe now, through the state machine. On the
 * fake Stripe (local runs and tests), `testCard` confirms the PaymentIntent the way Stripe.js would.
 */
export async function confirmPayLink(
  deps: PayLinkDeps,
  token: string,
  testCard?: string,
): Promise<PayPage> {
  const { hash, venueId, inVenue } = await resolve(deps, token);
  const held = await inVenue((c) => payLinkByHash(c, venueId, hash));
  if (held?.purpose === "card_hold") {
    const account = await inVenue((c) => stripeAccountOf(c, venueId));
    // On the fake Stripe, `testCard` confirms the SetupIntent the way Stripe.js would.
    if (testCard && deps.stripe.settings.mode === "fake" && held.setup_intent_id && account)
      await deps.stripe
        .call("payments", "POST", `/v1/setup_intents/${held.setup_intent_id}/confirm`, {
          account,
          idempotencyKey: `${held.id}:card_hold:confirm:${Date.now()}`,
          params: { payment_method: testCard },
        })
        .catch(() => undefined);
    return openCardHold(deps, venueId, hash, inVenue);
  }
  const found = await inVenue(async (c) => {
    const link = await payLinkByHash(c, venueId, hash);
    if (!link?.payment_id) throw notFound();
    return {
      link,
      payment: (await paymentById(c, venueId, link.payment_id))!,
      account: await stripeAccountOf(c, venueId),
    };
  });
  if (
    testCard &&
    deps.stripe.settings.mode === "fake" &&
    found.payment.stripe_pi_id &&
    found.account
  )
    await deps.stripe
      .call("payments", "POST", `/v1/payment_intents/${found.payment.stripe_pi_id}/confirm`, {
        account: found.account,
        idempotencyKey: `${found.payment.id}:confirm:${Date.now()}`,
        params: { payment_method: testCard },
      })
      .catch(() => undefined);
  await checkNow(deps, venueId, found.payment.id, "api");
  return openPayLink(deps, token, { retry: false });
}

/**
 * The guest presses Pay (M5-09; Payment flows step 2), before the Payment
 * Element confirms: a deposit records the policy version they read, with the
 * time, the IP address and the browser (M5-08's acceptTerms), and only while
 * the hold stands. After a declined card, a new attempt starts on the same
 * PaymentIntent.
 */
export async function startPayLink(
  deps: PayLinkDeps,
  token: string,
  input: { policyVersionId: string | null; ip: string; userAgent: string },
): Promise<PayPage> {
  const { hash, venueId, inVenue } = await resolve(deps, token);
  const now = deps.clock.now();
  await inVenue(async (c) => {
    const link = await payLinkByHash(c, venueId, hash, true);
    // cardHold (M5-13): the guest's acceptance is stored as a deposit's is, before the card is saved.
    if (link?.purpose === "card_hold" && link.booking_id) {
      const booking = await depositBooking(c, venueId, link.booking_id, now);
      if (!booking || booking.lapsed || booking.status !== "pending")
        throw new ApiError("invalid_request", "this hold has run out: pick a time again", {
          details: { reason: "hold_over" },
        });
      if (!input.policyVersionId)
        throw new ApiError("invalid_request", "send the policy version you read", {
          details: { reason: "policy_changed" },
        });
      await acceptTerms(c, venueId, link.booking_id, {
        policyVersionId: input.policyVersionId,
        ip: input.ip,
        userAgent: input.userAgent,
        at: now,
      });
      return;
    }
    if (!link?.payment_id) throw notFound();
    const payment = (await paymentById(c, venueId, link.payment_id))!;
    const booking =
      link.purpose === "deposit" && link.booking_id
        ? await depositBooking(c, venueId, link.booking_id, now)
        : null;
    // A difference after a change (M5-11) pays under the policy the booking already accepted.
    if (booking?.status === "confirmed" && link.booking_id) {
      // nothing to record: the terms were accepted when the booking was paid for
    } else if (link.purpose === "deposit" && link.booking_id) {
      if (!booking || booking.lapsed || booking.status !== "pending")
        throw new ApiError("invalid_request", "this hold has run out: pick a time again", {
          details: { reason: "hold_over" },
        });
      if (!input.policyVersionId)
        throw new ApiError("invalid_request", "send the policy version you read", {
          details: { reason: "policy_changed" },
        });
      await acceptTerms(c, venueId, link.booking_id, {
        policyVersionId: input.policyVersionId,
        ip: input.ip,
        userAgent: input.userAgent,
        at: now,
      });
    }
    const attempt = await latestAttempt(c, venueId, link.payment_id);
    if (
      payment.status === "pending" &&
      attempt &&
      (attempt.state === "failed" || attempt.state === "canceled")
    )
      await startAttempt(c, venueId, {
        paymentId: link.payment_id,
        checkId: link.check_id,
        bookingId: link.booking_id,
        portionKey: link.purpose === "deposit" ? "deposit" : `link:${link.id}`,
        action: "confirm",
        amountCents: link.amount_cents,
        startedAt: now.toString(),
      });
  });
  return openPayLink(deps, token, { retry: false });
}

/** "More time" on the payment page (M5-07's 10 minutes, ten times), for a deposit's hold. */
export async function payLinkMoreTime(deps: PayLinkDeps, token: string): Promise<PayPage> {
  const { hash, venueId, inVenue } = await resolve(deps, token);
  await inVenue(async (c) => {
    const link = await payLinkByHash(c, venueId, hash);
    if (!link?.booking_id || (link.purpose !== "deposit" && link.purpose !== "card_hold"))
      throw notFound();
    await moreTime(c, venueId, link.booking_id, deps.clock.now());
  });
  return openPayLink(deps, token, { retry: false });
}

/**
 * cardHold's payment page (M5-13): the booking's hold and policy as a deposit's page shows them, and a
 * SetupIntent (made once per link, kept on it) whose client secret the Payment Element confirms. The
 * server reads the SetupIntent itself; succeeded, the card is saved on the booking and it confirms.
 */
async function openCardHold(
  deps: PayLinkDeps,
  venueId: string,
  hash: string,
  inVenue: <T>(work: (c: Queryable) => Promise<T>) => Promise<T>,
): Promise<PayPage> {
  const now = deps.clock.now();
  const w = await inVenue(async (c) => {
    const link = await payLinkByHash(c, venueId, hash);
    if (
      !link?.booking_id ||
      Temporal.Instant.compare(Temporal.Instant.from(link.expires_at), now) <= 0
    )
      throw notFound();
    const venue = (
      await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
    ).rows[0]!;
    const account = await stripeAccountOf(c, venueId);
    if (!account) throw new ApiError("invalid_request", "this venue can't take card payments yet");
    const booking = (await depositBooking(c, venueId, link.booking_id, now))!;
    return { link, venue, account, booking };
  });
  const settings = deps.stripe.settings;
  const view = (booking: typeof w.booking, status: PayPage["status"], secret: string | null) => ({
    status,
    kind: "card_hold" as const,
    amount_cents: 0,
    venue_name: w.venue.name,
    client_secret: secret,
    publishable_key: settings.publishableKey,
    stripe_account: w.account,
    mode: settings.mode,
    deposit: {
      seconds_left: booking.seconds_left,
      more_time_left: booking.more_time_left,
      cutoff_words: booking.cutoff_words,
      policy: booking.policy,
      pick_again_url: deps.guestAppUrl ? `${deps.guestAppUrl}/v/${booking.slug}/book` : null,
      booking_status: booking.status,
      late_refund_cents: null,
    },
  });
  if (w.booking.status === "confirmed") return view(w.booking, "paid", null);
  try {
    const link = { id: w.link.id, booking_id: w.link.booking_id! };
    const setup = w.link.setup_intent_id
      ? await retrieveSetup(deps.stripe, w.account, w.link.setup_intent_id)
      : await createCardHoldSetup(deps.stripe, w.account, link);
    if (!w.link.setup_intent_id)
      await inVenue((c) => setPayLinkSetupIntent(c, venueId, w.link.id, setup.id));
    if (setup.status === "succeeded") {
      const done = await inVenue((c) =>
        cardSaved(c, venueId, { ...w.link, setup_intent_id: setup.id }, setup, now),
      );
      const booking = (await inVenue((c) => depositBooking(c, venueId, link.booking_id, now)))!;
      return view(booking, done === "confirmed" ? "paid" : "lapsed", null);
    }
    if (w.booking.lapsed) return view(w.booking, "lapsed", null);
    return view(
      w.booking,
      setup.last_setup_error ? "declined" : "open",
      setup.client_secret ?? null,
    );
  } catch (e) {
    if (e instanceof StripeError || e instanceof StripeUnknownResult)
      return view(w.booking, "checking", null);
    throw e;
  }
}
