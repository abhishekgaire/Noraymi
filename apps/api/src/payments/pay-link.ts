import {
  allocate,
  insertPayment,
  latestAttempt,
  payLinkByHash,
  paymentById,
  payTokenHash,
  setPayLinkPayment,
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
import { checkNow, type PaymentDeps } from "./run.js";
import { screenState } from "./machine.js";

/**
 * Pay links on our payment page (M4-15; Stripe setup 10; Security 1 and 9).
 * The first visit writes the payment (card_online, pending), its attempt and
 * an in-progress allocation, then makes its one PaymentIntent (key
 * <payment_id>:create) on the venue's account; every retry answers the same
 * PaymentIntent's client secret. A wrong or expired token is not found.
 */
export interface PayPage {
  readonly status: "open" | "paid" | "checking" | "declined";
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

export async function openPayLink(
  deps: PaymentDeps,
  token: string,
  /** A page load starts a new attempt after a decline; confirm's answer only reports what happened. */
  options: { retry?: boolean } = {},
): Promise<PayPage> {
  const retry = options.retry ?? true;
  const { hash, venueId, inVenue } = await resolve(deps, token);
  const now = deps.clock.now();
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
    const account = await stripeAccountOf(c, venueId);
    if (!account) throw new ApiError("invalid_request", "this venue can't take card payments yet");
    let paymentId = link.payment_id;
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
    let attempt = await latestAttempt(c, venueId, paymentId);
    // After a declined card the guest tries again on the same PaymentIntent: a new attempt.
    if (
      retry &&
      payment!.status === "pending" &&
      attempt &&
      (attempt.state === "failed" || attempt.state === "canceled")
    ) {
      await startAttempt(c, venueId, {
        paymentId,
        checkId: link.check_id,
        bookingId: link.booking_id,
        portionKey: `link:${link.id}`,
        action: "confirm",
        amountCents: link.amount_cents,
        startedAt: now.toString(),
      });
      attempt = await latestAttempt(c, venueId, paymentId);
    }
    return { link, venue, account, payment: payment!, attempt };
  });
  const settings = deps.stripe.settings;
  const base = {
    amount_cents: written.link.amount_cents,
    venue_name: written.venue.name,
    publishable_key: settings.publishableKey,
    stripe_account: written.account,
    mode: settings.mode,
  };
  const status = statusOf(written.payment, written.attempt);
  if (status === "paid") return { ...base, status, client_secret: null };
  // Its one PaymentIntent: made once, then the same one on every retry.
  try {
    const pi = written.payment.stripe_pi_id
      ? await retrieveIntentSecret(deps.stripe, written.account, written.payment.stripe_pi_id)
      : await createOnlineIntent(deps.stripe, written.account, {
          amountCents: written.link.amount_cents,
          paymentId: written.payment.id,
          checkId: written.link.check_id,
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
  deps: PaymentDeps,
  token: string,
  testCard?: string,
): Promise<PayPage> {
  const { hash, venueId, inVenue } = await resolve(deps, token);
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
