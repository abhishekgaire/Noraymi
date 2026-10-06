import { cents, percentOf, type RulePack } from "@west4/shared";

/**
 * Promotion checks (spec 03 · Rule packs). Saving a menu item, a package or a
 * dated price rule runs them against the venue's rule pack: alcohol in a
 * package comes in a fixed quantity, no hourly price includes alcohol, a
 * promotional price is at least half the regular one, and no alcohol costs
 * $0. A package that relies on the private-function exception is refused
 * until the pack says otherwise (open with the lawyer). Comps stay allowed
 * with a reason and are never advertised. An empty list means it passes.
 */
export interface PromoMenuItem {
  readonly name: string;
  readonly alcohol: boolean;
  readonly regularCents: number;
}
export type PromoMenu = Readonly<Record<string, PromoMenuItem>>;

export type Promotable =
  | {
      readonly kind: "menuItem";
      readonly name: string;
      readonly alcohol: boolean;
      /** Every variant's price. */
      readonly priceCents: readonly number[];
    }
  | {
      readonly kind: "package";
      readonly name: string;
      readonly priceCents: number;
      /** Priced per hour. */
      readonly hourly?: boolean;
      readonly privateFunctionOnly?: boolean;
      /** qty null means as many as the guests want. */
      readonly contents: readonly { readonly itemId: string; readonly qty: number | null }[];
    }
  | {
      readonly kind: "priceRule";
      readonly name: string;
      readonly hourly?: boolean;
      /** qty is how many the price buys together ("2 for $12"); 1 when absent. */
      readonly target: { readonly itemIds: readonly string[]; readonly qty?: number };
      readonly priceCents?: number;
      /** A whole percentage off. */
      readonly pctOff?: number;
    }
  | { readonly kind: "comp"; readonly itemId: string; readonly reason: string }
  | {
      /** Bar mode's song offer (M6-26): "Buy a drink, get a song" is a $0.00 song; a free drink with a song is free alcohol. */
      readonly kind: "songOffer";
      readonly freeDrinkWithSong: boolean;
    };

export type PromotionRefusalCode =
  | "alcohol_quantity_not_fixed"
  | "hourly_includes_alcohol"
  | "below_half_price"
  | "free_alcohol"
  | "private_function_not_cleared"
  | "comp_needs_reason"
  | "free_drink_with_song"
  | "unknown_item";

export interface PromotionRefusal {
  readonly code: PromotionRefusalCode;
  readonly message: string;
}

const dollars = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

export function promotionChecks(
  thing: Promotable,
  menu: PromoMenu,
  pack: Pick<RulePack, "alcohol">,
): PromotionRefusal[] {
  const rules = pack.alcohol.promotions;
  const out: PromotionRefusal[] = [];
  const refuse = (code: PromotionRefusalCode, message: string) => out.push({ code, message });
  const lookup = (id: string) => {
    const item = menu[id];
    if (!item) refuse("unknown_item", `The menu has no item "${id}".`);
    return item;
  };

  switch (thing.kind) {
    case "menuItem":
      if (thing.alcohol && !rules.freeDrinks && thing.priceCents.some((p) => p <= 0)) {
        refuse("free_alcohol", `${thing.name} contains alcohol and can't cost $0.00.`);
      }
      break;

    case "package": {
      const items = thing.contents.map((c) => ({ c, item: lookup(c.itemId) }));
      for (const { c, item } of items) {
        if (item?.alcohol && (c.qty === null || c.qty <= 0)) {
          refuse(
            "alcohol_quantity_not_fixed",
            `${thing.name}: ${item.name} contains alcohol, so the package must include a fixed quantity of it.`,
          );
        }
      }
      if (thing.hourly && !rules.hourlyAlcohol && items.some(({ item }) => item?.alcohol)) {
        refuse("hourly_includes_alcohol", `${thing.name}: an hourly price can't include alcohol.`);
      }
      if (thing.privateFunctionOnly && !rules.privateFunctionException) {
        refuse(
          "private_function_not_cleared",
          `${thing.name} relies on the private-function exception, which isn't cleared for this venue yet.`,
        );
      }
      break;
    }

    case "priceRule": {
      const qty = thing.target.qty ?? 1;
      const alcohol = thing.target.itemIds
        .map(lookup)
        .filter((i): i is PromoMenuItem => i?.alcohol === true);
      if (thing.hourly && !rules.hourlyAlcohol && alcohol.length > 0) {
        refuse("hourly_includes_alcohol", `${thing.name}: an hourly price can't include alcohol.`);
      }
      for (const item of alcohol) {
        const regular = item.regularCents * qty;
        // pctOff is a whole percentage; the discount rounds half up to the cent.
        const price =
          thing.priceCents ??
          (thing.pctOff === undefined
            ? regular
            : regular - percentOf(cents(regular), thing.pctOff, 100));
        if (price <= 0 && !rules.freeDrinks) {
          refuse("free_alcohol", `${thing.name}: ${item.name} contains alcohol and can't be free.`);
        } else if (price * 2 < regular) {
          const least = Math.ceil(regular / 2);
          refuse(
            "below_half_price",
            `${thing.name}: ${qty > 1 ? `${qty} × ${item.name}` : item.name} can't go below half the regular price (${dollars(regular)}); the lowest allowed is ${dollars(least)}.`,
          );
        }
      }
      break;
    }

    case "songOffer":
      if (thing.freeDrinkWithSong && !rules.freeDrinks)
        refuse(
          "free_drink_with_song",
          "Buy a song, get a drink: a free drink with a song is free alcohol, which this venue's rules don't allow until the lawyer answers.",
        );
      break;

    case "comp":
      lookup(thing.itemId);
      if (thing.reason.trim() === "") refuse("comp_needs_reason", "A comp needs a reason.");
      break;
  }
  return out;
}
