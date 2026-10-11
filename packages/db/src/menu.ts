import {
  businessDate,
  pastLastOrder,
  promotionChecks,
  type Promotable,
  type PromotionRefusal,
} from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { rulePackFor } from "./rule-packs.js";
import { readSetting } from "./settings.js";
import type { Queryable } from "./tenancy.js";

/**
 * The menu (M3-03; spec 04 · Menu, orders and songs). Rows are created and
 * patched through one whitelist per table, so a body can only touch the
 * columns a route allows. 86 is `out_until`: out while it's later than now.
 * Every function runs inside a venue transaction.
 */
export type MenuTable =
  | "menu_categories"
  | "menu_items"
  | "menu_variants"
  | "modifier_groups"
  | "menu_options"
  | "packages"
  | "price_rules";

const JSON_COLUMNS = new Set(["contents", "target"]);

/** What a read returns: dates as text, the rest as stored. */
const ROW = (table: MenuTable) =>
  table === "price_rules"
    ? "id, venue_id, name, kind, days, from_min, to_min, target, pct_off, price_cents, starts_on::text as starts_on, ends_on::text as ends_on, shown, checked_pack_version"
    : "*";

export class MenuRowMissing extends Error {
  constructor(
    readonly table: MenuTable,
    readonly id: string,
  ) {
    super(`no ${table} row ${id}`);
    this.name = "MenuRowMissing";
  }
}

const value = (col: string, v: unknown) => (JSON_COLUMNS.has(col) ? JSON.stringify(v) : v);

/** Insert one row; `values` keys are column names already checked by the route. */
export async function insertMenuRow(
  client: Queryable,
  table: MenuTable,
  venueId: string,
  values: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const cols = Object.keys(values);
  const r = await client.query<Record<string, unknown>>(
    `insert into ${table} (venue_id, ${cols.join(", ")})
     values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) returning ${ROW(table)}`,
    [venueId, ...cols.map((c) => value(c, values[c]))],
  );
  return r.rows[0]!;
}

/** Patch one row; an empty patch reads it back. Throws MenuRowMissing for another venue's id. */
export async function patchMenuRow(
  client: Queryable,
  table: MenuTable,
  venueId: string,
  id: string,
  values: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const cols = Object.keys(values);
  const r =
    cols.length === 0
      ? await client.query<Record<string, unknown>>(
          `select ${ROW(table)} from ${table} where venue_id = $1 and id = $2`,
          [venueId, id],
        )
      : await client.query<Record<string, unknown>>(
          `update ${table} set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")}, updated_at = now()
            where venue_id = $1 and id = $2 returning ${ROW(table)}`,
          [venueId, id, ...cols.map((c) => value(c, values[c]))],
        );
  if (!r.rows[0]) throw new MenuRowMissing(table, id);
  return r.rows[0];
}

