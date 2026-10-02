import {
  allocatedChecks,
  emitEvent,
  latestAttempt,
  paymentById,
  recordAuthorization,
  recordCapture,
  setAllocationState,
  setAttemptState,
  setPaymentCard,
  setPaymentStatus,
  type AttemptRow,
  type PaymentRow,
  type PaymentSource,
  type Queryable,
} from "@west4/db";
import type { Temporal } from "@west4/shared";
import { settleCheck } from "../rooms/present.js";
import { settleShares } from "./splits.js";
import type { IntentObservation, ReaderAction } from "../stripe/payments.js";
import {
  UNKNOWN_READER_CODES,
  canMoveAttempt,
  canMovePayment,
  openAttempt,
  statusOfIntent,
} from "./state.js";

/**
 * The one function that records what Stripe says about a payment (M4-05):
 * the webhook jobs, the screens' check-status, the run itself and the
 * reconciler all call it, inside one short transaction with the payment's
 * row locked. It only moves things forward, so a late or repeated event
 * changes nothing.
 */
export interface Observation {
  /** The PaymentIntent as Stripe has it now. */
  readonly intent?: IntentObservation | null;
  /** The reader's current action, when the payment is on a reader. */
  readonly reader?: ReaderAction | null;
  /** What the run itself learned about its attempt (a timeout, an offline reader). */
  readonly attempt?: {
    readonly state: "unknown" | "failed" | "canceled";
    readonly code?: string | null;
  };
}

export interface Applied {
  readonly changed: boolean;
  readonly payment: PaymentRow;
  readonly attempt: AttemptRow | null;
}

export async function applyObservation(
  c: Queryable,
  venueId: string,
  paymentId: string,
  obs: Observation,
  source: PaymentSource,
  stripeEventId: string | null = null,
  /** The venue's clock now: a check paid in full records when (M4-08). */
  now?: Temporal.Instant,
): Promise<Applied | null> {
  const before = await paymentById(c, venueId, paymentId, true);
  if (!before) return null;
  let attempt = await latestAttempt(c, venueId, paymentId);
  let changed = false;
  const moveAttempt = async (to: AttemptRow["state"], code: string | null = null) => {
    if (!attempt || !canMoveAttempt(attempt.state, to)) return;
    await setAttemptState(c, venueId, paymentId, attempt.attempt_no, to, code);
    attempt = { ...attempt, state: to, decline_code: code ?? attempt.decline_code };
    changed = true;
  };
  const movePayment = async (to: PaymentRow["status"]) => {
    if (!canMovePayment(before.status, to)) return false;
    await setPaymentStatus(c, venueId, paymentId, to, source, stripeEventId);
    changed = true;
    return true;
  };

  const intent = obs.intent;
  if (intent) {
    const target = statusOfIntent(intent.status);
    if (target === "captured" && (await movePayment("captured"))) {
      // The tip is what was entered before the tap ("Additional tip (optional)") plus any the reader took.
      const tip = before.tip_cents + intent.tipCents;
      await recordCapture(c, paymentId, {
        amountCents: intent.amountReceived - tip,
        tipCents: tip,
        surchargeCents: 0,
      });
      if (intent.card) await setPaymentCard(c, venueId, paymentId, intent.card);
      await setAllocationState(c, venueId, paymentId, "in_progress", "captured");
      await moveAttempt("succeeded");
    } else if (target === "authorized" && (await movePayment("authorized"))) {
      await recordAuthorization(c, paymentId, intent.amountCapturable);
      if (intent.card) await setPaymentCard(c, venueId, paymentId, intent.card);
      await moveAttempt("succeeded");
    } else if (target === "requires_action") {
      await movePayment("requires_action");
    } else if (target === "canceled" && (await movePayment("canceled"))) {
      await setAllocationState(c, venueId, paymentId, "in_progress", "released");
      await moveAttempt("canceled");
    } else if (
      intent.status === "requires_payment_method" &&
      (intent.declineCode || intent.errorCode) &&
      attempt &&
      openAttempt(attempt.state)
    ) {
      // A decline: the attempt fails with its code, and the PaymentIntent waits for another card.
      await moveAttempt("failed", intent.declineCode ?? intent.errorCode);
    }
  }

  const action = obs.reader;
  if (action?.status === "failed" && attempt && openAttempt(attempt.state)) {
    const code = action.failure_code ?? null;
    if (code && UNKNOWN_READER_CODES.has(code)) await moveAttempt("unknown", code);
    else if (code === "card_declined") await moveAttempt("failed", intent?.declineCode ?? code);
    else await moveAttempt("canceled", code);
  }

  if (obs.attempt) await moveAttempt(obs.attempt.state, obs.attempt.code ?? null);

  const payment = (await paymentById(c, venueId, paymentId))!;
  // A split's shares follow their payment (M4-14): paid, or open again if it was canceled.
  if (changed && payment.status !== before.status)
    await settleShares(c, venueId, paymentId, payment.status);
  // Money landed: each check it paid is paid in full or partly paid, and a paid room may go to cleaning.
  if (changed && payment.status === "captured" && before.status !== "captured" && now)
    for (const check of await allocatedChecks(c, venueId, paymentId))
      await settleCheck(c, venueId, check, now);
  if (changed) {
    await emitEvent(c, { venueId, type: "payment.updated", entityId: paymentId });
    for (const check of await allocatedChecks(c, venueId, paymentId))
      await emitEvent(c, { venueId, type: "check.updated", entityId: check });
  }
  return { changed, payment, attempt };
}

/** What staff see for a payment (Payment flows · What staff see during a card payment). */
export type ScreenState =
  "waiting" | "paid" | "authorized" | "declined" | "unknown" | "canceled" | "failed";

export function screenState(p: PaymentRow, a: AttemptRow | null): ScreenState {
  if (p.status === "captured" || p.status === "partly_refunded" || p.status === "refunded")
    return "paid";
  if (p.status === "authorized") return "authorized";
  if (p.status === "canceled") return "canceled";
  if (p.status === "failed" || p.status === "capture_failed") return "failed";
  if (a?.state === "unknown") return "unknown";
  if (a?.state === "failed") return "declined";
  if (a?.state === "canceled") return "canceled";
  return "waiting";
}
