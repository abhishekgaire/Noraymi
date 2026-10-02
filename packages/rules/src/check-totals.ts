import {
  cents,
  divideByWeights,
  divideEvenly,
  percentOf,
  type Cents,
  type RulePack,
} from "@west4/shared";

/**
 * Check totals, tax and gratuity (M4-06; Money rules 1, 8, 9, 11, 13 and 14;
 * Room 9, worked through). Pure functions in integer cents. A percentage is a
 * decimal written as text or a number (8.875, "2.7", 0.08875), turned into an
 * exact ratio, never multiplied as a float; it's applied to a total and
 * rounded half up; a divided amount hands out its leftover cents by largest
 * remainder, ties to the first parts.
 */
export type TaxCategory = "room_time" | "drink" | "food" | "song" | "damage" | "fee" | "surcharge";

export interface TotalsLine {
  readonly kind: string;
  readonly taxCategory: TaxCategory | null;
  readonly cents: number;
}

/** An exact ratio for a decimal: "8.875" is 8875/1000, 0.08875 is 8875/100000. */
export function ratio(decimal: number | string): { num: number; den: number } {
  const text = typeof decimal === "number" ? decimal.toString() : decimal.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new RangeError(`not a plain decimal: ${text}`);
  const frac = m[2] ?? "";
  return { num: Number(`${m[1]}${frac}`), den: 10 ** frac.length };
}

/** A percent (8.875, "2.7", 20) of a non-negative total, half up. */
export const percent = (amount: number, pct: number | string): Cents => {
  const r = ratio(pct);
  return percentOf(cents(amount), r.num, r.den * 100);
};

/** The rule pack's sales tax as data (rule 8): the rate, what's taxed, the code. */
export interface SalesTaxRule {
  /** The rate as a fraction, from the pack: 0.08875. */
  readonly rate: number;
  readonly taxedCategories: readonly TaxCategory[];
  readonly surchargeTaxable: boolean;
  readonly jurisdictionCode: string | null;
}

export function salesTaxRule(pack: RulePack): SalesTaxRule {
  const t = pack.salesTax;
  if (!t.taxedCategories)
    throw new Error(
      `rule pack ${pack.id} ${pack.version} has no taxed categories; it needs version 2026.10 or later`,
    );
  const taxed = [...t.taxedCategories] as TaxCategory[];
  if (t.surchargeTaxable && !taxed.includes("surcharge")) taxed.push("surcharge");
  return {
    rate: t.rate,
    taxedCategories: taxed,
    surchargeTaxable: t.surchargeTaxable,
    jurisdictionCode: t.jurisdictionCode,
  };
}

/** Tax on a base at the pack's rate (a fraction such as 0.08875), half up. */
export const taxOn = (base: number, rate: number): Cents => {
  const r = ratio(rate);
  return percentOf(cents(Math.max(base, 0)), r.num, r.den);
};

export type GratuityAuto = "off" | "rooms" | "parties" | "all";

/** Which checks carry a gratuity (rule 9): off, room checks, parties from partyMin, or all. */
export function gratuityApplies(
  auto: GratuityAuto,
  check: { kind: "room" | "bar" | "quick" | "fee"; partySize: number | null },
  partyMin?: number,
): boolean {
  if (check.kind === "fee") return false;
  switch (auto) {
    case "off":
      return false;
    case "rooms":
      return check.kind === "room";
    case "parties":
      return partyMin !== undefined && (check.partySize ?? 0) >= partyMin;
    case "all":
      return true;
  }
}

const COMPUTED = new Set(["tax", "gratuity"]);
/** The gratuity's base: room time, items and songs after comps; never a damage fee, a fee or a surcharge. */
const GRATUITY_BASE: ReadonlySet<TaxCategory> = new Set(["room_time", "drink", "food", "song"]);

