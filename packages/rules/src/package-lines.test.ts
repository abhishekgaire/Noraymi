import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cents } from "@west4/shared";
import { packageLineShares } from "./package-lines.js";

// K-09: a package's price divided across its lines by their regular prices, largest remainder
// (spec 16 · Food in packages; Money rules 1). The cases use test prices, not a venue's.
const here = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    inputs: {
      price_cents: number;
      units: { name: string; regular_cents: number; tax_category: string }[];
    };
    expected: { shares_cents: number[]; by_tax_category_cents: Record<string, number> };
  }[];
};
const group = cases.filter((c) => c.group === "package_lines");

describe("package_lines", () => {
  it("has its cases", () => expect(group.length).toBeGreaterThanOrEqual(5));

  for (const c of group) {
    it(c.id, () => {
      const shares = packageLineShares(
        cents(c.inputs.price_cents),
        c.inputs.units.map((u) => ({ regularCents: u.regular_cents })),
      );
      expect(shares).toEqual(c.expected.shares_cents);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(c.inputs.price_cents);
      const by: Record<string, number> = {};
      c.inputs.units.forEach((u, i) => {
        by[u.tax_category] = (by[u.tax_category] ?? 0) + shares[i]!;
      });
      expect(by).toEqual(c.expected.by_tax_category_cents);
    });
  }

  it("always adds up to the price, whatever the regular prices", () => {
    for (let price = 0; price < 2000; price += 37) {
      const shares = packageLineShares(cents(price), [
        { regularCents: 799 },
        { regularCents: 1 },
        { regularCents: 1333 },
      ]);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(price);
      expect(shares.every((s) => Number.isInteger(s) && s >= 0)).toBe(true);
    }
  });

  it("refuses a package with no lines", () => {
    expect(() => packageLineShares(cents(1000), [])).toThrow(RangeError);
  });
});
