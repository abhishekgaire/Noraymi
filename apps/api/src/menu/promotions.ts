import { promoMenu, type Queryable } from "@west4/db";
import { promotionChecks, type Promotable } from "@west4/rules";
import type { RulePack, Temporal } from "@west4/shared";

/**
 * Promotions a guest may see (M5-03; Settings · promotion checks, price_rules):
 * the shown packages and the price rules in date today, each run through the
 * rule pack's promotion checks again, so a promotion the checks now refuse
 * (a newer pack, a changed price) is hidden rather than advertised. The site
 * never advertises a price the POS doesn't charge.
 */
type Row = Record<string, unknown>;

/** What the checks are asked about a saved package or price rule. */
export function promotableOf(table: "packages" | "price_rules", row: Row): Promotable {
  if (table === "packages")
    return {
      kind: "package",
      name: String(row["name"]),
      priceCents: Number(row["price_cents"]),
      hourly: row["hourly"] === true,
      privateFunctionOnly: row["private_function_only"] === true,
      contents: (row["contents"] as { item_id: string; qty: number | null }[]).map((x) => ({
        itemId: x.item_id,
        qty: x.qty,
      })),
    };
  const target = row["target"] as { item_ids: string[]; qty?: number };
  return {
    kind: "priceRule",
    name: String(row["name"]),
    hourly: row["kind"] === "hourly",
    target: { itemIds: target.item_ids, ...(target.qty ? { qty: target.qty } : {}) },
    ...(row["price_cents"] != null ? { priceCents: Number(row["price_cents"]) } : {}),
    ...(row["pct_off"] != null ? { pctOff: Number(row["pct_off"]) } : {}),
  };
}

export interface HappyHour {
  readonly name: string;
  /** 0 Sunday … 6 Saturday. */
  readonly days: readonly number[];
  /** Minutes from midnight; past 1440 runs into the next morning. */
  readonly from_min: number | null;
  readonly to_min: number | null;
  readonly pct_off: number | null;
  readonly price_cents: number | null;
  readonly qty: number;
  readonly items: readonly string[];
}

export async function livePromotions(
  c: Queryable,
  venueId: string,
  today: Temporal.PlainDate,
  pack: Pick<RulePack, "alcohol"> | null,
): Promise<{
  packages: { name: string; price_cents: number; hourly: boolean }[];
  happy_hours: HappyHour[];
}> {
  // No usable rule pack: nothing can be checked, so nothing is advertised.
  if (!pack) return { packages: [], happy_hours: [] };
  const menu = await promoMenu(c, venueId);
  const passes = (thing: Promotable) => promotionChecks(thing, menu, pack).length === 0;
  const packages = (
    await c.query<Row>(
      `select name, price_cents, hourly, private_function_only, contents from packages
        where venue_id = $1 and shown and not private_function_only order by price_cents, name`,
      [venueId],
    )
  ).rows.filter((r) => passes(promotableOf("packages", r)));
  const rules = (
    await c.query<Row>(
      `select name, kind, days, from_min, to_min, target, pct_off, price_cents from price_rules
        where venue_id = $1 and shown and kind = 'happy_hour'
          and (starts_on is null or starts_on <= $2::date) and (ends_on is null or ends_on >= $2::date)
        order by from_min nulls first, name`,
      [venueId, today.toString()],
    )
  ).rows.filter((r) => passes(promotableOf("price_rules", r)));
  const names = Object.fromEntries(Object.entries(menu).map(([id, item]) => [id, item.name]));
  return {
    packages: packages.map((r) => ({
      name: String(r["name"]),
      price_cents: Number(r["price_cents"]),
      hourly: r["hourly"] === true,
    })),
    happy_hours: rules.map((r) => {
      const target = r["target"] as { item_ids: string[]; qty?: number };
      return {
        name: String(r["name"]),
        days: r["days"] as number[],
        from_min: (r["from_min"] as number | null) ?? null,
        to_min: (r["to_min"] as number | null) ?? null,
        pct_off: (r["pct_off"] as number | null) ?? null,
        price_cents: (r["price_cents"] as number | null) ?? null,
        qty: target.qty ?? 1,
        items: target.item_ids.flatMap((id) => (names[id] ? [names[id]] : [])),
      };
    }),
  };
}
