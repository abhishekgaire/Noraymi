import { cents, type Cents } from "@west4/shared";
import { percent } from "./check-totals.js";

/**
 * A bar tab's growing hold (M6-07; Payment flows · Bar tab with a growing
 * hold, steps 2 and 3). Pure, in integer cents.
 *
 * What a tab needs held is its balance plus a 25% tip reserve on its drinks
 * before tax. The spec leaves "near the hold" and the step size open; the
 * ticket's cautious default (flagged for the founder): raise when that need
 * would pass the hold, to the larger of the need and 1.5 × the hold, rounded
 * up to the next $10. Luis M.: $43.55 + $10.00 = $53.55 passes $50.00, so the
 * hold goes to $80.00 (1.5 × $50.00 = $75.00, up to the next $10).
 *
 * Steps finish within 8 of Stripe's 10 attempts, declines included, keeping 2
 * for closing: once 8 are used, the hold stops growing and the tab is capped
 * like a card that can't grow, at the hold plus the overcapture allowance
 * (50% or $50 more, whichever is greater, when the card allows it), minus the
 * same tip reserve.
 */
export const TIP_RESERVE_PCT = 25;
export const STRIPE_INCREMENT_LIMIT = 10;
export const INCREMENTS_KEPT_FOR_CLOSE = 2;
export const INCREMENT_BUDGET = STRIPE_INCREMENT_LIMIT - INCREMENTS_KEPT_FOR_CLOSE;
const STEP_CENTS = 1000;

export interface HoldCard {
  readonly holdCents: number;
  readonly incrementalSupported: boolean;
  readonly overcaptureSupported: boolean;
  /** Increment attempts already sent to Stripe for this hold, declines included. */
  readonly incrementsUsed: number;
}

export type HoldDecision =
  | { readonly kind: "fits"; readonly leftCents: Cents; readonly capped: boolean }
  | { readonly kind: "raise"; readonly targetCents: Cents }
  | { readonly kind: "capped"; readonly leftCents: Cents; readonly overCents: Cents };

/** The 25% tip reserve on a tab's drinks before tax, half up. */
export const tipReserveCents = (drinksCents: number): Cents =>
  percent(Math.max(0, drinksCents), TIP_RESERVE_PCT);

/** What the hold must cover: the balance plus the tip reserve. */
export const holdNeededCents = (balanceCents: number, drinksCents: number): Cents =>
  cents(Math.max(0, balanceCents) + tipReserveCents(drinksCents));

/** Stripe's overcapture allowance on a hold: 50% or $50 more, whichever is greater. */
export const overcaptureAllowanceCents = (holdCents: number, supported: boolean): Cents =>
  cents(supported ? Math.max(percent(holdCents, 50), 5000) : 0);

/** Whether the hold may still grow: the card allows it and fewer than 8 attempts are used. */
export const canGrow = (card: HoldCard): boolean =>
  card.incrementalSupported && card.incrementsUsed < INCREMENT_BUDGET;

/** The new hold for a need that passes the current one. */
export function holdTarget(holdCents: number, neededCents: number): Cents {
  const step = Math.max(neededCents, percent(holdCents, 150));
  return cents(Math.ceil(step / STEP_CENTS) * STEP_CENTS);
}

/** The most a capped tab may hold: the hold plus the overcapture allowance. */
export const capCents = (card: HoldCard): Cents =>
  cents(card.holdCents + overcaptureAllowanceCents(card.holdCents, card.overcaptureSupported));

/** What a send (or a move onto the tab) does to the hold, given what the tab would need after it. */
export function holdDecision(card: HoldCard, neededCents: number): HoldDecision {
  if (neededCents <= card.holdCents) {
    const capped = !canGrow(card);
    const limit = capped ? capCents(card) : card.holdCents;
    return { kind: "fits", leftCents: cents(limit - neededCents), capped };
  }
  if (canGrow(card)) return { kind: "raise", targetCents: holdTarget(card.holdCents, neededCents) };
  const cap = capCents(card);
  if (neededCents <= cap)
    return { kind: "fits", leftCents: cents(cap - neededCents), capped: true };
  return { kind: "capped", leftCents: cents(0), overCents: cents(neededCents - cap) };
}

/** The headroom the check shows: what's left before a raise, or before the cap ("Hold · $6 left"). */
export function holdLeftCents(card: HoldCard, neededCents: number): Cents {
  const limit = canGrow(card) ? card.holdCents : capCents(card);
  return cents(Math.max(0, limit - neededCents));
}
