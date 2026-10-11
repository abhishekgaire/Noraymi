import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { priceChoices, reverseWithParts, type ChoiceGroupRule } from "./menu-choices.js";

// K-12: a line's choices priced (spec 16 · Meals, combos and sauces; Money rules 1): included
// picks, extra picks, choices on some sizes only, groups a choice opens, and components (another
// menu item) sold as their own lines with the opening choice's price divided across them by their
// regular prices, largest remainder. The cases use test prices, not a venue's.
const here = path.dirname(fileURLToPath(import.meta.url));
interface CaseGroup {
  id: string;
  name: string;
  required: boolean;
  min_choices: number;
  max_choices: number;
  included_choices: number | null;
  extra_choice_cents: number;
  variant_ids: string[] | null;
  when_option_id: string | null;
  options: {
    id: string;
    name: string;
    delta_cents: number;
    component: { regular_cents: number; tax_category: string } | null;
  }[];
}
const { cases } = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    inputs: {
      tax_category: string;
      variant: { id: string; price_cents: number };
      groups: CaseGroup[];
      chosen: string[];
    };
    expected:
      | {
          ok: true;
          parent_unit_cents: number;
          parent_option_cents: Record<string, number>;
          component_unit_cents: Record<string, number>;
          total_cents: number;
          by_tax_category_cents: Record<string, number>;
        }
      | { ok: false; reason: string; group: string | null };
  }[];
};
const group = cases.filter((c) => c.group === "menu_choices");

const rules = (groups: CaseGroup[]): ChoiceGroupRule[] =>
  groups.map((g) => ({
    id: g.id,
    name: g.name,
    required: g.required,
    minChoices: g.min_choices,
    maxChoices: g.max_choices,
    includedChoices: g.included_choices,
    extraChoiceCents: g.extra_choice_cents,
    variantIds: g.variant_ids,
    whenOptionId: g.when_option_id,
    options: g.options.map((o) => ({
      id: o.id,
      name: o.name,
      priceDeltaCents: o.delta_cents,
      component: o.component ? { regularCents: o.component.regular_cents } : null,
    })),
  }));