export async function menuRow(
  client: Queryable,
  table: MenuTable,
  venueId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const r = await client.query<Record<string, unknown>>(
    `select ${ROW(table)} from ${table} where venue_id = $1 and id = $2`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** Every row of a table, optionally for one item, in sort order where the table has one. */
export async function listMenuRows(
  client: Queryable,
  table: MenuTable,
  venueId: string,
  itemId?: string,
): Promise<Record<string, unknown>[]> {
  const sorted = table === "packages" || table === "price_rules" ? "name" : "sort, name";
  const r = await client.query<Record<string, unknown>>(
    `select ${ROW(table)} from ${table} where venue_id = $1 ${itemId ? "and item_id = $2" : ""} order by ${sorted}, id`,
    itemId ? [venueId, itemId] : [venueId],
  );
  return r.rows;
}

/** A choice that is another menu item (K-12): a side or a soda, sold as its own line. */
export interface MenuComponent {
  readonly item_id: string;
  readonly variant_id: string;
  /** The item's name, with the size when it has more than one ("Fries", "Beer · Draft"). */
  readonly name: string;
  readonly station: string;
  readonly tax_category: string;
  readonly alcohol: boolean;
  /** Its regular price: the variant's. */
  readonly price_cents: number;
}
export interface MenuOption {
  readonly id: string;
  readonly name: string;
  readonly price_delta_cents: number;
  readonly is_default: boolean;
  readonly out_tonight: boolean;
  readonly component_variant_id: string | null;
  readonly component: MenuComponent | null;
}
export interface MenuGroup {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly min_choices: number;
  readonly max_choices: number;
  /** K-12: picks the price includes (null: not priced by the group), and each extra pick's price. */
  readonly included_choices: number | null;
  readonly extra_choice_cents: number;
  /** K-12: the sizes the group applies to (null: every size). */
  readonly variant_ids: string[] | null;
  /** K-12: the choice of this item that opens the group (null: always open). */
  readonly when_option_id: string | null;
  readonly options: MenuOption[];
}
export interface MenuVariant {
  readonly id: string;
  readonly name: string;
  readonly price_cents: number;
  readonly out_tonight: boolean;
}
export interface MenuItem {
  readonly id: string;
  readonly category_id: string;
  readonly name: string;
  readonly button_name: string | null;
  readonly description: string | null;
  readonly alcohol: boolean;
  readonly station: string;
  readonly shown: boolean;
  readonly out_tonight: boolean;
  /** Food only (K-07): why the kitchen isn't taking orders right now, or null. Drinks: null. */
  readonly kitchen_stop?: KitchenStop | null;
  readonly variants: MenuVariant[];
  readonly groups: MenuGroup[];
}
export interface MenuCategory {
  readonly id: string;
  readonly name: string;
  readonly sort: number;
  readonly tax_category: string;
  readonly items: MenuItem[];
}

/** Why food can't be ordered now: a manager closed the kitchen, or the last order time passed. */
export type KitchenStop = "kitchen_closed" | "last_order";

/**
 * Whether the kitchen is taking orders at `now` (K-07; spec 16 · 86 and closing the kitchen):
 * "kitchen_closed" while a manager's Close the kitchen stands, "last_order" once tonight's
 * `kitchen.lastOrder` has passed (empty: no limit), else null. Alcohol rules are separate.
 */
export async function kitchenStop(
  client: Queryable,
  venueId: string,
  now: string,
): Promise<KitchenStop | null> {
  const v = await client.query<{ closed: boolean; time_zone: string; day_cutover: string }>(
    `select coalesce(kitchen_closed_until > $2::timestamptz, false) as closed, time_zone,
            to_char(day_cutover, 'HH24:MI') as day_cutover
       from venues where id = $1`,
    [venueId, now],
  );
  const venue = v.rows[0];
  if (!venue) return null;
  if (venue.closed) return "kitchen_closed";
  const date = businessDate(now, venue.time_zone, venue.day_cutover).businessDate;
  const setting = await readSetting(client, venueId, "kitchen", date);
  return pastLastOrder(now, setting?.value.lastOrder ?? null, venue.time_zone, venue.day_cutover)
    ? "last_order"
    : null;
}

/**
 * The whole menu as one tree, in sort order, with each item, variant and
 * choice's 86 worked out at `now`. `shownOnly` leaves out hidden items (the
 * guest menu); an 86'd item stays, greyed in its slot.
 */
export async function menuTree(
  client: Queryable,
  venueId: string,
  now: string,
  options: {
    shownOnly?: boolean;
    /** Admin → Menu keeps kitchen items while Kitchen & food is off, so a manager can still edit them. */
    includeKitchen?: boolean;
  } = {},
): Promise<MenuCategory[]> {
  const out = (col: string) => `coalesce(${col} > $2::timestamptz, false) as out_tonight`;
  // With Kitchen & food off, food is hidden from every menu (spec 16 · What it hides; K-02).
  const kitchenOff =
    options.includeKitchen !== true &&
    ((
      await client.query<{ state: string }>(
        "select state from venue_modules where venue_id = $1 and module_id = 'kitchen'",
        [venueId],
      )
    ).rows[0]?.state ?? "off") === "off";
  const [cats, items, variants, groups, opts] = await Promise.all([
    client.query<Omit<MenuCategory, "items">>(
      "select id, name, sort, tax_category from menu_categories where venue_id = $1 order by sort, name, id",
      [venueId],
    ),
    client.query<Omit<MenuItem, "variants" | "groups">>(
      `select id, category_id, name, button_name, description, alcohol, station, shown, ${out("out_until")}
         from menu_items where venue_id = $1 ${options.shownOnly ? "and shown" : ""}
           ${kitchenOff ? "and station <> 'kitchen'" : ""} order by sort, name, id`,
      [venueId, now],
    ),
    client.query<MenuVariant & { item_id: string }>(
      `select id, item_id, name, price_cents, ${out("out_until")}
         from menu_variants where venue_id = $1 order by sort, name, id`,
      [venueId, now],
    ),
    client.query<Omit<MenuGroup, "options"> & { item_id: string }>(
      `select id, item_id, name, required, min_choices, max_choices, included_choices, extra_choice_cents, variant_ids, when_option_id
         from modifier_groups where venue_id = $1 order by sort, name, id`,
      [venueId],
    ),
    client.query<Omit<MenuOption, "component"> & { group_id: string }>(
      `select id, group_id, name, price_delta_cents, is_default, component_variant_id, ${out("out_until")}
         from menu_options where venue_id = $1 order by sort, name, id`,
      [venueId, now],
    ),
  ]);
  const byKey = <T, K extends keyof T>(rows: T[], key: K) => {
    const m = new Map<unknown, T[]>();
    for (const row of rows) m.set(row[key], [...(m.get(row[key]) ?? []), row]);
    return m;
  };
  const components = await menuComponents(client, venueId, now);
  const optsByGroup = byKey(opts.rows, "group_id");
  const groupsByItem = byKey(groups.rows, "item_id");
  const variantsByItem = byKey(variants.rows, "item_id");
  const itemsByCat = byKey(items.rows, "category_id");
  // A food category is left out with its food, rather than shown empty.
  const hidden = kitchenOff
    ? new Set(
        (
          await client.query<{ category_id: string }>(
            `select distinct category_id from menu_items where venue_id = $1 and station = 'kitchen'
              except select distinct category_id from menu_items where venue_id = $1 and station <> 'kitchen'`,
            [venueId],
          )
        ).rows.map((r) => r.category_id),
      )
    : new Set<string>();
  // A closed kitchen or a passed last order greys every food item (K-07); Admin → Menu shows the
  // items' own 86 only, so a manager edits what's really set.
  const stop =
    kitchenOff || options.includeKitchen === true ? null : await kitchenStop(client, venueId, now);
  return cats.rows
    .filter((cat) => !hidden.has(cat.id))
    .map((cat) => ({
      ...cat,
      items: (itemsByCat.get(cat.id) ?? []).map((item) => ({
        ...item,
        ...(item.station === "kitchen"
          ? { out_tonight: item.out_tonight || stop !== null, kitchen_stop: stop }
          : {}),
        variants: (variantsByItem.get(item.id) ?? []).map(({ item_id: _, ...v }) => v),
        groups: (groupsByItem.get(item.id) ?? []).map(({ item_id: _, ...g }) => ({
          ...g,
          options: (optsByGroup.get(g.id) ?? []).map(({ group_id: __, ...o }) => {
            const part = o.component_variant_id
              ? components.get(o.component_variant_id)
              : undefined;
            // A component that's 86'd (or its kitchen stopped or off) greys the choice out too.
            const partOut =
              (part?.out_tonight ?? false) || (kitchenOff && part?.station === "kitchen");
            return {
              ...o,
              out_tonight: o.out_tonight || partOut,
              component: part ? withoutOut(part) : null,
            };
          }),
        })),
      })),
    }));
}

const withoutOut = ({ out_tonight: _, ...c }: MenuComponent & { out_tonight: boolean }) => c;

/**
 * Every variant a choice names as its component (K-12), with what its line copies and whether
 * it's out at `now`: 86'd, or food while the kitchen is stopped (K-07).
 */
async function menuComponents(
  client: Queryable,
  venueId: string,
  now: string,
): Promise<Map<string, MenuComponent & { out_tonight: boolean }>> {
  const r = await client.query<MenuComponent & { out_tonight: boolean }>(
    `select v.id as variant_id, i.id as item_id,
            case when (select count(*) from menu_variants x where x.venue_id = v.venue_id and x.item_id = v.item_id) > 1
                 then i.name || ' · ' || v.name else i.name end as name,
            i.station, c.tax_category, i.alcohol, v.price_cents,
            (coalesce(i.out_until > $2::timestamptz, false) or coalesce(v.out_until > $2::timestamptz, false)) as out_tonight
       from menu_variants v
       join menu_items i on i.venue_id = v.venue_id and i.id = v.item_id
       join menu_categories c on c.venue_id = i.venue_id and c.id = i.category_id
      where v.venue_id = $1
        and v.id in (select component_variant_id from menu_options where venue_id = $1 and component_variant_id is not null)`,
    [venueId, now],
  );
  const stop = r.rows.some((x) => x.station === "kitchen")
    ? await kitchenStop(client, venueId, now)
    : null;
  return new Map(
    r.rows.map((x) => [
      x.variant_id,
      { ...x, out_tonight: x.out_tonight || (x.station === "kitchen" && stop !== null) },
    ]),
  );
}

/** What the promotion checks need: each item's name, alcohol flag and regular price (its first variant). */
export async function promoMenu(
  client: Queryable,
  venueId: string,
): Promise<
  Record<string, { name: string; alcohol: boolean; regularCents: number; food: boolean }>
> {
  const r = await client.query<{
    id: string;
    name: string;
    alcohol: boolean;
    food: boolean;
    price: number | null;
  }>(
    `select i.id, i.name, i.alcohol, i.station = 'kitchen' as food,
            (select v.price_cents from menu_variants v where v.venue_id = i.venue_id and v.item_id = i.id
              order by v.sort, v.name, v.id limit 1) as price
       from menu_items i where i.venue_id = $1`,
    [venueId],
  );
  return Object.fromEntries(
    r.rows.map((row) => [
      row.id,
      { name: row.name, alcohol: row.alcohol, regularCents: row.price ?? 0, food: row.food },
    ]),
  );
}

/**
 * 86 an item, one of its variants or one of its choices, or bring it back
 * (`outUntil` null). Returns false when the row isn't this venue's item's.
 */
export async function setOutTonight(
  client: Queryable,
  venueId: string,
  args: {
    itemId: string;
    variantId?: string | undefined;
    optionId?: string | undefined;
    outUntil: string | null;
  },
): Promise<boolean> {
  const [table, id] = args.variantId
    ? (["menu_variants", args.variantId] as const)
    : args.optionId
      ? (["menu_options", args.optionId] as const)
      : (["menu_items", args.itemId] as const);
  const r = await client.query(
    `update ${table} set out_until = $3, updated_at = now()
      where venue_id = $1 and id = $2 ${table === "menu_items" ? "" : "and item_id = $4"}`,
    table === "menu_items"
      ? [venueId, id, args.outUntil]
      : [venueId, id, args.outUntil, args.itemId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Queue the menu PDF (M3-05) unless one is already waiting to run: a burst of
 * saves renders once, from the menu as it stands when the job runs.
 */
export async function queueMenuPdf(
  client: Queryable,
  venueId: string,
  runAt: string,
): Promise<boolean> {
  const r = await client.query(
    `insert into jobs (venue_id, kind, pool, payload, run_at, max_attempts)
     select $1, 'menu.pdf', 'bulk', '{}', $2, 5
      where not exists (select 1 from jobs where venue_id = $1 and kind = 'menu.pdf' and status = 'queued')`,
    [venueId, runAt],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The current menu PDF: the newest `menu_pdf` file not replaced. */
export async function currentMenuPdf(
  client: Queryable,
  venueId: string,
): Promise<{ id: string; uploaded_at: string } | null> {
  const r = await client.query<{ id: string; uploaded_at: string }>(
    `select id, uploaded_at::text from files
      where venue_id = $1 and kind = 'menu_pdf' and removed_at is null
      order by uploaded_at desc limit 1`,
    [venueId],
  );
  return r.rows[0] ?? null;
}

/** A variant as an order needs it: its item, the item's category tax, and every choice group with its options. */
export interface OrderableVariant {
  readonly variant_id: string;
  readonly variant_name: string;
  readonly variant_count: number;
  readonly price_cents: number;
  readonly item_id: string;
  readonly item_name: string;
  readonly alcohol: boolean;
  readonly station: string;
  readonly shown: boolean;
  readonly tax_category: string;
  readonly out_tonight: boolean;
  /** Food only (K-07): the kitchen isn't taking orders now, and why. Drinks: null. */
  readonly kitchen_stop: KitchenStop | null;
  /** Every choice group of the item, those for other sizes included (the order checks them). */
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly required: boolean;
    readonly min_choices: number;
    readonly max_choices: number;
    readonly included_choices: number | null;
    readonly extra_choice_cents: number;
    readonly variant_ids: readonly string[] | null;
    readonly when_option_id: string | null;
    readonly options: readonly {
      readonly id: string;
      readonly name: string;
      readonly price_delta_cents: number;
      readonly out_tonight: boolean;
      readonly component: MenuComponent | null;
    }[];
  }[];
}

export async function orderableVariant(
  client: Queryable,
  venueId: string,
  variantId: string,
  now: string,
): Promise<OrderableVariant | null> {
  const r = await client.query<Omit<OrderableVariant, "groups" | "kitchen_stop">>(
    `select v.id as variant_id, v.name as variant_name, v.price_cents,
            (select count(*)::int from menu_variants x where x.venue_id = v.venue_id and x.item_id = v.item_id) as variant_count,
            i.id as item_id, i.name as item_name, i.alcohol, i.station, i.shown, c.tax_category,
            (coalesce(i.out_until > $3::timestamptz, false) or coalesce(v.out_until > $3::timestamptz, false)) as out_tonight
       from menu_variants v
       join menu_items i on i.venue_id = v.venue_id and i.id = v.item_id
       join menu_categories c on c.venue_id = i.venue_id and c.id = i.category_id
      where v.venue_id = $1 and v.id = $2`,
    [venueId, variantId, now],
  );
  const row = r.rows[0];
  if (!row) return null;
  const groups = await client.query<Omit<OrderableVariant["groups"][number], "options">>(
    `select id, name, required, min_choices, max_choices, included_choices, extra_choice_cents,
            variant_ids, when_option_id
       from modifier_groups where venue_id = $1 and item_id = $2 order by sort, name, id`,
    [venueId, row.item_id],
  );
  const options = await client.query<{
    id: string;
    group_id: string;
    name: string;
    price_delta_cents: number;
    out_tonight: boolean;
    component_variant_id: string | null;
  }>(
    `select id, group_id, name, price_delta_cents, component_variant_id,
            coalesce(out_until > $3::timestamptz, false) as out_tonight
       from menu_options where venue_id = $1 and item_id = $2 order by sort, name, id`,
    [venueId, row.item_id, now],
  );
  const components = options.rows.some((o) => o.component_variant_id)
    ? await menuComponents(client, venueId, now)
    : new Map<string, MenuComponent & { out_tonight: boolean }>();
  return {
    ...row,
    kitchen_stop: row.station === "kitchen" ? await kitchenStop(client, venueId, now) : null,
    groups: groups.rows.map((g) => ({
      ...g,
      options: options.rows
        .filter((o) => o.group_id === g.id)
        .map(({ group_id: _, component_variant_id: part, ...o }) => {
          const c = part ? components.get(part) : undefined;
          return {
            ...o,
            out_tonight: o.out_tonight || (c?.out_tonight ?? false),
            component: c ? withoutOut(c) : null,
          };
        }),
    })),
  };
}

/**
 * The save path's promotion checks (M3-02/M3-03; Settings · Promotion
 * checks): the things a save touches, run against the venue's rule pack in
 * force today and the menu as saved. Admin → Menu and the menu import (M9-04)
 * both call it; any refusal means the save must not stand. Throws when the
 * venue has no usable rule pack.
 */
export async function menuPromotionRefusals(
  client: Queryable,
  venueId: string,
  things: readonly Promotable[],
  today: Temporal.PlainDate,
): Promise<{ refusals: PromotionRefusal[]; packVersion: string | null }> {
  if (things.length === 0) return { refusals: [], packVersion: null };
  const venue = await client.query<{ rule_pack_id: string | null }>(
    "select rule_pack_id from venues where id = $1",
    [venueId],
  );
  const packId = venue.rows[0]?.rule_pack_id ?? "us-ny-new-york-county";
  const pack = await rulePackFor(client, packId, today);
  if (!pack) throw new Error(`no usable rule pack ${packId} for ${today.toString()}`);
  const menu = await promoMenu(client, venueId);
  return {
    refusals: things.flatMap((t) => promotionChecks(t, menu, pack.pack)),
    packVersion: pack.pack.version,
  };
}
