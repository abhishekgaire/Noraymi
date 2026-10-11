import { describe, expect, it } from "vitest";
import {
  complete,
  defaultPicks,
  keepOpen,
  openGroups,
  unitWithPicks,
  type ChoiceGroup,
} from "./choices";

// K-12: the room page's choice sheet, with test prices.
const opt = (id: string, delta = 0, is_default = false) => ({
  id,
  name: id,
  price_delta_cents: delta,
  is_default,
  out_tonight: false,
});
const groups: ChoiceGroup[] = [
  { id: "meal", name: "Make it a meal", required: false, max_choices: 1, options: [opt("m", 500)] },
  {
    id: "side",
    name: "Meal side",
    required: true,
    when_option_id: "m",
    options: [opt("fries", 0, true), opt("rings", 100)],
  },
  {
    id: "sauce",
    name: "Sauce",
    required: true,
    max_choices: 3,
    included_choices: 1,
    extra_choice_cents: 75,
    variant_ids: ["big"],
    options: [opt("ranch"), opt("bbq"), opt("chili")],
  },
];

describe("the room page's choices (K-12)", () => {
  it("opens a meal's side only with the meal, and a size's sauce only on that size", () => {
    expect(openGroups(groups, "small", []).map((g) => g.id)).toEqual(["meal"]);
    expect(openGroups(groups, "big", ["m"]).map((g) => g.id)).toEqual(["meal", "side", "sauce"]);
  });
  it("drops a meal's side when the meal comes off", () => {
    expect(keepOpen(groups, "small", ["fries"])).toEqual([]);
    expect(keepOpen(groups, "small", ["m", "fries"])).toEqual(["m", "fries"]);
  });
  it("needs the open groups' picks", () => {
    expect(complete(groups, "small", ["m"])).toBe(false);
    expect(complete(groups, "small", ["m", "rings"])).toBe(true);
    expect(complete(groups, "big", [])).toBe(false);
    expect(complete(groups, "big", ["ranch", "bbq", "chili"])).toBe(true);
  });
  it("picks no default from a group that isn't open", () => {
    expect(defaultPicks(groups, "small")).toEqual([]);
  });
  it("prices the meal, an upcharge and extra sauces", () => {
    expect(unitWithPicks(995, groups, "small", ["m", "rings"])).toBe(1595);
    expect(unitWithPicks(999, groups, "big", ["chili", "ranch", "bbq"])).toBe(1149);
  });
  it("prices a meal's components by the shared rule the server charges with", () => {
    const meal: ChoiceGroup[] = [
      { id: "meal", name: "Make it a meal", required: false, options: [opt("m", 500)] },
      {
        id: "side",
        name: "Meal side",
        required: true,
        when_option_id: "m",
        options: [{ ...opt("fries"), component: { price_cents: 600 } }],
      },
      {
        id: "drink",
        name: "Meal drink",
        required: true,
        when_option_id: "m",
        options: [{ ...opt("coke"), component: { price_cents: 300 } }],
      },
    ];
    // The burger stays $9.95; the $5.00 goes to the fries and the Coke.
    expect(unitWithPicks(995, meal, "small", ["m", "fries", "coke"])).toBe(1495);
    // Picks not complete yet: what's picked so far, by the same rule.
    expect(unitWithPicks(995, meal, "small", ["m", "fries"])).toBe(1495);
  });
});