describe("menu_choices", () => {
  it("has its cases", () => expect(group.length).toBeGreaterThanOrEqual(12));

  for (const c of group) {
    it(c.id, () => {
      const result = priceChoices({
        variantId: c.inputs.variant.id,
        priceCents: c.inputs.variant.price_cents,
        groups: rules(c.inputs.groups),
        chosen: c.inputs.chosen,
      });
      const e = c.expected;
      if (!e.ok) {
        expect(result).toEqual({ ok: false, reason: e.reason, group: e.group });
        return;
      }
      if (!result.ok) throw new Error(`refused: ${result.reason}`);
      expect(result.parentUnitCents).toBe(e.parent_unit_cents);
      const parentOptions = Object.fromEntries(
        result.choices.filter((x) => !x.component).map((x) => [x.optionId, x.lineCents]),
      );
      expect(parentOptions).toEqual(e.parent_option_cents);
      const components = Object.fromEntries(
        result.choices.filter((x) => x.component).map((x) => [x.optionId, x.lineCents]),
      );
      expect(components).toEqual(e.component_unit_cents);
      const total = result.parentUnitCents + Object.values(components).reduce((a, b) => a + b, 0);
      expect(total).toBe(e.total_cents);
      const by: Record<string, number> = { [c.inputs.tax_category]: result.parentUnitCents };
      for (const g of c.inputs.groups)
        for (const o of g.options)
          if (o.component && o.id in components)
            by[o.component.tax_category] = (by[o.component.tax_category] ?? 0) + components[o.id]!;
      expect(by).toEqual(e.by_tax_category_cents);
    });
  }

  it("a meal always adds up to the variant plus the meal's price, whatever the prices", () => {
    for (let meal = 0; meal < 1500; meal += 41) {
      const result = priceChoices({
        variantId: "v",
        priceCents: 995,
        chosen: ["meal", "side", "soda"],
        groups: [
          {
            id: "g1",
            name: "Make it a meal",
            required: false,
            minChoices: 0,
            maxChoices: 1,
            includedChoices: null,
            extraChoiceCents: 0,
            variantIds: null,
            whenOptionId: null,
            options: [{ id: "meal", name: "Meal", priceDeltaCents: meal, component: null }],
          },
          {
            id: "g2",
            name: "Meal side",
            required: true,
            minChoices: 1,
            maxChoices: 1,
            includedChoices: null,
            extraChoiceCents: 0,
            variantIds: null,
            whenOptionId: "meal",
            options: [
              { id: "side", name: "Fries", priceDeltaCents: 0, component: { regularCents: 799 } },
            ],
          },
          {
            id: "g3",
            name: "Meal drink",
            required: true,
            minChoices: 1,
            maxChoices: 1,
            includedChoices: null,
            extraChoiceCents: 0,
            variantIds: null,
            whenOptionId: "meal",
            options: [
              { id: "soda", name: "Coke", priceDeltaCents: 0, component: { regularCents: 1 } },
            ],
          },
        ],
      });
      if (!result.ok) throw new Error(result.reason);
      const sum =
        result.parentUnitCents +
        result.choices.reduce((s, x) => s + (x.component ? x.lineCents : 0), 0);
      expect(sum).toBe(995 + meal);
      expect(result.choices.every((x) => Number.isInteger(x.lineCents) && x.lineCents >= 0)).toBe(
        true,
      );
    }
  });

  it("a group with no included count charges no extra, whatever is set", () => {
    const result = priceChoices({
      variantId: "v",
      priceCents: 500,
      chosen: ["a", "b"],
      groups: [
        {
          id: "g",
          name: "Add-ons",
          required: false,
          minChoices: 0,
          maxChoices: 3,
          includedChoices: null,
          extraChoiceCents: 99,
          variantIds: null,
          whenOptionId: null,
          options: [
            { id: "a", name: "Egg", priceDeltaCents: 150, component: null },
            { id: "b", name: "Cheese", priceDeltaCents: 150, component: null },
          ],
        },
      ],
    });
    expect(result.ok && result.parentUnitCents).toBe(800);
  });

  it("refuses a choice that isn't the item's", () => {
    expect(priceChoices({ variantId: "v", priceCents: 1, chosen: ["x"], groups: [] })).toEqual({
      ok: false,
      reason: "not_a_choice",
      group: null,
    });
  });
});

// Voiding, comping or removing a line takes its components with it (K-12; Money rules 7): the same
// quantity of each part still on the check, at the price it was sold at, so a meal's split holds.
interface OpenLine {
  id: number;
  unit_cents: number;
  open_qty: number;
}
const voids = (
  JSON.parse(readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8")) as {
    cases: {
      id: string;
      group: string;
      inputs: { parent: OpenLine; parts: OpenLine[]; qty: number };
      expected: { lines: { id: number; qty: number; amount_cents: number }[]; total_cents: number };
    }[];
  }
).cases.filter((c) => c.group === "menu_choices_void");
const open = (l: OpenLine) => ({ id: l.id, unitCents: l.unit_cents, openQty: l.open_qty });

describe("menu_choices_void", () => {
  it("has its cases", () => expect(voids.length).toBeGreaterThanOrEqual(4));
  for (const c of voids) {
    it(c.id, () => {
      const r = reverseWithParts(open(c.inputs.parent), c.inputs.parts.map(open), c.inputs.qty);
      expect(r.lines.map((l) => ({ id: l.id, qty: l.qty, amount_cents: l.amountCents }))).toEqual(
        c.expected.lines,
      );
      expect(r.totalCents).toBe(c.expected.total_cents);
    });
  }
  it("refuses more than is left on the parent, or nothing", () => {
    const burger = { id: 1, unitCents: 995, openQty: 1 };
    expect(() => reverseWithParts(burger, [], 2)).toThrow(RangeError);
    expect(() => reverseWithParts(burger, [], 0)).toThrow(RangeError);
  });
  it("what's voided and what stays add up to what was sold", () => {
    for (let n = 1; n <= 5; n++)
      for (let q = 1; q <= n; q++) {
        const parts = [
          { id: 2, unitCents: 319, openQty: n },
          { id: 3, unitCents: 181, openQty: n },
        ];
        const r = reverseWithParts({ id: 1, unitCents: 995, openQty: n }, parts, q);
        expect(1495 * n + r.totalCents).toBe(1495 * (n - q));
      }
  });
});
