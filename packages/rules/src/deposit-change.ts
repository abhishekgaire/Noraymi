import type { Temporal } from "@west4/shared";

/**
 * A change to a booked party, room, date or time (M5-11; Payment flows ·
 * Deposit when booking online, step 5; Money rules 11). The new deposit comes
 * from `deposit()` for the new party and date; against what the guest holds
 * with us now:
 *   - more: the deposit becomes the new amount and the difference is
 *     collected on the guest's screen, before or after the cut-off;
 *   - less, before the refund cut-off: the excess is refunded;
 *   - less, after it: the deposit already paid stays (it comes off the bill
 *     at check-in), and `staysCents` says how much more than needed that is.
 * All amounts are integer cents.
 */
export interface DepositChange {
  /** The booking's deposit after the change. */
  readonly depositCents: number;
  readonly collectCents: number;
  readonly refundCents: number;
  readonly staysCents: number;
}

export function depositChange(input: {
  /** What the guest holds with us now: captured deposit payments less their refunds. */
  readonly heldCents: number;
  readonly newDepositCents: number;
  readonly beforeCutoff: boolean;
}): DepositChange {
  const { heldCents: held, newDepositCents: next } = input;
  if (!Number.isInteger(held) || !Number.isInteger(next)) throw new Error("cents are integers");
  if (next > held)
    return { depositCents: next, collectCents: next - held, refundCents: 0, staysCents: 0 };
  if (next === held) return { depositCents: next, collectCents: 0, refundCents: 0, staysCents: 0 };
  return input.beforeCutoff
    ? { depositCents: next, collectCents: 0, refundCents: held - next, staysCents: 0 }
    : { depositCents: held, collectCents: 0, refundCents: 0, staysCents: held - next };
}

/**
 * The refund cut-off after a change (step 4): fixed when the booking was first
 * confirmed, so a change can bring it earlier but never push it later. A
 * booking without one (no deposit) gets none.
 */
export function changedCutoff(
  current: Temporal.Instant | null,
  fresh: Temporal.Instant,
): Temporal.Instant | null {
  if (!current) return null;
  return fresh.epochNanoseconds < current.epochNanoseconds ? fresh : current;
}
