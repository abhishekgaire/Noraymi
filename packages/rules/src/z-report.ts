import { cents, type Cents } from "@west4/shared";
import { percent } from "./check-totals.js";

/**
 * The Z report's gratuity (Money rules 9 and 16; screens · Night note 2 and
 * note 11): the sum of each room check's own gratuity line, 20% of its room
 * time and drinks after comps, rounded half up per check. Bar tabs never
 * carry one, and practice checks from training mode (T-0012) are left out
 * of every figure (M7-03). The full Z report is M7-13's; this is its rule.
 */
export interface ZCheck {
  readonly id: string;
  readonly kind: "room" | "bar";
  readonly training: boolean;
  readonly roomTimeCents?: number;
  readonly drinksCents: number;
  readonly compsCents?: number;
}

export interface ZGratuity {
  readonly roomCheckGratuityLinesCents: Readonly<Record<string, Cents>>;
  readonly zGratuityCents: Cents;
  readonly barTabGratuityCents: Cents;
  readonly drinksRoomChecksCents: Cents;
  readonly drinksBarTabsCents: Cents;
  readonly excludedTrainingChecks: readonly string[];
}

export function zReportGratuity(
  checks: readonly ZCheck[],
  gratuityPct: number | string = 20,
): ZGratuity {
  const live = checks.filter((k) => !k.training);
  const lines: Record<string, Cents> = {};
  let z = 0;
  for (const k of live.filter((x) => x.kind === "room")) {
    const base = (k.roomTimeCents ?? 0) + k.drinksCents - (k.compsCents ?? 0);
    const line = percent(Math.max(base, 0), gratuityPct);
    lines[k.id] = line;
    z += line;
  }
  const drinks = (kind: ZCheck["kind"]) =>
    cents(live.filter((k) => k.kind === kind).reduce((sum, k) => sum + k.drinksCents, 0));
  return {
    roomCheckGratuityLinesCents: lines,
    zGratuityCents: cents(z),
    barTabGratuityCents: cents(0),
    drinksRoomChecksCents: drinks("room"),
    drinksBarTabsCents: drinks("bar"),
    excludedTrainingChecks: checks.filter((k) => k.training).map((k) => k.id),
  };
}
