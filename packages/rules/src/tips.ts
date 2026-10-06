import { Temporal, cents, type Cents, type PaySettings } from "@west4/shared";
import { percent } from "./check-totals.js";

/**
 * The tip choices the reader shows (M6-05; Stripe setup 4; Settings ·
 * pay.tipScreen): on `process_config[tipping][amount_eligible]`, the drinks
 * before tax. Below the smart threshold ($10 at West 4) the fixed amounts
 * ($1, $2, $3); from it, the percentages (18, 20, 22), each rounded half up
 * to the cent.
 */
export function tipChoices(
  drinksBeforeTaxCents: number,
  tipScreen: Pick<PaySettings["tipScreen"], "pcts" | "fixedCents" | "smartThresholdCents">,
): { kind: "fixed" | "percent"; choicesCents: Cents[] } {
  if (drinksBeforeTaxCents < tipScreen.smartThresholdCents)
    return { kind: "fixed", choicesCents: tipScreen.fixedCents.map((c) => cents(c)) };
  return {
    kind: "percent",
    choicesCents: tipScreen.pcts.map((p) => percent(drinksBeforeTaxCents, p)),
  };
}

export type TipReviewReason = "over_pct" | "over_cents" | "late";

/**
 * Whether a tip typed in from a signed paper slip needs a manager (M6-09;
 * Payment flows step 5; Settings · pay.tipReview): a tip over 25% of the tab
 * total (money-cases ambiguity A4: the tab total), over $50, or entered more
 * than 2 hours after the slip was signed. Exactly at a limit isn't over it.
 */
export function tipReview(input: {
  readonly tabTotalCents: number;
  readonly tipCents: number;
  readonly enteredAfterMinutes: number;
  readonly review: PaySettings["tipReview"];
}): { needsApproval: boolean; reasons: TipReviewReason[] } {
  const reasons: TipReviewReason[] = [];
  // Whole numbers on both sides: tip / total > pct / 100, without a float on the amount.
  if (input.tipCents * 100 > input.tabTotalCents * input.review.overPct) reasons.push("over_pct");
  if (input.tipCents > input.review.overCents) reasons.push("over_cents");
  if (input.enteredAfterMinutes > input.review.lateHours * 60) reasons.push("late");
  return { needsApproval: reasons.length > 0, reasons };
}

/**
 * Where a tip from a paper slip posts (M6-09; Money rules 16): on its own
 * night while that night is open; after the night's Z report, on the next
 * business date (or today's, if later), with `adjusts_business_date` pointing
 * at the night it belongs to. Dates are ISO `YYYY-MM-DD`.
 */
export function tipPosting(input: {
  readonly night: string;
  readonly today: string;
  readonly nightClosed: boolean;
}): { businessDate: string; adjustsBusinessDate: string | null } {
  const night = Temporal.PlainDate.from(input.night);
  const today = Temporal.PlainDate.from(input.today);
  const late = input.nightClosed || Temporal.PlainDate.compare(today, night) > 0;
  if (!late) return { businessDate: input.night, adjustsBusinessDate: null };
  const next = night.add({ days: 1 });
  const date = Temporal.PlainDate.compare(today, next) > 0 ? today : next;
  return { businessDate: date.toString(), adjustsBusinessDate: input.night };
}
