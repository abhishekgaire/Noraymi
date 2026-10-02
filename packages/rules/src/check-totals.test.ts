import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newYorkCountyTaxed } from "@west4/shared";
import {
  canPresentCheck,
  cardFee,
  checkRevision,
  checkTotals,
  depositVsCheck,
  payMyShareEven,
  refundCap,
  displayPrice,
  minSpendFor,
  minSpendLeft,
  salesTaxRule,
  splitByItem,
  splitEven,
  type TaxCategory,
  type TotalsLine,
} from "./check-totals.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const here = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    function: string;
    inputs: any;
    expected: any;
    must_not_equal?: any;
  }[];
};
const tax = salesTaxRule(newYorkCountyTaxed);
const toLines = (
  lines: { kind: string; tax_category: TaxCategory | null; cents: number }[],
): TotalsLine[] =>
  lines.map((l) => ({ kind: l.kind, taxCategory: l.tax_category, cents: l.cents }));
const asCase = (t: ReturnType<typeof checkTotals>) => ({
  subtotal_cents: t.subtotalCents,
  tax_base_cents: t.taxBaseCents,
  tax_cents: t.taxCents,
  tax_by_category_cents: t.taxByCategoryCents,
  gratuity_base_cents: t.gratuityBaseCents,
  gratuity_cents: t.gratuityCents,
  total_cents: t.totalCents,
  deposit_cents: t.depositCents,
  left_to_pay_cents: t.leftToPayCents,
});
const group = (...names: string[]) => cases.filter((c) => names.includes(c.group));

describe("check_totals, from the money cases", () => {
  const totalsCases = group("room9_close_out", "tax_and_gratuity", "bar_tabs").filter(
    (c) => c.function === "check_totals",
  );
  it("has the cases the ticket names", () => expect(totalsCases.length).toBeGreaterThanOrEqual(10));
  for (const c of totalsCases)
    it(c.id, () => {
      const t = checkTotals(toLines(c.inputs.lines), {
        tax,
        gratuityPct: c.inputs.gratuity_applies ? 20 : null,
        depositCents: c.inputs.deposit_cents,
      });
      expect(asCase(t)).toEqual(c.expected);
      if (c.must_not_equal)
        for (const [k, v] of Object.entries(c.must_not_equal))
          expect((asCase(t) as any)[k]).not.toBe(v);
    });
});

describe("tab so far, if presented now", () => {
  for (const c of group("tab_so_far"))
    it(c.id, () => {
      const t = checkTotals(
        [
          { kind: "room_time", taxCategory: "room_time", cents: c.expected.room_time_cents },
          { kind: "item", taxCategory: "drink", cents: c.expected.drinks_cents },
        ],
        { tax, gratuityPct: 20, depositCents: c.inputs.deposit_cents },
      );
      expect({
        tax_cents: t.taxCents,
        gratuity_cents: t.gratuityCents,
        total_cents: t.totalCents,
        deposit_cents: t.depositCents,
        left_to_pay_cents: t.leftToPayCents,
      }).toEqual(c.expected.if_presented_now);
    });
});

