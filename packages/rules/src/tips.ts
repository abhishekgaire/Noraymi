import { cents, type Cents, type PaySettings } from "@west4/shared";
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
