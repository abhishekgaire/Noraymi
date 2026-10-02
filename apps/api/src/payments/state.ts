import type { PaymentStatus } from "@west4/db";

/**
 * The payment state machine's moves (M4-05; Payment flows · How every card
 * payment runs). Everything only moves forward: a late or repeated event
 * that would move a payment, an attempt or an allocation backward, or
 * sideways from a final state, changes nothing. The webhook jobs, the
 * screens' check-status and the reconciler all go through these.
 */
export type AttemptState = "started" | "unknown" | "succeeded" | "failed" | "canceled";
export type AllocationState = "in_progress" | "captured" | "released";

const PAYMENT: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending: ["requires_action", "authorized", "captured", "failed", "canceled"],
  requires_action: ["authorized", "captured", "failed", "canceled"],
  authorized: ["captured", "capture_failed", "canceled"],
  captured: ["partly_refunded", "refunded"],
  partly_refunded: ["refunded"],
  capture_failed: [],
  refunded: [],
  canceled: [],
  failed: [],
};
const ATTEMPT: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  started: ["unknown", "succeeded", "failed", "canceled"],
  unknown: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: [],
};
const ALLOCATION: Readonly<Record<AllocationState, readonly AllocationState[]>> = {
  in_progress: ["captured", "released"],
  captured: [],
  released: [],
};

export const canMovePayment = (from: PaymentStatus, to: PaymentStatus): boolean =>
  PAYMENT[from].includes(to);
export const canMoveAttempt = (from: AttemptState, to: AttemptState): boolean =>
  ATTEMPT[from].includes(to);
export const canMoveAllocation = (from: AllocationState, to: AllocationState): boolean =>
  ALLOCATION[from].includes(to);
export const PAYMENT_STATUSES = Object.keys(PAYMENT) as PaymentStatus[];
export const ATTEMPT_STATES = Object.keys(ATTEMPT) as AttemptState[];
export const openAttempt = (s: AttemptState): boolean => s === "started" || s === "unknown";

/** What Stripe's PaymentIntent status means for our payment, if anything. */
export function statusOfIntent(intent: string): PaymentStatus | null {
  switch (intent) {
    case "succeeded":
      return "captured";
    case "requires_capture":
      return "authorized";
    case "requires_action":
      return "requires_action";
    case "canceled":
      return "canceled";
    default:
      // requires_payment_method (waiting for a card, or a decline), requires_confirmation, processing
      return null;
  }
}

/** Reader failures that mean "we don't know" rather than "it failed" (Payment flows step 4). */
export const UNKNOWN_READER_CODES: ReadonlySet<string> = new Set(["terminal_reader_timeout"]);