describe("the other money cases", () => {
  for (const c of group("room9_close_out").filter((x) => x.function === "check_revision"))
    it(c.id, () => {
      const rev1 = checkTotals(toLines(c.inputs.rev1_lines), {
        tax,
        gratuityPct: 20,
        depositCents: c.inputs.deposit_cents,
      });
      const rev2 = checkTotals(toLines([...c.inputs.rev1_lines, ...c.inputs.added_lines]), {
        tax,
        gratuityPct: 20,
        depositCents: c.inputs.deposit_cents,
      });
      const computed = (t: typeof rev1) => [
        { kind: "tax" as const, amountCents: t.taxCents },
        { kind: "gratuity" as const, amountCents: t.gratuityCents },
      ];
      const r = checkRevision(computed(rev1), computed(rev2));
      expect(rev1.totalCents).toBe(c.expected.rev1_total_cents);
      expect(r.reversals.map((l) => ({ kind: l.kind, amount_cents: l.amountCents }))).toEqual(
        c.expected.rev2_reversal_lines,
      );
      expect(r.added.map((l) => ({ kind: l.kind, amount_cents: l.amountCents }))).toEqual(
        c.expected.rev2_new_lines,
      );
      expect(rev2.subtotalCents).toBe(c.expected.rev2_subtotal_cents);
      expect(rev2.totalCents).toBe(c.expected.rev2_total_cents);
      expect(rev2.leftToPayCents).toBe(c.expected.rev2_left_to_pay_cents);
      expect(rev2.leftToPayCents - rev1.leftToPayCents).toBe(c.expected.amount_due_change_cents);
    });
  for (const c of group("room9_close_out").filter((x) => x.function === "can_present_check"))
    it(c.id, () => {
      const r = canPresentCheck(c.inputs.orders);
      expect({ allowed: r.allowed, blocked_by: r.blockedBy }).toEqual(c.expected);
    });
  for (const c of group("splits"))
    it(c.id, () =>
      expect(splitEven(c.inputs.amount_cents, c.inputs.shares)).toEqual(c.expected.shares_cents),
    );
  for (const c of group("pay_my_share"))
    it(c.id, () => {
      const r = payMyShareEven({
        amountLeftCents: c.inputs.amount_left_cents,
        taxCents: c.inputs.tax_cents,
        gratuityCents: c.inputs.gratuity_cents,
        guests: c.inputs.guests,
        shareNo: c.inputs.share_no,
      });
      expect(r.sharesCents).toEqual(c.expected.shares_cents);
      expect(r.paysCents).toBe(c.expected.this_guest_pays_cents);
      expect(r.taxShareCents).toBe(c.expected.this_guest_share_of_tax_cents);
      expect(r.gratuityShareCents).toBe(c.expected.this_guest_share_of_gratuity_cents);
    });
  for (const c of group("refunds"))
    it(c.id, () => {
      const r = refundCap({
        capturedCents: c.inputs.captured_cents,
        earlierRefundsCents: c.inputs.earlier_refunds_cents,
        requestedCents: c.inputs.requested_cents,
      });
      expect({ max_refundable_cents: r.maxRefundableCents, allowed: r.allowed }).toEqual(
        c.expected,
      );
    });
  for (const c of group("card_fee"))
    it(c.id, () => {
      const r = cardFee({
        amountCents: c.inputs.amount_cents,
        ratePct: c.inputs.rate_pct,
        taxRatePct: c.inputs.tax_rate_pct,
        funding: c.inputs.funding,
      });
      expect({
        surcharge_cents: r.surchargeCents,
        tax_on_surcharge_if_taxable_cents: r.taxOnSurchargeCents,
        card_pays_cents: r.cardPaysCents,
        card_pays_with_tax_on_fee_cents: r.cardPaysWithTaxOnFeeCents,
      }).toEqual(c.expected);
    });
  for (const c of cases.filter((x) => x.id === "deposit_larger_than_check_forfeit"))
    it(c.id, () => {
      // The check's own lines total what the case says: forfeit lines are fee, untaxed.
      const t = checkTotals(
        toLines(c.inputs.check_lines.filter((l: any) => l.kind === "room_time")),
        { tax, gratuityPct: 20 },
      );
      expect(t.totalCents).toBe(c.inputs.check_total_cents);
      const r = depositVsCheck({
        depositCents: c.inputs.deposit_cents,
        checkTotalCents: c.inputs.check_total_cents,
      });
      expect({
        deposit_applied_cents: r.depositAppliedCents,
        left_to_pay_cents: r.leftToPayCents,
        forfeit_line_cents: r.forfeitLineCents,
      }).toEqual(c.expected);
    });
  it("Marcus's cap is $120.00 and $120.01 is refused; after $50.00, $70.00 more at most", () => {
    expect(
      refundCap({ capturedCents: 12000, earlierRefundsCents: 0, requestedCents: 12000 }).allowed,
    ).toBe(true);
    expect(
      refundCap({ capturedCents: 12000, earlierRefundsCents: 0, requestedCents: 12001 }).allowed,
    ).toBe(false);
    expect(
      refundCap({ capturedCents: 12000, earlierRefundsCents: 5000, requestedCents: 7000 }).allowed,
    ).toBe(true);
  });
  it("leaves a forfeit line untaxed and outside the gratuity (fee), until the accountant answers", () => {
    const t = checkTotals([{ kind: "forfeit", taxCategory: "fee", cents: 1690 }], {
      tax,
      gratuityPct: 20,
    });
    expect([t.taxCents, t.gratuityCents, t.totalCents]).toEqual([0, 0, 1690]);
  });
});

describe("split by item", () => {
  it("gives each person their items, shares room time and unclaimed lines evenly, and adds up", () => {
    const lines = [
      { kind: "room_time", taxCategory: "room_time" as const, cents: 32200, claimedBy: null },
      { kind: "item", taxCategory: "drink" as const, cents: 7000, claimedBy: 0 },
      { kind: "item", taxCategory: "drink" as const, cents: 4000, claimedBy: 1 },
      { kind: "item", taxCategory: "drink" as const, cents: 4800, claimedBy: null },
    ];
    const totals = checkTotals(lines, { tax, gratuityPct: 20 });
    const shares = splitByItem({ people: 3, lines, totals, tax });
    expect(shares.reduce((s, x) => s + x.totalCents, 0)).toBe(totals.totalCents);
    expect(shares.reduce((s, x) => s + x.taxCents, 0)).toBe(totals.taxCents);
    expect(shares.reduce((s, x) => s + x.gratuityCents, 0)).toBe(totals.gratuityCents);
    // Person 0: a third of 32200 (10734) + their 7000 + a third of 4800 (1600).
    expect(shares[0]!.amountCents).toBe(10734 + 7000 + 1600);
  });
});

