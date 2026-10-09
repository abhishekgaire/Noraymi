import { describe, expect, it } from "vitest";
import { foodCategories, moveCategory, splitByStation } from "./stations.js";

// Test-only lines, marked as such; no venue's menu.
const wings = {
  name: "TEST wings",
  station: "kitchen",
  options: [{ group: "Add", name: "TEST fries", price_delta_cents: 300 }],
};
const beer = { name: "TEST beer", station: "bar", options: [] };
const soda = { name: "TEST soda", station: "bar", options: [] };

describe("splitByStation (K-02)", () => {
  it("a basket of one food item and two drinks becomes two parts, drinks first", () => {
    const parts = splitByStation([wings, beer, soda]);
    expect(parts.map((p) => p.station)).toEqual(["bar", "kitchen"]);
    expect(parts[0]!.lines).toEqual([beer, soda]);
    expect(parts[1]!.lines).toEqual([wings]);
  });

  it("an option on a food item stays on the kitchen part", () => {
    const kitchen = splitByStation([beer, wings]).find((p) => p.station === "kitchen")!;
    expect(kitchen.lines[0]!.options).toEqual([
      { group: "Add", name: "TEST fries", price_delta_cents: 300 },
    ]);
  });

  it("a basket for one station stays one part", () => {
    expect(splitByStation([beer, soda])).toEqual([{ station: "bar", lines: [beer, soda] }]);
    expect(splitByStation([wings])).toEqual([{ station: "kitchen", lines: [wings] }]);
    expect(splitByStation([])).toEqual([]);
  });

  it("refuses a station that isn't bar or kitchen", () => {
    expect(() => splitByStation([{ station: "expo" }])).toThrow(/expo/);
  });
});

describe("food categories (D100; K-02)", () => {
  const cat = (id: string, sort: number, stations: string[]) => ({
    id,
    sort,
    items: stations.map((station) => ({ station })),
  });
  const menu = [
    cat("beer", 0, ["bar"]),
    cat("TEST wings", 10, ["kitchen"]),
    cat("TEST sides", 20, ["kitchen", "kitchen"]),
    cat("TEST ramen", 30, ["kitchen"]),
  ];

  it("lists the categories with kitchen items, in the menu's order", () => {
    expect(foodCategories(menu).map((c) => c.id)).toEqual([
      "TEST wings",
      "TEST sides",
      "TEST ramen",
    ]);
  });

  it("moving a food category up swaps it with the one before, saving only what changes", () => {
    const food = foodCategories(menu);
    expect(moveCategory(food, "TEST ramen", "up")).toEqual([
      { id: "TEST ramen", sort: 20 },
      { id: "TEST sides", sort: 30 },
    ]);
    expect(moveCategory(food, "TEST wings", "up")).toEqual([]);
    expect(moveCategory(food, "TEST ramen", "down")).toEqual([]);
  });

  it("numbers categories that share a sort, so the move holds", () => {
    const flat = [
      { id: "a", sort: 0 },
      { id: "b", sort: 0 },
      { id: "c", sort: 0 },
    ];
    expect(moveCategory(flat, "c", "up")).toEqual([
      { id: "c", sort: 10 },
      { id: "b", sort: 20 },
    ]);
  });
});
