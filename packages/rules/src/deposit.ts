import {
  Temporal,
  cents,
  percentOf,
  type Cents,
  type DepositRule,
  type PriceSettings,
} from "@west4/shared";
import { billableGuestsOn, hourlyCentsFor } from "./rates.js";

/**
 * The deposit (M2-02; spec 05 · rule 11; spec 03 · DepositRule). A booking's
 * deposit is the first hour for billable guests at West 4, or the big-party
 * rule from its guest count (a flat $250 from 20). The other modes: so much a
 * person, a flat amount, a percent of the first hour; a card hold charges
 * nothing. Online booking reuses this in M5.
 */
export interface Deposit {
  readonly billableGuests: number;
  readonly depositCents: Cents;
  /** The rule that decided it, in words the manage page and the receipt can show. */
  readonly rule: string;
}

/** "$10" or "$12.50": the rule's words carry the amount the way the spec writes it. */
const dollars = (c: number): string => {
  const whole = `$${(c / 100).toFixed(2)}`;
  return whole.endsWith(".00") ? whole.slice(0, -3) : whole;
};

export function deposit(
  partySize: number,
  businessDate: Temporal.PlainDate,
  rule: DepositRule,
  prices: PriceSettings,
): Deposit {
  const billableGuests = billableGuestsOn(partySize, businessDate, prices);
  if (!rule.on) return { billableGuests, depositCents: cents(0), rule: "deposits are off" };
  const firstHour = hourlyCentsFor(prices.rate, billableGuests).hourlyCents;
  const big = rule.bigParty;
  if (big && partySize >= big.fromGuests) {
    if (big.deposit.kind === "flat")
      return {
        billableGuests,
        depositCents: cents(big.deposit.cents),
        rule: `big party: flat ${dollars(big.deposit.cents)} from ${big.fromGuests} guests`,
      };
    return {
      billableGuests,
      depositCents: percentOf(firstHour, big.deposit.pct, 100),
      rule: `big party: ${big.deposit.pct}% of the first hour from ${big.fromGuests} guests`,
    };
  }
  switch (rule.mode) {
    case "firstHour":
      return {
        billableGuests,
        depositCents: firstHour,
        rule:
          prices.rate.mode === "perPerson"
            ? `first hour: billable guests x ${dollars(prices.rate.perPersonCents)}`
            : "first hour",
      };
    case "perPerson":
      return {
        billableGuests,
        depositCents: cents(rule.value * billableGuests),
        rule: `${dollars(rule.value)} a person`,
      };
    case "flat":
      return {
        billableGuests,
        depositCents: cents(rule.value),
        rule: `flat ${dollars(rule.value)}`,
      };
    case "percent":
      return {
        billableGuests,
        depositCents: percentOf(firstHour, rule.value, 100),
        rule: `${rule.value}% of the first hour`,
      };
    case "cardHold":
      return {
        billableGuests,
        depositCents: cents(0),
        rule: "card hold: a card is saved and nothing is charged",
      };
  }
}