describe("the money cases' properties", () => {
  let seed = 11;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  it("splits add up and no two shares differ by more than a cent; the first shares are the larger", () => {
    for (let i = 0; i < 500; i++) {
      const amount = rand(1_000_000);
      const n = 1 + rand(20);
      const s = splitEven(amount, n);
      expect(s.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(1);
      for (let k = 1; k < n; k++) expect(s[k - 1]!).toBeGreaterThanOrEqual(s[k]!);
    }
  });
  it("tax by category adds up to the tax; total = subtotal + tax + gratuity; left to pay never below zero", () => {
    const cats: TaxCategory[] = ["room_time", "drink", "damage", "food", "song", "fee"];
    for (let i = 0; i < 500; i++) {
      const lines: TotalsLine[] = Array.from({ length: 1 + rand(6) }, () => ({
        kind: "item",
        taxCategory: cats[rand(cats.length)]!,
        cents: 1 + rand(50_000),
      }));
      const t = checkTotals(lines, {
        tax,
        gratuityPct: rand(2) ? 20 : null,
        depositCents: rand(100_000),
      });
      expect(Object.values(t.taxByCategoryCents).reduce((a, b) => a + b, 0)).toBe(t.taxCents);
      expect(t.totalCents).toBe(t.subtotalCents + t.taxCents + t.gratuityCents);
      expect(t.leftToPayCents).toBeGreaterThanOrEqual(0);
      // Never a gratuity on a damage fee or a fee.
      const base = lines
        .filter((l) => ["room_time", "drink", "food", "song"].includes(l.taxCategory!))
        .reduce((s, l) => s + l.cents, 0);
      if (t.gratuityCents > 0) expect(t.gratuityBaseCents).toBe(base);
    }
  });
});

describe("displayPrice (M4-25)", () => {
  it("shows the price itself with the fee off, and the credit price with a surcharge on", () => {
    expect(displayPrice(1000, null)).toBe(1000);
    expect(displayPrice(1000, 2.7)).toBe(1027);
    expect(displayPrice(49860, 2.7)).toBe(51206);
  });
});

describe("minimum spend (M4-27)", () => {
  const rows = [{ tier: "large", days: [5, 6], band: null, cents: 30000 }];
  it("leaves $84.00 after $216.00 of drinks on a $300.00 Friday minimum, and room time doesn't count", () => {
    const min = minSpendFor({
      rows,
      tier: "large",
      day: 5,
      band: "Peak",
      partySize: 10,
      bigParty: null,
    });
    expect(min).toBe(30000);
    expect(
      minSpendLeft({
        minCents: min,
        lines: [
          { kind: "room_time", cents: 50000 },
          { kind: "item", cents: 21600 },
          { kind: "damage", cents: 5000 },
        ],
      }),
    ).toEqual({ spendCents: 21600, leftCents: 8400 });
  });
  it("a comp lowers the spend; no minimum on other days, tiers, or at West 4", () => {
    expect(
      minSpendLeft({
        minCents: 30000,
        lines: [
          { kind: "item", cents: 21600 },
          { kind: "comp", cents: -1600 },
        ],
      }).leftCents,
    ).toBe(10000);
    expect(
      minSpendFor({ rows, tier: "large", day: 1, band: null, partySize: 10, bigParty: null }),
    ).toBeNull();
    expect(
      minSpendFor({ rows, tier: "small", day: 5, band: null, partySize: 4, bigParty: null }),
    ).toBeNull();
    expect(
      minSpendFor({
        rows: [],
        tier: "large",
        day: 5,
        band: null,
        partySize: 12,
        bigParty: { fromGuests: 20, minSpendCents: 0 },
      }),
    ).toBeNull();
    expect(minSpendLeft({ minCents: null, lines: [{ kind: "item", cents: 100 }] }).leftCents).toBe(
      0,
    );
  });
  it("the big-party minimum wins when that rule applies", () => {
    expect(
      minSpendFor({
        rows,
        tier: "large",
        day: 5,
        band: null,
        partySize: 22,
        bigParty: { fromGuests: 20, minSpendCents: 50000 },
      }),
    ).toBe(50000);
  });
});
