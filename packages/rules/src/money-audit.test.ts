import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newYorkCountyTaxed, percentOf, cents } from "@west4/shared";
import { salesTaxRule, splitEven, payMyShareEven, type TaxCategory } from "./check-totals.js";
import { poolShares } from "./tip-pool.js";
import {
  AUDIT_COVERS,
  auditCheck,
  auditParts,
  auditRefunds,
  auditSurcharge,
  type AuditCheck,
  type AuditLine,
} from "./money-audit.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const here = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as { cases: { id: string; group: string; function: string; inputs: any; expected: any }[] };
const tax = salesTaxRule(newYorkCountyTaxed);
const night = "2026-09-25";
const lines = (ls: { kind: string; tax_category: TaxCategory | null; cents: number }[]) =>
  ls.map((l): AuditLine => ({ kind: l.kind, taxCategory: l.tax_category, cents: l.cents }));
/** A check as finalizing stores it: its net lines plus the tax and gratuity lines the case expects. */
const stored = (net: AuditLine[], taxCents: number, gratuityCents: number): AuditLine[] => [
  ...net,
  { kind: "tax", taxCategory: null, cents: taxCents },
  ...(gratuityCents ? [{ kind: "gratuity", taxCategory: null, cents: gratuityCents }] : []),
];
const check = (over: Partial<AuditCheck> & Pick<AuditCheck, "lines">): AuditCheck => ({
  night,
  ref: "#1042",
  status: "finalized",
  tax,
  gratuityPct: 20,
  revision: null,
  cardFee: "off",
  paidCents: 0,
  ...over,
});
const room9 = cases.find((c) => c.id === "room9_closeout_rev1")!;
const room9Lines = stored(
  lines(room9.inputs.lines),
  room9.expected.tax_cents,
  room9.expected.gratuity_cents,
);

/**
 * Every group of the money cases goes through the audit's recompute: the groups whose amounts reach a
 * stored row (checks, payments, refunds, the card fee, splits and shares, the Z report's gratuity,
 * the tip pool) through the audit functions; the rest are the inputs those amounts are made from
 * (minutes, billable guests, business dates, rates, approvals, the tip screen), which the audit
 * meets already worked out in the stored lines, so a wrong one shows as a wrong line, tax or total.
 */
const THROUGH_THE_AUDIT = new Set([
  "room9_close_out",
  "tax_and_gratuity",
  "bar_tabs",
  "tab_so_far",
  "refunds",
  "card_fee",
  "splits",
  "pay_my_share",
  "deposits",
  "z_report",
  "tips",
]);
const AS_STORED_INPUTS = new Set([
  "room_time",
  "billable_guests",
  "business_date",
  "reason_only_limits",
  "approvals",
]);

