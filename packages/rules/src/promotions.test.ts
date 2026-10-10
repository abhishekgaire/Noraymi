import { describe, expect, it } from "vitest";
import { newYorkCounty } from "@west4/shared";
import { promotionChecks, type PromoMenu } from "./promotions.js";

const pack = newYorkCounty;
const menu: PromoMenu = {
  marg: { name: "Margarita", alcohol: true, regularCents: 1300 },
  jager: { name: "Jäger Bomb", alcohol: true, regularCents: 1200 },
  coke: { name: "Coke", alcohol: false, regularCents: 400 },
  wings: { name: "Wings", alcohol: false, regularCents: 1400, food: true },
};
const codes = (r: ReturnType<typeof promotionChecks>) => r.map((x) => x.code);

describe("packages", () => {
  it("refuses an open bar with no fixed quantity of drinks, with the reason", () => {
    const r = promotionChecks(
      {
        kind: "package",
        name: "Open bar · 2 hours",
        priceCents: 6000,
        contents: [{ itemId: "marg", qty: null }],
      },
      menu,
      pack,
    );
    expect(codes(r)).toEqual(["alcohol_quantity_not_fixed"]);
    expect(r[0]?.message).toMatch(/Margarita/);
    expect(r[0]?.message).toMatch(/fixed quantity/);
  });

  it("allows a package with a fixed quantity of drinks, and soft drinks with none", () => {
    const r = promotionChecks(
      {
        kind: "package",
        name: "Birthday · 2 hours",
        priceCents: 6000,
        contents: [
          { itemId: "marg", qty: 2 },
          { itemId: "coke", qty: null },
        ],
      },
      menu,
      pack,
    );
    expect(r).toEqual([]);
  });

  it("refuses an hourly package price that includes drinks, and allows one without", () => {
    const withDrinks = promotionChecks(
      {
        kind: "package",
        name: "Room + drinks per hour",
        priceCents: 9000,
        hourly: true,
        contents: [{ itemId: "jager", qty: 2 }],
      },
      menu,
      pack,
    );
    expect(codes(withDrinks)).toEqual(["hourly_includes_alcohol"]);
    const softOnly = promotionChecks(
      {
        kind: "package",
        name: "Room + sodas per hour",
        priceCents: 6000,
        hourly: true,
        contents: [{ itemId: "coke", qty: null }],
      },
      menu,
      pack,
    );
    expect(softOnly).toEqual([]);
  });

  it("refuses a package marked private_function_only, and allows it once the pack does", () => {
    const pkg = {
      kind: "package" as const,
      name: "Private party",
      priceCents: 50000,
      privateFunctionOnly: true,
      contents: [{ itemId: "wings", qty: 4 }],
    };
    expect(codes(promotionChecks(pkg, menu, pack))).toEqual(["private_function_not_cleared"]);
    const cleared = {
      ...pack,
      alcohol: {
        ...pack.alcohol,
        promotions: { ...pack.alcohol.promotions, privateFunctionException: true },
      },
    };
    expect(promotionChecks(pkg, menu, cleared)).toEqual([]);
  });

  it("names an item the menu doesn't have", () => {
    const r = promotionChecks(
      { kind: "package", name: "X", priceCents: 100, contents: [{ itemId: "gone", qty: 1 }] },
      menu,
      pack,
    );
    expect(codes(r)).toEqual(["unknown_item"]);
  });
});

describe("price rules", () => {
  const happyHour = (priceCents: number, qty = 1, itemId = "marg") =>
    promotionChecks(
      { kind: "priceRule", name: "Happy hour", target: { itemIds: [itemId], qty }, priceCents },
      menu,
      pack,
    );

  it("refuses a $6.00 Margarita (regular $13.00) and allows $6.50", () => {
    expect(codes(happyHour(600))).toEqual(["below_half_price"]);
    expect(happyHour(600)[0]?.message).toMatch(/\$6\.50/);
    expect(happyHour(650)).toEqual([]);
  });

  it("allows two Jäger Bombs (regular $12.00 each) for $12.00 and refuses $11.00", () => {
    expect(happyHour(1200, 2, "jager")).toEqual([]);
    expect(codes(happyHour(1100, 2, "jager"))).toEqual(["below_half_price"]);
  });

  it("checks a percentage off: 50% allowed, 51% refused, on alcohol only", () => {
    const pct = (pctOff: number, itemId: string) =>
      promotionChecks(
        { kind: "priceRule", name: "Special", target: { itemIds: [itemId] }, pctOff },
        menu,
        pack,
      );
    expect(pct(50, "marg")).toEqual([]);
    expect(codes(pct(51, "marg"))).toEqual(["below_half_price"]);
    expect(pct(100, "wings")).toEqual([]);
  });

  it("refuses free alcohol in a price rule", () => {
    expect(codes(happyHour(0))).toEqual(["free_alcohol"]);
  });

  it("refuses an hourly price rule that includes drinks", () => {
    const r = promotionChecks(
      {
        kind: "priceRule",
        name: "Drinks by the hour",
        hourly: true,
        target: { itemIds: ["marg"] },
        priceCents: 2000,
      },
      menu,
      pack,
    );
    expect(codes(r)).toEqual(["hourly_includes_alcohol"]);
  });
});

describe("packages with food (K-09)", () => {
  it("refuses an hourly package with food: its food prints once", () => {
    const r = promotionChecks(
      {
        kind: "package",
        name: "Wings by the hour",
        priceCents: 3000,
        hourly: true,
        contents: [{ itemId: "wings", qty: 1 }],
      },
      menu,
      pack,
    );
    expect(codes(r)).toEqual(["hourly_includes_food"]);
    expect(r[0]?.message).toMatch(/Wings by the hour/);
  });

  it("allows a fixed-price package with food and a fixed quantity of drinks", () => {
    const r = promotionChecks(
      {
        kind: "package",
        name: "Party pack",
        priceCents: 10000,
        contents: [
          { itemId: "jager", qty: 2 },
          { itemId: "wings", qty: 1 },
        ],
      },
      menu,
      pack,
    );
    expect(r).toEqual([]);
  });
});

describe("menu items and comps", () => {
  it("refuses an alcohol item priced $0.00 and allows a $0.00 soft drink", () => {
    const r = promotionChecks(
      { kind: "menuItem", name: "Free shot", alcohol: true, priceCents: [0] },
      menu,
      pack,
    );
    expect(codes(r)).toEqual(["free_alcohol"]);
    expect(
      promotionChecks(
        { kind: "menuItem", name: "Water", alcohol: false, priceCents: [0] },
        menu,
        pack,
      ),
    ).toEqual([]);
  });

  it("lets a comp with a reason through, and refuses one without", () => {
    expect(
      promotionChecks({ kind: "comp", itemId: "marg", reason: "Spilled drink" }, menu, pack),
    ).toEqual([]);
    expect(
      codes(promotionChecks({ kind: "comp", itemId: "marg", reason: " " }, menu, pack)),
    ).toEqual(["comp_needs_reason"]);
  });
});
