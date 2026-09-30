import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cents, divideByWeights, divideEvenly, percentOf, usd } from "./money.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const moneyCases = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    function: string;
    inputs: Record<string, unknown>;
    expected: Record<string, unknown>;
  }[];
};

describe("cents", () => {
  it("accepts integers only", () => {
    expect(cents(0)).toBe(0);
    expect(cents(49860)).toBe(49860);
    expect(cents(-1200)).toBe(-1200);
    expect(() => cents(12.5)).toThrow(/integer/);
    expect(() => cents(Number.NaN)).toThrow(/integer/);
    expect(() => cents(2 ** 53)).toThrow(/integer/);
  });

  it("wraps an amount as usd", () => {
    expect(usd(cents(61860))).toEqual({ amount: 61860, currency: "usd" });
  });
});

describe("percentOf", () => {
  it("rounds half up to the cent on exact values", () => {
    // 8.875% of $480.00 = $42.60 (Room 9's tax)
    expect(percentOf(cents(48000), 8875, 100000)).toBe(4260);
    // 20% of $480.00 = $96.00 (Room 9's gratuity)
    expect(percentOf(cents(48000), 20, 100)).toBe(9600);
    // 8.875% of $1.00 = 8.875¢ → 9¢
    expect(percentOf(cents(100), 8875, 100000)).toBe(9);
    // exactly half a cent rounds up: 0.5% of $1.00 = 0.5¢ → 1¢
    expect(percentOf(cents(100), 1, 200)).toBe(1);
    // just under half stays down: 0.4% of $1.00 = 0.4¢ → 0¢
    expect(percentOf(cents(100), 4, 1000)).toBe(0);
  });

  it("reproduces the tax of every check_totals case in the seed (8.875% of the tax base)", () => {
    const totals = moneyCases.cases.filter((c) => c.function === "check_totals");
    expect(totals.length).toBeGreaterThan(0);
    for (const c of totals) {
      const base = c.expected["tax_base_cents"];
      if (typeof base !== "number") continue;
      expect(percentOf(cents(base), 8875, 100000), c.id).toBe(c.expected["tax_cents"]);
    }
  });

  it("refuses a negative base: comps and voids are exact negatives, never rounded", () => {
    expect(() => percentOf(cents(-100), 20, 100)).toThrow(/negative/);
  });

  it("never returns a float and agrees with the integer formula", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (amount, num, den) => {
          const out = percentOf(cents(amount), num, den);
          expect(Number.isSafeInteger(out)).toBe(true);
          const exact = (2n * BigInt(amount) * BigInt(num) + BigInt(den)) / (2n * BigInt(den));
          expect(BigInt(out)).toBe(exact);
        },
      ),
    );
  });
});

describe("divideEvenly", () => {
  it("passes the acceptance examples", () => {
    expect(divideEvenly(cents(3266), 2)).toEqual([1633, 1633]);
    expect(divideEvenly(cents(3267), 2)).toEqual([1634, 1633]);
  });

  it("passes every split_even case in the seed", () => {
    const splitCases = moneyCases.cases.filter((c) => c.function === "split_even");
    expect(splitCases.length).toBeGreaterThan(0);
    for (const c of splitCases) {
      expect(
        divideEvenly(cents(c.inputs["amount_cents"] as number), c.inputs["shares"] as number),
        c.id,
      ).toEqual(c.expected["shares_cents"]);
    }
  });

  it("parts add up, differ by at most a cent, and the first (amount mod n) are the larger ones", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 1, max: 40 }),
        (amount, n) => {
          const parts = divideEvenly(cents(amount), n);
          expect(parts).toHaveLength(n);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
          expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
          const extra = amount % n;
          const base = Math.floor(amount / n);
          for (let i = 0; i < n; i += 1) expect(parts[i]).toBe(i < extra ? base + 1 : base);
          for (const p of parts) expect(Number.isSafeInteger(p)).toBe(true);
        },
      ),
    );
  });

  it("refuses a bad count or a negative amount", () => {
    expect(() => divideEvenly(cents(100), 0)).toThrow(/parts/);
    expect(() => divideEvenly(cents(100), 1.5)).toThrow(/parts/);
    expect(() => divideEvenly(cents(-100), 2)).toThrow(/negative/);
  });
});

describe("divideByWeights", () => {
  it("hands leftover cents to the largest remainders, ties to the first parts", () => {
    // $10.00 by 1:1:1 → 334, 333, 333 (all remainders tie; the first part wins)
    expect(divideByWeights(cents(1000), [1, 1, 1])).toEqual([334, 333, 333]);
    // $1.00 by 1:2 → exact 33.33 and 66.67 → 33 + 67
    expect(divideByWeights(cents(100), [1, 2])).toEqual([33, 67]);
    // $42.60 tax shared by category bases 322.00 : 158.00 (Room 9)
    // exact: 28.5765.. and 14.0235.. → floors 2857 + 1402 = 4259, the leftover cent goes to .5765
    expect(divideByWeights(cents(4260), [32200, 15800])).toEqual([2858, 1402]);
    // a zero weight gets nothing
    expect(divideByWeights(cents(100), [0, 1])).toEqual([0, 100]);
  });

  it("shares each check_totals case's tax across categories like the seed", () => {
    const totals = moneyCases.cases.filter((c) => c.function === "check_totals");
    let checked = 0;
    for (const c of totals) {
      const byCategory = c.expected["tax_by_category_cents"] as Record<string, number> | undefined;
      const lines = c.inputs["lines"] as { tax_category?: string; cents: number }[] | undefined;
      if (!byCategory || !lines) continue;
      const categories = Object.keys(byCategory);
      const bases = categories.map((cat) =>
        Math.max(
          0,
          lines.filter((l) => l.tax_category === cat).reduce((sum, l) => sum + l.cents, 0),
        ),
      );
      const shares = divideByWeights(cents(c.expected["tax_cents"] as number), bases);
      expect(Object.fromEntries(categories.map((cat, i) => [cat, shares[i]])), c.id).toEqual(
        byCategory,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("matches divideEvenly for equal weights", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 20 }),
        (amount, n) => {
          expect(divideByWeights(cents(amount), Array<number>(n).fill(1))).toEqual(
            divideEvenly(cents(amount), n),
          );
        },
      ),
    );
  });

  it("parts add up and each is within a cent of its exact share", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc
          .array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 12 })
          .filter((w) => w.some((x) => x > 0)),
        (amount, weights) => {
          const parts = divideByWeights(cents(amount), weights);
          const total = weights.reduce((a, b) => a + b, 0);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
          parts.forEach((p, i) => {
            const exact = (amount * weights[i]!) / total;
            expect(Math.abs(p - exact)).toBeLessThan(1);
          });
        },
      ),
    );
  });

  it("refuses negative weights, all-zero weights and a negative amount", () => {
    expect(() => divideByWeights(cents(100), [])).toThrow(/weights/);
    expect(() => divideByWeights(cents(100), [0, 0])).toThrow(/weights/);
    expect(() => divideByWeights(cents(100), [1, -1])).toThrow(/weights/);
    expect(() => divideByWeights(cents(-100), [1])).toThrow(/negative/);
  });
});
