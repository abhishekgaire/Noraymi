import { cents, type Cents } from "@west4/shared";

/**
 * The reason-only limit (M2-14; spec 02; spec 05 · rule 7). A comp or void up
 * to the limit each, and up to the limit a shift per person, needs only a
 * reason; over either, it needs approval. Limits of 0 send everything for
 * approval. Amounts count by their size: comp and void lines are negative.
 */
export interface ReasonOnlyLimits {
  readonly eachCents: number;
  readonly perShiftCents: number;
}

export interface ReasonOnlyAnswer {
  readonly needsApproval: boolean;
  readonly overEachLimit: boolean;
  readonly overShiftLimit: boolean;
  readonly shiftTotalAfterCents: number;
  /** "$X left this shift", before this one. */
  readonly leftThisShiftBeforeCents: number;
}

export function reasonOnly(
  usedThisShift: Cents,
  amount: Cents,
  limits: ReasonOnlyLimits,
): ReasonOnlyAnswer {
  const size = Math.abs(amount);
  const used = Math.abs(usedThisShift);
  const after = used + size;
  const overEachLimit = size > limits.eachCents;
  const overShiftLimit = after > limits.perShiftCents;
  return {
    needsApproval: overEachLimit || overShiftLimit,
    overEachLimit,
    overShiftLimit,
    shiftTotalAfterCents: after,
    leftThisShiftBeforeCents: Math.max(0, limits.perShiftCents - used),
  };
}

/** "Comp N min of room time" at the segment's hourly rate, rounded once (rule 7 with rule 3). */
export function compMinutesCents(minutes: number, hourlyCents: Cents): Cents {
  return cents(Math.floor((hourlyCents * minutes + 30) / 60));
}