describe("the money cases, every group, through the audit (M9-15)", () => {
  it("knows every group in seed/money-cases.json", () => {
    for (const g of new Set(cases.map((c) => c.group)))
      expect(THROUGH_THE_AUDIT.has(g) || AS_STORED_INPUTS.has(g), g).toBe(true);
  });

  for (const c of cases.filter((x) => x.function === "check_totals"))
    it(`${c.id}: stored as the rules give it is clean; a cent off is caught`, () => {
      const net = lines(c.inputs.lines);
      const pct = c.inputs.gratuity_applies ? 20 : null;
      const ok = stored(net, c.expected.tax_cents, c.expected.gratuity_cents);
      const total = c.expected.total_cents;
      expect(
        auditCheck(
          check({
            lines: ok,
            gratuityPct: pct,
            status: "paid",
            paidCents: total,
            revision: {
              taxCents: c.expected.tax_cents,
              gratuityCents: c.expected.gratuity_cents,
              totalCents: total,
            },
          }),
        ),
      ).toEqual([]);
      const off = stored(net, c.expected.tax_cents + 1, c.expected.gratuity_cents);
      expect(auditCheck(check({ lines: off, gratuityPct: pct }))).toEqual([
        expect.objectContaining({ kind: "tax", diffCents: 1, expectedCents: c.expected.tax_cents }),
      ]);
    });

  for (const c of cases.filter((x) => x.function === "check_revision"))
    it(`${c.id}: revision 2's reversals and new lines leave the check clean`, () => {
      const all = [
        ...lines(c.inputs.rev1_lines),
        ...lines(c.inputs.added_lines),
        ...[...c.expected.rev2_reversal_lines, ...c.expected.rev2_new_lines].map(
          (l: any): AuditLine => ({ kind: l.kind, taxCategory: null, cents: l.amount_cents }),
        ),
      ];
      // Revision 1's computed lines were written first.
      const rev1 = cases.find((x) => x.id === "room9_closeout_rev1")!.expected;
      const withRev1 = stored(all, rev1.tax_cents, rev1.gratuity_cents);
      expect(
        auditCheck(
          check({ lines: withRev1, status: "paid", paidCents: c.expected.rev2_total_cents }),
        ),
      ).toEqual([]);
    });

  for (const c of cases.filter((x) => x.group === "tab_so_far"))
    it(`${c.id}: the tab so far, presented now, audits clean`, () => {
      const e = c.expected.if_presented_now;
      const net: AuditLine[] = [
        { kind: "room_time", taxCategory: "room_time", cents: c.expected.room_time_cents },
        { kind: "item", taxCategory: "drink", cents: c.expected.drinks_cents },
      ];
      expect(auditCheck(check({ lines: stored(net, e.tax_cents, e.gratuity_cents) }))).toEqual([]);
    });

  for (const c of cases.filter((x) => x.group === "refunds"))
    it(`${c.id}: a refund is an error exactly when the cap refuses it`, () => {
      const errors = auditRefunds({
        night,
        paymentRef: "pay",
        capturedCents: c.inputs.captured_cents,
        refundsCents: [c.inputs.earlier_refunds_cents, c.inputs.requested_cents].filter(
          (x) => x > 0,
        ),
      });
      expect(errors.length === 0).toBe(c.expected.allowed);
    });

  for (const c of cases.filter((x) => x.group === "card_fee"))
    it(`${c.id}: the stored surcharge against the rule`, () => {
      const base = {
        night,
        paymentRef: "pay",
        amountCents: c.inputs.amount_cents,
        ratePct: c.inputs.rate_pct,
        taxRatePct: c.inputs.tax_rate_pct,
        funding: c.inputs.funding,
      };
      expect(auditSurcharge({ ...base, storedCents: c.expected.surcharge_cents })).toEqual([]);
      expect(auditSurcharge({ ...base, storedCents: c.expected.surcharge_cents + 1 })).toHaveLength(
        1,
      );
    });

  it("the card fee off: any surcharge line on a check is an error", () => {
    const errors = auditCheck(
      check({
        lines: [...room9Lines, { kind: "card_surcharge", taxCategory: "surcharge", cents: 1 }],
      }),
    );
    expect(errors.map((e) => e.kind)).toContain("card_fee");
  });

  for (const c of cases.filter((x) => x.group === "splits"))
    it(`${c.id}: the parts add up`, () => {
      expect(
        auditParts({
          night,
          kind: "charge",
          ref: "split",
          totalCents: c.inputs.amount_cents,
          partsCents: splitEven(c.inputs.amount_cents, c.inputs.shares),
        }),
      ).toEqual([]);
      expect(c.expected.shares_cents).toEqual(splitEven(c.inputs.amount_cents, c.inputs.shares));
    });

  for (const c of cases.filter((x) => x.group === "pay_my_share"))
    it(`${c.id}: every share adds up to what was left`, () => {
      const r = payMyShareEven({
        amountLeftCents: c.inputs.amount_left_cents,
        taxCents: c.inputs.tax_cents,
        gratuityCents: c.inputs.gratuity_cents,
        guests: c.inputs.guests,
        shareNo: c.inputs.share_no,
      });
      expect(r.sharesCents).toEqual(c.expected.shares_cents);
      expect(
        auditParts({
          night,
          kind: "charge",
          ref: "shares",
          totalCents: c.inputs.amount_left_cents,
          partsCents: r.sharesCents,
        }),
      ).toEqual([]);
    });

  for (const c of cases.filter((x) => x.function === "deposit_vs_check"))
    it(`${c.id}: the deposit and the forfeit line pay the check exactly`, () => {
      const ls: AuditLine[] = [
        ...lines(c.inputs.check_lines),
        { kind: "forfeit", taxCategory: null, cents: c.expected.forfeit_line_cents },
      ];
      expect(
        auditCheck(
          check({
            lines: ls,
            status: "paid",
            paidCents: c.expected.deposit_applied_cents + c.expected.forfeit_line_cents,
          }),
        ),
      ).toEqual([]);
    });

  for (const c of cases.filter((x) => x.group === "z_report"))
    it(`${c.id}: each room check's gratuity line audits clean, and they add up to the Z`, () => {
      const lines_: number[] = [];
      for (const r of c.inputs.room_checks) {
        const base = r.room_time_cents + r.drinks_cents - (r.comps_cents ?? 0);
        const g = percentOf(cents(base), 20, 100);
        const net: AuditLine[] = [
          { kind: "room_time", taxCategory: "room_time", cents: r.room_time_cents },
          { kind: "item", taxCategory: "drink", cents: r.drinks_cents },
          ...(r.comps_cents
            ? [{ kind: "comp", taxCategory: "drink" as const, cents: -r.comps_cents }]
            : []),
        ];
        const t = percentOf(cents(base), 8875, 100000);
        expect(auditCheck(check({ ref: r.id, lines: stored(net, t, g) }))).toEqual([]);
        expect(g).toBe(c.expected.room_check_gratuity_lines_cents[r.id]);
        lines_.push(g);
      }
      expect(
        auditParts({
          night,
          kind: "report",
          ref: "z",
          totalCents: c.expected.z_gratuity_cents,
          partsCents: lines_,
        }),
      ).toEqual([]);
    });

  for (const c of cases.filter((x) => x.function === "tip_pool"))
    it(`${c.id}: the pool's shares add up to the pool`, () => {
      const r = poolShares({
        method: "hours",
        workers: Object.entries(c.inputs.minutes as Record<string, number>).map(([u, m]) => ({
          userId: u,
          role: "bartender" as const,
          duty: "bar" as const,
          minutes: m,
          eligible: true,
        })),
        gratuityCents: c.inputs.pool_cents,
        cardTipCents: 0,
        cashTipCents: 0,
      });
      expect(
        auditParts({
          night,
          kind: "tip",
          ref: "pool",
          totalCents: c.inputs.pool_cents,
          partsCents: r.shares.map((s) => s.gratuityCents),
        }),
      ).toEqual([]);
    });
});