export interface Totals {
  readonly subtotalCents: Cents;
  readonly taxBaseCents: Cents;
  readonly taxCents: Cents;
  readonly taxByCategoryCents: Readonly<Partial<Record<TaxCategory, number>>>;
  readonly gratuityBaseCents: Cents;
  readonly gratuityCents: Cents;
  readonly totalCents: Cents;
  readonly depositCents: Cents;
  readonly leftToPayCents: Cents;
}

/**
 * The totals of a check's net lines (computed tax and gratuity lines are left
 * out and worked again). Tax once per rate on the taxed base, shared across
 * categories by largest remainder; the gratuity (a percent, or null when the
 * check carries none) on its base before tax; what's left after the deposit,
 * never below zero.
 */
export function checkTotals(
  lines: readonly TotalsLine[],
  opts: {
    readonly tax: SalesTaxRule;
    readonly gratuityPct: number | string | null;
    readonly depositCents?: number;
  },
): Totals {
  const net = lines.filter((l) => !COMPUTED.has(l.kind));
  const subtotal = net.reduce((s, l) => s + l.cents, 0);
  const byCategory = new Map<TaxCategory, number>();
  for (const l of net)
    if (l.taxCategory && opts.tax.taxedCategories.includes(l.taxCategory))
      byCategory.set(l.taxCategory, (byCategory.get(l.taxCategory) ?? 0) + l.cents);
  const categories = [...byCategory.keys()];
  const taxBase = Math.max(
    0,
    [...byCategory.values()].reduce((s, c) => s + c, 0),
  );
  const tax = taxOn(taxBase, opts.tax.rate);
  const taxByCategory: Partial<Record<TaxCategory, number>> = {};
  const weights = categories.map((c) => Math.max(0, byCategory.get(c)!));
  if (tax > 0 && weights.some((w) => w > 0)) {
    const shares = divideByWeights(tax, weights);
    categories.forEach((c, i) => (taxByCategory[c] = shares[i]!));
  } else categories.forEach((c) => (taxByCategory[c] = 0));
  const gratuityBase =
    opts.gratuityPct === null
      ? 0
      : Math.max(
          0,
          net
            .filter((l) => l.taxCategory && GRATUITY_BASE.has(l.taxCategory))
            .reduce((s, l) => s + l.cents, 0),
        );
  const gratuity = opts.gratuityPct === null ? cents(0) : percent(gratuityBase, opts.gratuityPct);
  const total = subtotal + tax + gratuity;
  const deposit = opts.depositCents ?? 0;
  return {
    subtotalCents: cents(subtotal),
    taxBaseCents: cents(taxBase),
    taxCents: tax,
    taxByCategoryCents: taxByCategory,
    gratuityBaseCents: cents(gratuityBase),
    gratuityCents: gratuity,
    totalCents: cents(total),
    depositCents: cents(deposit),
    leftToPayCents: cents(Math.max(0, total - deposit)),
  };
}

export interface ComputedLine {
  readonly kind: "room_time" | "min_spend" | "tax" | "gratuity";
  readonly amountCents: number;
}

/**
 * A new revision (Data model · the money core): revision n's computed lines
 * that changed are reversed (their exact negatives) and written anew; the
 * ones that didn't change stay as they are.
 */
export function checkRevision(
  previous: readonly ComputedLine[],
  next: readonly ComputedLine[],
): { reversals: ComputedLine[]; added: ComputedLine[] } {
  const reversals: ComputedLine[] = [];
  const added: ComputedLine[] = [];
  const kinds = ["room_time", "min_spend", "tax", "gratuity"] as const;
  for (const kind of kinds) {
    const before = previous.filter((l) => l.kind === kind).reduce((s, l) => s + l.amountCents, 0);
    const after = next.filter((l) => l.kind === kind).reduce((s, l) => s + l.amountCents, 0);
    if (before === after) continue;
    if (before !== 0) reversals.push({ kind, amountCents: -before });
    if (after !== 0) added.push({ kind, amountCents: after });
  }
  return { reversals, added };
}

