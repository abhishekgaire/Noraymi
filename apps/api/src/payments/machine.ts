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
import { Temporal, cardOutcome } from "@west4/shared";
import { telemetry } from "../telemetry/index.js";
import { settleCheck } from "../rooms/present.js";
import { afterTabPaymentEnded, takeOverHold } from "../tabs/pay.js";
import { settleShares } from "./splits.js";
import type { IntentObservation, ReaderAction } from "../stripe/payments.js";
import {
  UNKNOWN_READER_CODES,
  canMoveAttempt,
  canMovePayment,
  openAttempt,
  statusOfIntent,
} from "./state.js";
import { roomOfCheck } from "../rooms/guest-bill.js";
import { recordSurcharge } from "./surcharge.js";
import { settleTabOpening } from "../tabs/open.js";
import { settleIncrement } from "../tabs/hold.js";
import { closingById, settleClose } from "../tabs/close.js";
import { settleWalkout, walkoutOfRestPayment } from "../tabs/walkout.js";

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
    const from = attempt.state;
    await setAttemptState(c, venueId, paymentId, attempt.attempt_no, to, code);
    // The 99.5% target (M8-16): each attempt counted once, a declined card never against us.
    const outcome = from === "unknown" ? null : cardOutcome(to, code);
    if (outcome) telemetry().count("payments.card.attempts", 1, { venue: venueId, outcome });
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
      const surcharge = intent.surchargeCents;
      await recordCapture(c, paymentId, {
        amountCents: intent.amountReceived - tip - surcharge,
        tipCents: tip,
        surchargeCents: surcharge,
      });
      if (intent.card) await setPaymentCard(c, venueId, paymentId, intent.card);
      // What the check's allocation held, before it's captured: the card paid beyond it only the fee and its tax.
      const held = (
        await c.query<{ s: string }>(
          "select coalesce(sum(amount_cents), 0) as s from payment_allocations where venue_id = $1 and payment_id = $2 and state = 'in_progress'",
          [venueId, paymentId],
        )
      ).rows[0]!.s;
      await setAllocationState(c, venueId, paymentId, "in_progress", "captured");
      // The card fee at the reader (M4-25): its line, the tax on it, and their allocation.
      if (surcharge > 0)
        await recordSurcharge(c, venueId, paymentId, {
          surchargeCents: surcharge,
          paidBeyondCents: intent.amountReceived - tip - Number(held),
          at: (now ?? Temporal.Now.instant()).toString(),
        });
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

  // A bar tab's raise (M6-07): the hold grows once Stripe holds the target, or the tab shows the decline.
  if (
    attempt?.action === "increment" &&
    (await settleIncrement(c, venueId, paymentId, intent ?? null, now ?? Temporal.Now.instant()))
  )
    changed = true;

  // Closing a bar tab (M6-08): a raise that reached the total writes the capture; a capture that went
  // through closes the tab, and one that failed leaves it for a manager.
  if (attempt?.action === "increment" || attempt?.action === "capture") {
    const latest = await latestAttempt(c, venueId, paymentId);
    if (
      latest &&
      latest.attempt_no === attempt.attempt_no &&
      (await settleClose(
        c,
        venueId,
        (await paymentById(c, venueId, paymentId))!,
        latest,
        now ?? Temporal.Now.instant(),
      ))
    )
      changed = true;
  }

  // A walkout's rest on the saved card (M6-16): the tab is walkout_captured, or capture_failed for a manager.
  if (attempt?.action === "off_session") {
    const walkout = await walkoutOfRestPayment(c, venueId, paymentId);
    const latest = walkout ? await latestAttempt(c, venueId, paymentId) : null;
    const closing = walkout ? await closingById(c, venueId, walkout) : null;
    if (
      closing &&
      latest &&
      latest.attempt_no === attempt.attempt_no &&
      (await settleWalkout(
        c,
        venueId,
        closing,
        (await paymentById(c, venueId, paymentId))!,
        latest,
        now ?? Temporal.Now.instant(),
      ))
    )
      changed = true;
  }

  const payment = (await paymentById(c, venueId, paymentId))!;
  // A bar tab's opening hold (M6-06): the tab opens once the hold is placed, or nothing does.
  if (changed && payment.status !== before.status)
    await settleTabOpening(c, venueId, payment, intent, now ?? Temporal.Now.instant());
  // A split's shares follow their payment (M4-14): paid, or open again if it was canceled.
  if (changed && payment.status !== before.status)
    await settleShares(c, venueId, paymentId, payment.status);
  // Another card on a bar tab (M6-11): once it has succeeded, it takes over the hold's allocation and the
  // tab closes; the hold's cancel is a job run outside this transaction. One that ended without money
  // leaves the hold standing and the tab taking drinks again.
  if (changed && payment.status === "captured" && before.status !== "captured" && now)
    for (const check of await allocatedChecks(c, venueId, paymentId))
      await takeOverHold(c, venueId, check, now);
  if (
    changed &&
    payment.status !== before.status &&
    (payment.status === "canceled" || payment.status === "failed")
  )
    for (const check of await allocatedChecks(c, venueId, paymentId))
      await afterTabPaymentEnded(c, venueId, check);
  // Money landed: each check it paid is paid in full or partly paid, and a paid room may go to cleaning.
  if (changed && payment.status === "captured" && before.status !== "captured" && now)
    for (const check of await allocatedChecks(c, venueId, paymentId))
      await settleCheck(c, venueId, check, now);
  if (changed) {
    const checks = await allocatedChecks(c, venueId, paymentId);
    // A room's payments also reach its phones, so "Your bill" shows each one as it lands (M4-16).
    const roomId = checks[0] ? await roomOfCheck(c, venueId, checks[0]) : undefined;
    await emitEvent(c, { venueId, type: "payment.updated", entityId: paymentId, roomId });
    for (const check of checks)
      await emitEvent(c, {
        venueId,
        type: "check.updated",
        entityId: check,
        roomId: await roomOfCheck(c, venueId, check),
      });
  }
  return { changed, payment, attempt };
}

/** What staff see for a payment (Payment flows · What staff see during a card payment). */
export type ScreenState =
  | "waiting"
  | "waiting_guest"
  | "paid"
  | "authorized"
  | "declined"
  | "unknown"
  | "canceled"
  | "failed";

export function screenState(p: PaymentRow, a: AttemptRow | null): ScreenState {
  if (p.status === "captured" || p.status === "partly_refunded" || p.status === "refunded")
    return "paid";
  if (p.status === "authorized") return "authorized";
  // Card on file (M4-17): waiting for the guest (or a manager) until a charge is tried; a decline stays
  // "Declined · try another card or cash" after the payment is cancelled to free the amount.
  if (p.method === "card_on_file" && a?.state === "failed") return "declined";
  if (p.method === "card_on_file" && !a && p.status === "pending") return "waiting_guest";
  if (p.status === "canceled") return "canceled";
  if (p.status === "failed" || p.status === "capture_failed") return "failed";
  if (a?.state === "unknown") return "unknown";
  if (a?.state === "failed") return "declined";
  if (a?.state === "canceled") return "canceled";
  return "waiting";
}
