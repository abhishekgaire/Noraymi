import { readSetting, statesOf, venueModules, type Queryable } from "@west4/db";
import { stateOf, type DepositRule, type Temporal } from "@west4/shared";

/**
 * The deposit rule a new booking follows (F-03; D124): the venue's `deposit` key, with nothing
 * kept or charged while Deposits on bookings is switched off. The walk-in choice and the grace
 * minutes stay as saved; a booking that already took a deposit keeps its own terms.
 */
export async function depositsOn(c: Queryable, venueId: string): Promise<boolean> {
  return stateOf(statesOf(await venueModules(c, venueId)), "deposits") === "on";
}

export async function bookingDepositRule(
  c: Queryable,
  venueId: string,
  on: Temporal.PlainDate,
): Promise<{ value: DepositRule } | null> {
  const saved = await readSetting(c, venueId, "deposit", on);
  if (!saved) return null;
  if (await depositsOn(c, venueId)) return saved;
  return { ...saved, value: { ...saved.value, on: false } };
}