/** Present the check (rule 6): refused while any order rings or is asked to wait. */
export function canPresentCheck(orders: readonly { id: string; status: string }[]): {
  allowed: boolean;
  blockedBy: string[];
} {
  const blockedBy = orders
    .filter((o) => o.status === "ringing" || o.status === "held")
    .map((o) => o.id);
  return { allowed: blockedBy.length === 0, blockedBy };
}

/** An even split (rule 13): the first (amount mod n) shares get the extra cent. */
export const splitEven = (amountCents: number, shares: number): Cents[] =>
  divideEvenly(cents(amountCents), shares);

/**
 * A split by item (rule 13): each person their own items; room time and lines
 * nobody claimed shared evenly; the check's tax and gratuity shared by
 * largest remainder in proportion to each share's taxed and gratuity base.
 */
export function splitByItem(input: {
  readonly people: number;
  /** Each line with who claimed it (a person's index), or null for nobody: shared evenly. */
  readonly lines: readonly (TotalsLine & { readonly claimedBy: number | null })[];
  readonly totals: Totals;
  readonly tax: SalesTaxRule;
}): { amountCents: number; taxCents: number; gratuityCents: number; totalCents: number }[] {
  const { people } = input;
  const own = Array.from({ length: people }, () => ({ net: 0, taxed: 0, grat: 0 }));
  for (const l of input.lines.filter((x) => !COMPUTED.has(x.kind))) {
    const parts =
      l.claimedBy === null || l.kind === "room_time"
        ? divideEvenly(cents(Math.abs(l.cents)), people).map((c) => (l.cents < 0 ? -c : c))
        : Array.from({ length: people }, (_, i) => (i === l.claimedBy ? l.cents : 0));
    parts.forEach((c, i) => {
      own[i]!.net += c;
      if (l.taxCategory && input.tax.taxedCategories.includes(l.taxCategory)) own[i]!.taxed += c;
      if (l.taxCategory && GRATUITY_BASE.has(l.taxCategory)) own[i]!.grat += c;
    });
  }
  const share = (amount: number, weights: number[]) =>
    amount > 0 && weights.some((w) => w > 0)
      ? divideByWeights(cents(amount), weights)
      : weights.map(() => 0);
  const taxes = share(
    input.totals.taxCents,
    own.map((o) => Math.max(0, o.taxed)),
  );
  const grats = share(
    input.totals.gratuityCents,
    own.map((o) => Math.max(0, o.grat)),
  );
  return own.map((o, i) => ({
    amountCents: o.net,
    taxCents: taxes[i]!,
    gratuityCents: grats[i]!,
    totalCents: o.net + taxes[i]! + grats[i]!,
  }));
}

/** Pay my share, an even share (Payment flows · Pay my share): 1 of N of what was left when presented. */
export function payMyShareEven(input: {
  readonly amountLeftCents: number;
  readonly taxCents: number;
  readonly gratuityCents: number;
  readonly guests: number;
  readonly shareNo: number;
}): { sharesCents: Cents[]; paysCents: Cents; taxShareCents: Cents; gratuityShareCents: Cents } {
  const shares = divideEvenly(cents(input.amountLeftCents), input.guests);
  const i = input.shareNo - 1;
  if (i < 0 || i >= input.guests)
    throw new RangeError(`no share ${input.shareNo} of ${input.guests}`);
  return {
    sharesCents: shares,
    paysCents: shares[i]!,
    taxShareCents: divideEvenly(cents(input.taxCents), input.guests)[i]!,
    gratuityShareCents: divideEvenly(cents(input.gratuityCents), input.guests)[i]!,
  };
}

/** A refund's cap (rule 14): what the payment captured minus its earlier refunds. */
export function refundCap(input: {
  readonly capturedCents: number;
  readonly earlierRefundsCents: number;
  readonly requestedCents: number;
}): { maxRefundableCents: Cents; allowed: boolean } {
  const max = Math.max(0, input.capturedCents - input.earlierRefundsCents);
  return {
    maxRefundableCents: cents(max),
    allowed: input.requestedCents > 0 && input.requestedCents <= max,
  };
}

