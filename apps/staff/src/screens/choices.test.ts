import { describe, expect, it } from "vitest";
import {
  defaultPicks,
  missingGroup,
  needsSheet,
  openGroups,
  prunePicks,
  togglePick,
  unitWithChoices,
  type ChoiceGroupLike,
} from "./choices.js";

// K-12: a meal opens its side and drink; a soda group is on one size only; sauces include one.
const opt = (id: string, extra: Partial<ChoiceGroupLike["options"][number]> = {}) => ({
  id,
  name: id,
  out_tonight: false,
  ...extra,
});
const groups: ChoiceGroupLike[] = [
  {
    id: "meal",
    name: "Make it a meal",
    max_choices: 1,
    options: [opt("m", { price_delta_cents: 500 })],
  },
  {
    id: "side",
    name: "Meal side",
    required: true,
    when_option_id: "m",
    options: [
      opt("fries", { is_default: true, component: { name: "French Fries", price_cents: 545 } }),
      opt("rings", { component: { name: "Onion Rings", price_cents: 545 } }),
    ],
  },
  {
    id: "drink",
    name: "Meal drink",
    required: true,
    when_option_id: "m",
    options: [opt("coke", { component: { name: "Coke", price_cents: 310 } })],
  },
  {
    id: "sauce",
    name: "Sauce",
    min_choices: 1,
    max_choices: 3,
    included_choices: 1,
    extra_choice_cents: 75,
    variant_ids: ["big"],
    options: [opt("ranch"), opt("bbq")],
  },
];

describe("staff choices (K-12)", () => {
  it("opens the meal's groups only once the meal is picked, and the sauce on its size only", () => {
    expect(openGroups(groups, "small", []).map((g) => g.id)).toEqual(["meal"]);
    expect(openGroups(groups, "big", ["m"]).map((g) => g.id)).toEqual([
      "meal",
      "side",
      "drink",
      "sauce",
    ]);
  });
  it("drops the meal's side and drink when the meal is taken off", () => {
    const picked = ["m", "fries", "coke"];
    expect(togglePick(groups, "small", picked, groups[0]!, "m")).toEqual([]);
    expect(prunePicks(groups, "small", ["ranch"])).toEqual([]);
  });
  it("names the first open group still missing a pick", () => {
    expect(missingGroup(groups, "small", ["m"])?.id).toBe("side");
    expect(missingGroup(groups, "small", ["m", "fries", "coke"])).toBeUndefined();
    expect(missingGroup(groups, "big", [])?.id).toBe("sauce");
  });
  it("starts without the meal's default side, which comes with the meal", () => {
    expect(defaultPicks(groups, "small")).toEqual([]);
    expect(togglePick(groups, "small", [], groups[0]!, "m")).toEqual(["m", "fries"]);
  });
  it("prices the meal with its components, and extra sauces past the included one", () => {
    expect(unitWithChoices(groups, { id: "small", price_cents: 995 }, ["m", "fries", "coke"])).toBe(
      1495,
    );
    expect(unitWithChoices(groups, { id: "big", price_cents: 999 }, ["ranch", "bbq"])).toBe(1074);
  });
  it("adds up to a group's max, then refuses more", () => {
    const one = togglePick(groups, "big", [], groups[3]!, "ranch");
    const two = togglePick(groups, "big", one, groups[3]!, "bbq");
    expect(two).toEqual(["ranch", "bbq"]);
  });
  it("sends a line with a meal, sizes or many picks to the choices sheet", () => {
    expect(needsSheet(groups)).toBe(true);
    expect(needsSheet([{ id: "f", name: "Flavor", options: [opt("a")] }])).toBe(false);
  });
});
