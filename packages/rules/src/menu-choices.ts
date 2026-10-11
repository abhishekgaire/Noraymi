import { cents } from "@west4/shared";
import { packageLineShares } from "./package-lines.js";

/**
 * A line's choices, checked and priced (K-12; spec 16 · Meals, combos and sauces; Money rules 1).
 * Every setting is the manager's, from Admin → Menu:
 *   - A group may apply to some sizes only (`variantIds`), or open only once another choice of the
 *     item is picked (`whenOptionId`: "Make it a meal" opens "Meal side" and "Meal drink").
 *   - A group may include some picks (`includedChoices`); each pick past them costs
 *     `extraChoiceCents` more, on top of the choice's own price change. Picks are counted in the
 *     group's menu order, so the price doesn't depend on the order they were tapped in.
 *   - A choice may be a component: another menu item (a side, a soda), sold as its own line with
 *     its own station and tax category. Its line is its own charge plus its share of the charge of
 *     the choice that opened its group, divided across every component that choice opened by
 *     their regular prices, largest remainder (as a package divides its price, K-09). So a +$5.00
 *     meal of fries and a Coke puts $5.00 on the fries and the Coke, and none on the burger.
 * The line and its components always add up to the variant's price plus every charge.
 */
export interface ChoiceOptionRule {
  readonly id: string;
  readonly name: string;
  readonly priceDeltaCents: number;
  /** A component: the regular price of the menu item it is (its variant's price). */
  readonly component: { readonly regularCents: number } | null;
}
export interface ChoiceGroupRule {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly minChoices: number;
  readonly maxChoices: number;
  /** Picks the price includes; null: none priced by the group (each costs its own change only). */
  readonly includedChoices: number | null;
  readonly extraChoiceCents: number;
  /** The sizes the group applies to; null: every size. */
  readonly variantIds: readonly string[] | null;
  /** The choice of the same item that opens this group; null: always open. */
  readonly whenOptionId: string | null;
  readonly options: readonly ChoiceOptionRule[];
}

export type ChoiceRefusal =
  "not_a_choice" | "not_this_size" | "not_unlocked" | "choice_missing" | "too_many_choices";

export interface PricedChoice {
  readonly optionId: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly name: string;
  /** Whether the choice is a component, sold as its own line. */
  readonly component: boolean;
  /**
   * A plain choice: what it adds to the line's unit price (0 when it opened components and its
   * price was divided across them). A component: its own line's unit price.
   */
  readonly lineCents: number;
}

export type PricedChoices =
  | {
      readonly ok: true;
      /** The variant's price plus every plain choice's charge. */
      readonly parentUnitCents: number;
      /** Every pick, in menu order (group order, then choice order). */
      readonly choices: readonly PricedChoice[];
    }
  | { readonly ok: false; readonly reason: ChoiceRefusal; readonly group: string | null };

export function priceChoices(input: {
  readonly variantId: string;
  readonly priceCents: number;
  readonly groups: readonly ChoiceGroupRule[];
  readonly chosen: readonly string[];
}): PricedChoices {
  const chosen = new Set(input.chosen);
  const owner = new Map<string, ChoiceGroupRule>();
  for (const g of input.groups) for (const o of g.options) owner.set(o.id, g);
  for (const id of chosen) if (!owner.has(id)) return refuse("not_a_choice", null);
  const forSize = (g: ChoiceGroupRule) =>
    g.variantIds === null || g.variantIds.includes(input.variantId);
  for (const id of chosen) {
    const g = owner.get(id)!;
    if (!forSize(g)) return refuse("not_this_size", g.name);
    if (g.whenOptionId !== null && !chosen.has(g.whenOptionId))
      return refuse("not_unlocked", g.name);
  }
  for (const g of input.groups) {
    if (!forSize(g) || (g.whenOptionId !== null && !chosen.has(g.whenOptionId))) continue;
    const picked = g.options.filter((o) => chosen.has(o.id)).length;
    if (picked < Math.max(g.minChoices, g.required ? 1 : 0))
      return refuse("choice_missing", g.name);
    if (picked > g.maxChoices) return refuse("too_many_choices", g.name);
  }

  // Each pick's own charge: its price change, plus the group's extra price past the included picks.
  const picks: { option: ChoiceOptionRule; group: ChoiceGroupRule; cents: number }[] = [];
  for (const g of input.groups) {
    let n = 0;
    for (const o of g.options) {
      if (!chosen.has(o.id)) continue;
      const extra = g.includedChoices !== null && n >= g.includedChoices ? g.extraChoiceCents : 0;
      picks.push({ option: o, group: g, cents: o.priceDeltaCents + extra });
      n += 1;
    }
  }
  // An opening choice's charge goes to the components it opened, by their regular prices.
  const line = new Map(picks.map((p) => [p.option.id, p.cents]));
  for (const opener of picks) {
    const opened = picks.filter(
      (p) => p.option.component && p.group.whenOptionId === opener.option.id,
    );
    if (opened.length === 0 || opener.cents === 0) continue;
    const shares = packageLineShares(
      cents(opener.cents),
      opened.map((p) => ({ regularCents: p.option.component!.regularCents })),
    );
    opened.forEach((p, i) => line.set(p.option.id, line.get(p.option.id)! + shares[i]!));
    line.set(opener.option.id, 0);
  }
  const choices = picks.map((p) => ({
    optionId: p.option.id,
    groupId: p.group.id,
    groupName: p.group.name,
    name: p.option.name,
    component: p.option.component !== null,
    lineCents: line.get(p.option.id)!,
  }));
  return {
    ok: true,
    parentUnitCents:
      input.priceCents + choices.filter((c) => !c.component).reduce((s, c) => s + c.lineCents, 0),
    choices,
  };
}

const refuse = (reason: ChoiceRefusal, group: string | null): PricedChoices => ({
  ok: false,
  reason,
  group,
});
