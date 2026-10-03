import { percent } from "./check-totals.js";
import { cents, type Cents } from "@west4/shared";

/**
 * The guest site's live numbers (M5-01; Settings · website.priceWording; Money
 * rules 3): a price "all in" (with the gratuity and the tax on the price, the
 * gratuity untaxed, each half up), and the room a head count fits with what it
 * costs tonight. The words around them live in the i18n catalogs.
 */
export function allInCents(priceCents: number, taxRatePct: string, gratuityPct: number): Cents {
  return cents(priceCents + percent(priceCents, gratuityPct) + percent(priceCents, taxRatePct));
}

export interface SiteTier {
  readonly tier: string;
  readonly rooms: number;
  readonly capacityMin: number;
  readonly capacityMax: number;
  readonly vip: boolean;
}

/** The smallest room size that holds the party, the guests it bills for tonight, and its hourly price. */
export function roomFor(input: {
  readonly guests: number;
  readonly tiers: readonly SiteTier[];
  readonly minGuestsTonight: number;
  readonly perPersonCents: number;
  readonly vip: { readonly hourlyCents: number; readonly fromGuests: number } | null;
}): { tier: SiteTier; billableGuests: number; hourlyCents: Cents } | null {
  const sorted = [...input.tiers].sort((a, b) => a.capacityMax - b.capacityMax);
  const vipFits = input.vip && input.guests >= input.vip.fromGuests;
  const tier = vipFits
    ? sorted.find((t) => t.vip && t.capacityMax >= input.guests)
    : (sorted.find((t) => !t.vip && t.capacityMax >= input.guests) ??
      sorted.find((t) => t.capacityMax >= input.guests));
  if (!tier) return null;
  if (vipFits && tier.vip)
    return { tier, billableGuests: input.guests, hourlyCents: cents(input.vip!.hourlyCents) };
  const billable = Math.max(input.guests, input.minGuestsTonight);
  return { tier, billableGuests: billable, hourlyCents: cents(billable * input.perPersonCents) };
}
