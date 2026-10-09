import { cents, percentOf } from "@west4/shared";

/**
 * What happens to a booking's deposit when it's cancelled or a no-show (M5-12;
 * Payment flows · Deposit when booking online, steps 4 and 6; Money rules 11),
 * as an amount refunded, an amount kept (a `forfeit` line on a `fee` check)
 * and, for a no-show, an amount charged off-session on the saved card. All
 * amounts are integer cents and the parts always add up to what's held.
 */
export type LateCancel = "keep" | "half" | "refund";
export type NoShow = "keep" | "firstHour" | "nothing";

export function cancelOutcome(input: {
  /** What the guest holds with us: captured deposit payments less their refunds. */
  readonly heldCents: number;
  readonly beforeCutoff: boolean;
  /** The accepted policy's later-cancel outcome. */
  readonly late: LateCancel;
  /** The venue cancelling (a blocked date) always refunds in full. */
  readonly byVenue?: boolean;
}): { refundCents: number; keptCents: number } {
  const held = input.heldCents;
  if (!Number.isInteger(held) || held < 0) throw new Error("held is whole cents");
  if (input.byVenue || input.beforeCutoff || input.late === "refund")
    return { refundCents: held, keptCents: 0 };
  if (input.late === "keep") return { refundCents: 0, keptCents: held };
  // Half back, rounded half up to the cent; the other part is kept, so they add up.
  const refund = percentOf(cents(held), 50, 100);
  return { refundCents: refund, keptCents: held - refund };
}

export function noShowOutcome(input: {
  readonly heldCents: number;
  readonly noShow: NoShow;
  /** The first hour's room time for the booking's billable guests. */
  readonly firstHourCents: number;
}): { refundCents: number; keptCents: number; chargeCents: number } {
  const held = input.heldCents;
  if (!Number.isInteger(held) || held < 0) throw new Error("held is whole cents");
  if (input.noShow === "keep") return { refundCents: 0, keptCents: held, chargeCents: 0 };
  // Spec gap (M5-12): "nothing" doesn't say whether the deposit comes back; since keep is its own
  // option, the cautious default refunds it and charges nothing (flagged in the ticket).
  if (input.noShow === "nothing") return { refundCents: held, keptCents: 0, chargeCents: 0 };
  // Up to the first hour in total: the deposit counts toward it.
  const total = input.firstHourCents;
  const kept = Math.min(held, total);
  return { refundCents: held - kept, keptCents: kept, chargeCents: total - kept };
}
