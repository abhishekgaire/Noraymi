import type { RulePack, SettingsKey, SettingsValue } from "@west4/shared";
import { Temporal } from "@west4/shared";
import { parseCutover } from "./time.js";

/**
 * The rule-pack checks a settings save must pass (spec 03 · Rule packs;
 * M1-11). Each returns the reasons a save is refused, in the words Admin
 * shows; an empty list means the save may go ahead.
 */

/** Stripe's in-person card cost, the cap a surcharge can never pass (pack cardFee.surcharge.cap = "inPersonCardCost"). */
export const IN_PERSON_CARD_COST_PCT = 2.7;

export interface CheckContext {
  readonly pack: RulePack;
  /** Today's business date, for the surcharge notice period. */
  readonly today: Temporal.PlainDate;
  /** The venue's day cutover, "HH:MM": a time before it belongs to the next calendar day. */
  readonly cutover: string;
}

function minutesOnBusinessDate(time: string, cutover: string): number {
  const t = parseCutover(time);
  const c = parseCutover(cutover);
  const minutes = t.hour * 60 + t.minute;
  return Temporal.PlainTime.compare(t, c) < 0 ? minutes + 24 * 60 : minutes;
}

function clock(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function checkSetting<K extends SettingsKey>(
  key: K,
  value: SettingsValue<K>,
  context: CheckContext,
): string[] {
  switch (key) {
    case "hours":
      return checkHours(value as SettingsValue<"hours">, context);
    case "pay":
      return checkPay(value as SettingsValue<"pay">, context);
    case "languages":
      return checkLanguages(value as SettingsValue<"languages">);
    case "safety":
      return checkSafety(value as SettingsValue<"safety">);
    case "deposit":
      return checkDeposit(value as SettingsValue<"deposit">);
    case "pos":
      return checkPos(value as SettingsValue<"pos">);
    case "tabs":
      return checkTabs(value as SettingsValue<"tabs">);
    default:
      return [];
  }
}

/** Admin → Deposits & cancelling (M5-06): each mode's value means what the mode says. */
export function checkDeposit(deposit: SettingsValue<"deposit">): string[] {
  const reasons: string[] = [];
  const v = deposit.value;
  if ((deposit.mode === "perPerson" || deposit.mode === "flat") && (!Number.isInteger(v) || v < 1))
    reasons.push("A per-guest or flat deposit needs an amount in whole cents, more than $0.");
  if (deposit.mode === "percent" && (!Number.isInteger(v) || v < 1 || v > 100))
    reasons.push("A percent deposit is a whole percent from 1 to 100.");
  if ((deposit.mode === "firstHour" || deposit.mode === "cardHold") && v !== 0)
    reasons.push("The first-hour and card-hold deposits take no amount.");
  if (!Number.isInteger(deposit.refundHours) || deposit.refundHours > 24 * 30)
    reasons.push("The refund cut-off is a whole number of hours, at most 30 days.");
  const big = deposit.bigParty;
  if (big && big.fromGuests < 2) reasons.push("A big party starts at 2 guests or more.");
  if (big && (!Number.isInteger(big.refundHours) || big.refundHours > 24 * 30))
    reasons.push("The big-party refund cut-off is a whole number of hours, at most 30 days.");
  return reasons;
}

export function checkHours(
  hours: SettingsValue<"hours">,
  { pack, cutover }: CheckContext,
): string[] {
  const reasons: string[] = [];
  if (hours.lastCall !== null) {
    const house = minutesOnBusinessDate(hours.lastCall, cutover);
    const packLast = minutesOnBusinessDate(pack.alcohol.lastSale, cutover);
    if (house > packLast) {
      reasons.push(
        `The house last call (${clock(hours.lastCall)}) can't be later than the rule pack's last sale (${clock(pack.alcohol.lastSale)}).`,
      );
    }
  }
  return reasons;
}

export function checkPay(pay: SettingsValue<"pay">, { pack, today }: CheckContext): string[] {
  const reasons: string[] = [];
  const fee = pay.cardFee;
  if (fee.mode === "surcharge") {
    const cap = Math.min(IN_PERSON_CARD_COST_PCT, pack.cardFee.surcharge.networkCapPct);
    if (fee.pct > cap) {
      reasons.push(
        `A card surcharge can't be more than the in-person card cost (${IN_PERSON_CARD_COST_PCT}%); ${fee.pct}% is over it.`,
      );
    }
    const noticeDays = pack.cardFee.surcharge.noticeDays;
    if (fee.noticeSentOn === null) {
      reasons.push(
        `A card surcharge starts only ${noticeDays} days after the notice is sent; set the date the notice went out.`,
      );
    } else {
      const startsOn = Temporal.PlainDate.from(fee.noticeSentOn).add({ days: noticeDays });
      if (Temporal.PlainDate.compare(today, startsOn) < 0) {
        reasons.push(
          `A card surcharge starts only ${noticeDays} days after the notice sent on ${fee.noticeSentOn}: from ${startsOn.toString()}.`,
        );
      }
    }
  }
  if (fee.mode === "discount" && !pack.cardFee.discount.allowed) {
    reasons.push("A cash discount isn't allowed under this rule pack.");
  }
  return reasons;
}

export function checkLanguages(languages: SettingsValue<"languages">): string[] {
  const reasons: string[] = [];
  const allowed = new Set(["en", "es"]);
  for (const l of languages.staff)
    if (!allowed.has(l))
      reasons.push(`Staff screens ship in English and Spanish only; "${l}" isn't available.`);
  if (new Set(languages.staff).size !== languages.staff.length)
    reasons.push("Each language can be listed once.");
  return reasons;
}

export function checkSafety(safety: SettingsValue<"safety">): string[] {
  const reasons: string[] = [];
  if (
    safety.occupancyLimit !== null &&
    (!Number.isInteger(safety.occupancyLimit) || safety.occupancyLimit <= 0)
  ) {
    reasons.push(
      "The occupancy limit is the posted whole number from the certificate of occupancy, or left empty.",
    );
  }
  return reasons;
}

/**
 * Admin → Bar POS (M6-25): the locks and Mute are whole and more than nothing,
 * and an order's aging steps come in the order the escalation sentence reads
 * them (bar phones, then amber, then pink, then a text or call), each later
 * than the one before. A reason-only limit of $0 is allowed: it sends every
 * comp and void for approval.
 */
export function checkPos(pos: SettingsValue<"pos">): string[] {
  const reasons: string[] = [];
  const whole = (n: number) => Number.isInteger(n) && n >= 1;
  if (!whole(pos.idleLockMin))
    reasons.push("The idle lock is a whole number of minutes, 1 or more.");
  if (!whole(pos.wipeLockSec)) reasons.push("Wipe screen is a whole number of seconds, 1 or more.");
  if (!whole(pos.muteSec)) reasons.push("Mute lasts a whole number of seconds, 1 or more.");
  const a = pos.orderAging;
  if (![a.phonesSec, a.amberSec, a.pinkSec, a.callSec].every(whole))
    reasons.push("Each order-aging time is a whole number of seconds, 1 or more.");
  else if (!(a.phonesSec < a.amberSec && a.amberSec < a.pinkSec && a.pinkSec < a.callSec))
    reasons.push(
      "Order aging runs in order: bar phones, then amber, then pink, then a text or call, each later than the one before.",
    );
  return reasons;
}

/** Admin → Bar POS · Tabs (M6-25): the opening hold is more than $0, and a tab is flagged above it. */
export function checkTabs(tabs: SettingsValue<"tabs">): string[] {
  const reasons: string[] = [];
  if (tabs.openingHoldCents < 100) reasons.push("The opening hold is $1.00 or more.");
  if (tabs.flagOverCents <= tabs.openingHoldCents)
    reasons.push("The amount that flags a tab is more than the opening hold.");
  return reasons;
}
