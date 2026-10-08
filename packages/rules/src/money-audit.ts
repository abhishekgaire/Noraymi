import {
  cardFee,
  checkTotals,
  refundCap,
  type SalesTaxRule,
  type TaxCategory,
} from "./check-totals.js";

/**
 * The nightly money audit (M9-15; the go-live gate · a money error): every
 * amount charged, refunded, tipped, taxed, paid out or reported is worked out
 * again through these rules and compared with what was stored. Any difference,
 * by any amount, is a money error. Pure functions in integer cents; the API's
 * audit (apps/api/src/reconcile/audit.ts) reads the rows and calls them.
 */
export type MoneyErrorKind =
  | "charge" // a double or missed charge: a check's payments against what it comes to
  | "line" // a check's stored totals against its own lines
  | "tax"
  | "gratuity"
  | "card_fee"
  | "refund" // a refund over its cap
  | "tip" // the tip ledger and the pool's shares
  | "payout"
  | "report" // the Z report, practice kept out of it
  | "drawer"
  | "journal";

/** The definition's six verbs, and which kinds of error check each. */
export const AUDIT_COVERS = {
  charged: ["charge", "line", "card_fee"],
  refunded: ["refund"],
  tipped: ["tip", "gratuity"],
  taxed: ["tax"],
  paidOut: ["payout"],
  reported: ["report", "drawer", "journal"],
} as const satisfies Record<string, readonly MoneyErrorKind[]>;

export interface MoneyError {
  readonly kind: MoneyErrorKind;
  /** The business date. */
  readonly night: string;
  /** The check's number, or a payment's, refund's or session's id. */
  readonly ref?: string;
  readonly detail: string;
  /** What the rules give, what was stored, and stored minus expected. */
  readonly expectedCents?: number;
  readonly actualCents?: number;
  readonly diffCents?: number;
}

export interface AuditLine {
  readonly kind: string;
  readonly taxCategory: TaxCategory | null;
  readonly cents: number;
}

export interface AuditCheck {
  readonly night: string;
  readonly ref: string;
  readonly status: "finalized" | "partly_paid" | "paid";
  /** Every line on the check except refund lines (refunds are checked against their caps). */
  readonly lines: readonly AuditLine[];
  readonly tax: SalesTaxRule;
  /** The gratuity percent the last revision applied, or null when it carried none. */
  readonly gratuityPct: number | string | null;
  /** The last revision's stored totals, when the check has one. */
  readonly revision: {
    readonly taxCents: number;
    readonly gratuityCents: number;
    readonly totalCents: number;
  } | null;
  readonly cardFee: "off" | "surcharge" | "cashDiscount";
  /** Captured payments allocated to the check (refund allocations left out). */
  readonly paidCents: number;
}

const sum = (lines: readonly AuditLine[], kind: string) =>
  lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.cents, 0);

function differs(
  out: MoneyError[],
  base: { kind: MoneyErrorKind; night: string; ref?: string },
  what: string,
  expected: number,
  actual: number,
) {
  if (expected === actual) return;
  out.push({
    ...base,
    detail: `${what}: the rules give ${expected} but ${actual} is stored`,
    expectedCents: expected,
    actualCents: actual,
    diffCents: actual - expected,
  });
}

/**
 * One check: its tax and gratuity worked out again from its lines, its stored
 * revision against its lines, the card fee (off at West 4: no surcharge or
 * discount line may exist), and, once paid, its payments against what it
 * comes to, so a double or missed charge shows.
 */
export function auditCheck(input: AuditCheck): MoneyError[] {
  const out: MoneyError[] = [];
  const at = { night: input.night, ref: input.ref };
  const worked = checkTotals(
    input.lines.map((l) => ({ kind: l.kind, taxCategory: l.taxCategory, cents: l.cents })),
    { tax: input.tax, gratuityPct: input.gratuityPct },
  );
  const taxLines = sum(input.lines, "tax");
  const gratuityLines = sum(input.lines, "gratuity");
  const comesTo = input.lines.reduce((s, l) => s + l.cents, 0);
  differs(out, { kind: "tax", ...at }, "tax", worked.taxCents, taxLines);
  differs(out, { kind: "gratuity", ...at }, "gratuity", worked.gratuityCents, gratuityLines);
  if (input.revision) {
    differs(out, { kind: "line", ...at }, "the revision's tax", taxLines, input.revision.taxCents);
    differs(
      out,
      { kind: "line", ...at },
      "the revision's gratuity",
      gratuityLines,
      input.revision.gratuityCents,
    );
    differs(
      out,
      { kind: "line", ...at },
      "the revision's total",
      comesTo,
      input.revision.totalCents,
    );
  }
  if (input.cardFee === "off")
    for (const kind of ["card_surcharge", "cash_discount"]) {
      const cents = sum(input.lines, kind);
      if (cents !== 0)
        differs(out, { kind: "card_fee", ...at }, `${kind} with the fee off`, 0, cents);
    }
  if (input.status === "paid" && input.paidCents !== comesTo)
    out.push({
      kind: "charge",
      ...at,
      detail:
        input.paidCents > comesTo
          ? `charged twice: payments ${input.paidCents} on a check of ${comesTo}`
          : `charge missed: payments ${input.paidCents} on a paid check of ${comesTo}`,
      expectedCents: comesTo,
      actualCents: input.paidCents,
      diffCents: input.paidCents - comesTo,
    });
  return out;
}

/** One payment's refunds, oldest first: each must fit under what's left of the capture (Money rules 14). */
export function auditRefunds(input: {
  readonly night: string;
  readonly paymentRef: string;
  readonly capturedCents: number;
  readonly refundsCents: readonly number[];
}): MoneyError[] {
  const out: MoneyError[] = [];
  let earlier = 0;
  for (const requested of input.refundsCents) {
    const cap = refundCap({
      capturedCents: input.capturedCents,
      earlierRefundsCents: earlier,
      requestedCents: requested,
    });
    if (!cap.allowed)
      out.push({
        kind: "refund",
        night: input.night,
        ref: input.paymentRef,
        detail: `a refund of ${requested} over its cap of ${cap.maxRefundableCents}`,
        expectedCents: cap.maxRefundableCents,
        actualCents: requested,
        diffCents: requested - cap.maxRefundableCents,
      });
    earlier += requested;
  }
  return out;
}

/** A card payment's surcharge where the fee is on (Money rules 10): the stored amount against the rule. */
export function auditSurcharge(input: {
  readonly night: string;
  readonly paymentRef: string;
  readonly amountCents: number;
  readonly ratePct: number | string;
  readonly taxRatePct: number | string;
  readonly funding: "credit" | "debit" | "prepaid" | "cash";
  readonly storedCents: number;
}): MoneyError[] {
  const out: MoneyError[] = [];
  const r = cardFee(input);
  differs(
    out,
    { kind: "card_fee", night: input.night, ref: input.paymentRef },
    "surcharge",
    r.surchargeCents,
    input.storedCents,
  );
  return out;
}

/** Parts of a divided amount (splits, shares, a pool) must add up to it to the cent. */
export function auditParts(input: {
  readonly night: string;
  readonly kind: MoneyErrorKind;
  readonly ref: string;
  readonly totalCents: number;
  readonly partsCents: readonly number[];
}): MoneyError[] {
  const out: MoneyError[] = [];
  differs(
    out,
    { kind: input.kind, night: input.night, ref: input.ref },
    "the parts",
    input.totalCents,
    input.partsCents.reduce((s, p) => s + p, 0),
  );
  return out;
}