describe("seeded faults, one of each kind (M9-15)", () => {
  const paid = (over: Partial<AuditCheck> = {}) =>
    check({
      lines: room9Lines,
      status: "paid",
      paidCents: 61860,
      revision: { taxCents: 4260, gratuityCents: 9600, totalCents: 61860 },
      ...over,
    });

  it("Room 9 paid as the seed says is clean", () => expect(auditCheck(paid())).toEqual([]));

  it("a double charge and a missed charge", () => {
    expect(auditCheck(paid({ paidCents: 61860 + 49860 }))).toEqual([
      expect.objectContaining({ kind: "charge", diffCents: 49860 }),
    ]);
    expect(auditCheck(paid({ paidCents: 12000 }))).toEqual([
      expect.objectContaining({ kind: "charge", diffCents: -49860 }),
    ]);
  });

  it("a gratuity a cent off, and a revision that disagrees with its lines", () => {
    const g = room9Lines.map((l) => (l.kind === "gratuity" ? { ...l, cents: l.cents - 1 } : l));
    const kinds = auditCheck(paid({ lines: g, paidCents: 61859 })).map((e) => e.kind);
    expect(kinds).toContain("gratuity");
    expect(kinds).toContain("line");
  });

  it("a refund over its cap, and a second refund that takes it over", () => {
    expect(
      auditRefunds({ night, paymentRef: "p", capturedCents: 12000, refundsCents: [12001] }),
    ).toEqual([expect.objectContaining({ kind: "refund", diffCents: 1 })]);
    expect(
      auditRefunds({ night, paymentRef: "p", capturedCents: 12000, refundsCents: [6000, 6001] }),
    ).toEqual([
      expect.objectContaining({ kind: "refund", expectedCents: 6000, actualCents: 6001 }),
    ]);
    expect(
      auditRefunds({ night, paymentRef: "p", capturedCents: 12000, refundsCents: [6000, 6000] }),
    ).toEqual([]);
  });

  it("covers every amount the definition names", () => {
    expect(Object.keys(AUDIT_COVERS)).toEqual([
      "charged",
      "refunded",
      "tipped",
      "taxed",
      "paidOut",
      "reported",
    ]);
  });
});