/** A deposit against the final check (rule 11): applied up to the total; anything over is a forfeit line. */
export function depositVsCheck(input: {
  readonly depositCents: number;
  readonly checkTotalCents: number;
}): {
  depositAppliedCents: Cents;
  leftToPayCents: Cents;
  forfeitLineCents: Cents;
} {
  const applied = Math.min(input.depositCents, input.checkTotalCents);
  return {
    depositAppliedCents: cents(applied),
    leftToPayCents: cents(Math.max(0, input.checkTotalCents - input.depositCents)),
    forfeitLineCents: cents(Math.max(0, input.depositCents - input.checkTotalCents)),
  };
}

/** The card fee (M4-25 uses it; off at West 4): credit only; tax on it when surcharges are taxable. */
export function cardFee(input: {
  readonly amountCents: number;
  readonly ratePct: number | string;
  readonly taxRatePct: number | string;
  readonly funding: "credit" | "debit" | "prepaid" | "cash";
}): {
  surchargeCents: Cents;
  taxOnSurchargeCents: Cents;
  cardPaysCents: Cents;
  cardPaysWithTaxOnFeeCents: Cents;
} {
  const surcharge =
    input.funding === "credit" ? percent(input.amountCents, input.ratePct) : cents(0);
  const tax = surcharge > 0 ? percent(surcharge, input.taxRatePct) : cents(0);
  return {
    surchargeCents: surcharge,
    taxOnSurchargeCents: tax,
    cardPaysCents: cents(input.amountCents + surcharge),
    cardPaysWithTaxOnFeeCents: cents(input.amountCents + surcharge + tax),
  };
}

/**
 * The price every screen shows (Money rules 10; M4-25): with a card surcharge on, the credit price
 * (the price plus the surcharge, half up), so a guest never meets a fee they weren't shown; otherwise
 * the price itself. One function for the site, the room page, the bar and the menu PDF.
 */
export function displayPrice(priceCents: number, surchargePct: number | null): Cents {
  if (surchargePct === null || surchargePct <= 0) return cents(priceCents);
  return cents(priceCents + percent(priceCents, surchargePct));
}

/** What counts toward a minimum spend (Money rules 6): items and songs, after comps and voids. */
const SPEND_KINDS = new Set(["item", "song", "comp", "void"]);

/**
 * A room's minimum spend (Money rules 6; M4-27; off at West 4): the spend toward it (items and songs
 * after comps, before tax and gratuity; never room time, damage or fees) and what's left to it, which
 * Present adds as a `min_spend` line.
 */
export function minSpendLeft(input: {
  readonly minCents: number | null;
  readonly lines: readonly { readonly kind: string; readonly cents: number }[];
}): { spendCents: Cents; leftCents: Cents } {
  const spend = input.lines.filter((l) => SPEND_KINDS.has(l.kind)).reduce((s, l) => s + l.cents, 0);
  const left = input.minCents ? Math.max(0, input.minCents - spend) : 0;
  return { spendCents: cents(spend), leftCents: cents(left) };
}

/** The minimum that applies at check-in: the big-party rule's when it applies, else the prices row's. */
export function minSpendFor(input: {
  readonly rows: readonly {
    readonly tier: string;
    readonly days: readonly number[];
    readonly band: string | null;
    readonly cents: number;
  }[];
  readonly tier: string;
  /** Sunday 0 … Saturday 6, of the business date. */
  readonly day: number;
  readonly band: string | null;
  readonly partySize: number;
  readonly bigParty: {
    readonly fromGuests: number;
    readonly minSpendCents?: number | undefined;
  } | null;
}): number | null {
  if (
    input.bigParty &&
    input.partySize >= input.bigParty.fromGuests &&
    (input.bigParty.minSpendCents ?? 0) > 0
  )
    return input.bigParty.minSpendCents!;
  const row = input.rows.find(
    (r) =>
      r.tier === input.tier &&
      r.days.includes(input.day) &&
      (r.band === null || r.band === input.band),
  );
  return row && row.cents > 0 ? row.cents : null;
}
