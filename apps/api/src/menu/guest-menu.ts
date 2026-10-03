import { menuTree, rulePackFor, statesOf, venueModules, type Queryable } from "@west4/db";
import { businessDate, displayPrice } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { alcoholNow } from "../orders/alcohol.js";
import { creditPricePct } from "../payments/surcharge.js";
import { livePromotions } from "./promotions.js";

/**
 * The guest menu (M3-03, M5-03): one list that the menu page, the room page
 * and the menu PDF all read, so a price changes in one place. Shown items in
 * sort order, with 86'd ones kept in their slot and marked; every price at its
 * displayed price; and the packages and happy hours the promotion checks pass,
 * with Packages & specials on.
 */
export async function guestMenu(c: Queryable, venueId: string, now: Temporal.Instant) {
  const tree = await menuTree(c, venueId, new Date(now.epochMilliseconds).toISOString(), {
    shownOnly: true,
  });
  // With a card surcharge on, every price shows the credit price (M4-25); with it off, nothing changes.
  const categories = withCreditPrices(tree, await creditPricePct(c, venueId, now));
  return {
    categories: categories
      .map((cat) => ({
        ...cat,
        items: cat.items.map(({ station: _s, shown: _h, ...item }) => item),
      }))
      .filter((cat) => cat.items.length > 0),
    alcohol: await alcoholNow(c, venueId, now),
    ...(await guestPromotions(c, venueId, now)),
  };
}
export type GuestMenu = Awaited<ReturnType<typeof guestMenu>>;

async function guestPromotions(c: Queryable, venueId: string, now: Temporal.Instant) {
  const states = statesOf(await venueModules(c, venueId));
  if (states["packages"] !== "on") return { packages: [], happy_hours: [] };
  const venue = (
    await c.query<{ time_zone: string; day_cutover: string; rule_pack_id: string | null }>(
      "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover, rule_pack_id from venues where id = $1",
      [venueId],
    )
  ).rows[0];
  if (!venue) return { packages: [], happy_hours: [] };
  const today = businessDate(now, venue.time_zone, venue.day_cutover).businessDate;
  const pack = await rulePackFor(c, venue.rule_pack_id ?? "us-ny-new-york-county", today);
  return livePromotions(c, venueId, today, pack?.pack ?? null);
}

/** Every price on a menu at its displayed price (M4-25): the credit price while a surcharge is on. */
export function withCreditPrices<T extends { items: readonly unknown[] }>(
  tree: readonly T[],
  pct: number | null,
): T[] {
  if (pct === null) return [...tree];
  return tree.map((cat) => ({
    ...cat,
    items: cat.items.map((raw) => {
      const item = raw as {
        variants: { price_cents: number }[];
        groups: { options: { price_delta_cents: number }[] }[];
      };
      return {
        ...item,
        variants: item.variants.map((v) => ({
          ...v,
          price_cents: displayPrice(v.price_cents, pct),
        })),
        groups: item.groups.map((g) => ({
          ...g,
          options: g.options.map((o) => ({
            ...o,
            price_delta_cents: displayPrice(o.price_delta_cents, pct),
          })),
        })),
      };
    }),
  }));
}
