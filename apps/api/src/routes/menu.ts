import type pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  emitEvent,
  insertMenuRow,
  listMenuRows,
  menuRow,
  menuTree,
  MenuRowMissing,
  patchMenuRow,
  promoMenu,
  resolveVenueSlug,
  rulePackFor,
  setOutTonight,
  withVenue,
  type MenuTable,
  type Queryable,
} from "@west4/db";
import { businessDate, promotionChecks, wallClock, type Promotable } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * The menu (M3-03; spec 08 · Menu):
 *   GET, POST    /v1/venues/{v}/menu/categories | items | variants | options | modifier-groups
 *   PATCH        /v1/venues/{v}/menu/<kind>/{id}
 *   GET          /v1/venues/{v}/menu                      the whole menu as one tree, with 86 worked out
 *   GET, POST    /v1/venues/{v}/packages | price-rules    (Packages & specials module)
 *   PATCH        /v1/venues/{v}/packages/{id} | price-rules/{id}
 *   POST         /v1/venues/{v}/menu/items/{i}/out-tonight   { out?, variant_id?, option_id? }: 86, or back
 *   GET          /v1/public/venues/{slug}/menu            the guest menu: shown items, 86'd ones greyed in place
 * Every save runs the rule pack's promotion checks and refuses with the reasons
 * (nothing is saved), then sends menu.changed. GET /menu isn't in the API table;
 * the staff screens read the tree from it rather than stitching seven lists (flagged).
 */
const id = z.string().uuid();
const money = z.number().int().min(0).max(10_000_000);
const sort = z.number().int().min(-100_000).max(100_000);

const BODIES = {
  menu_categories: z
    .object({
      name: z.string().trim().min(1).max(80),
      sort: sort.optional(),
      tax_category: z.string().trim().min(1).max(40).optional(),
    })
    .strict(),
  menu_items: z
    .object({
      category_id: id,
      name: z.string().trim().min(1).max(120),
      button_name: z.string().trim().min(1).max(24).nullable().optional(),
      description: z.string().trim().max(500).nullable().optional(),
      alcohol: z.boolean().optional(),
      station: z.string().trim().min(1).max(40).optional(),
      shown: z.boolean().optional(),
      sort: sort.optional(),
    })
    .strict(),
  menu_variants: z
    .object({
      item_id: id,
      name: z.string().trim().min(1).max(80),
      price_cents: money,
      sort: sort.optional(),
    })
    .strict(),
  modifier_groups: z
    .object({
      item_id: id,
      name: z.string().trim().min(1).max(80),
      required: z.boolean().optional(),
      min_choices: z.number().int().min(0).max(20).optional(),
      max_choices: z.number().int().min(1).max(20).optional(),
      sort: sort.optional(),
    })
    .strict(),
  menu_options: z
    .object({
      group_id: id,
      name: z.string().trim().min(1).max(80),
      price_delta_cents: money.optional(),
      is_default: z.boolean().optional(),
      sort: sort.optional(),
    })
    .strict(),
  packages: z
    .object({
      name: z.string().trim().min(1).max(120),
      price_cents: money,
      hourly: z.boolean().optional(),
      contents: z
        .array(
          z.object({ item_id: id, qty: z.number().int().min(1).max(1000).nullable() }).strict(),
        )
        .max(100),
      private_function_only: z.boolean().optional(),
      shown: z.boolean().optional(),
    })
    .strict(),
  price_rules: z
    .object({
      name: z.string().trim().min(1).max(120),
      kind: z.enum(["happy_hour", "special", "hourly"]),
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
      from_min: z.number().int().min(0).max(1799).nullable().optional(),
      to_min: z.number().int().min(1).max(1800).nullable().optional(),
      target: z
        .object({
          item_ids: z.array(id).min(1).max(200),
          qty: z.number().int().min(1).max(20).optional(),
        })
        .strict(),
      pct_off: z.number().int().min(1).max(100).nullable().optional(),
      price_cents: money.nullable().optional(),
      starts_on: z.iso.date().nullable().optional(),
      ends_on: z.iso.date().nullable().optional(),
      shown: z.boolean().optional(),
    })
    .strict(),
} satisfies Record<MenuTable, z.ZodObject>;

/** The URL each table lives at, and the module that gates it. */
const PATHS: readonly { table: MenuTable; path: string; module: string; byItem: boolean }[] = [
  { table: "menu_categories", path: "menu/categories", module: "core", byItem: false },
  { table: "menu_items", path: "menu/items", module: "core", byItem: false },
  { table: "menu_variants", path: "menu/variants", module: "core", byItem: true },
  { table: "menu_options", path: "menu/options", module: "core", byItem: true },
  { table: "modifier_groups", path: "menu/modifier-groups", module: "core", byItem: true },
  { table: "packages", path: "packages", module: "packages", byItem: false },
  { table: "price_rules", path: "price-rules", module: "packages", byItem: false },
];

const bad = (error: z.ZodError) =>
  new ApiError(
    "invalid_request",
    error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  );

/** A row as the API shows it: no venue id or timestamps, 86 as out_tonight. */
function present(row: Record<string, unknown>, now: string): Record<string, unknown> {
  const rest = { ...row };
  for (const key of ["venue_id", "created_at", "updated_at", "out_until"]) delete rest[key];
  const out = row["out_until"];
  return "out_until" in row
    ? { ...rest, out_tonight: out instanceof Date && out.toISOString() > now }
    : rest;
}

export function menuRoutes(app: FastifyInstance, options: { clock: Clock; pool: pg.Pool }): void {
  const read = (module: string) =>
    route({ principals: ["owner_manager", "staff", "shared_device"], module });
  const write = (module: string) =>
    route({
      principals: ["owner_manager"],
      module,
      action: "admin.access",
      idempotency: "optional",
    });

  const venueOf = async (c: Queryable, venueId: string) => {
    const r = await c.query<{
      time_zone: string;
      day_cutover: string;
      rule_pack_id: string | null;
    }>(
      "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover, rule_pack_id from venues where id = $1",
      [venueId],
    );
    if (!r.rows[0]) throw new ApiError("not_found", "no such venue");
    return r.rows[0];
  };
  const nowIso = () => new Date(options.clock.now().epochMilliseconds).toISOString();

  /** Runs the promotion checks on the saved state; a refusal throws, which rolls the save back. */
  const check = async (c: Queryable, venueId: string, things: Promotable[]) => {
    if (things.length === 0) return null;
    const venue = await venueOf(c, venueId);
    const today = businessDate(
      options.clock.now(),
      venue.time_zone,
      venue.day_cutover,
    ).businessDate;
    const packId = venue.rule_pack_id ?? "us-ny-new-york-county";
    const pack = await rulePackFor(c, packId, today);
    if (!pack)
      throw new ApiError("internal", `no usable rule pack ${packId} for ${today.toString()}`);
    const menu = await promoMenu(c, venueId);
    const refusals = things.flatMap((t) => promotionChecks(t, menu, pack.pack));
    if (refusals.length > 0)
      throw new ApiError("invalid_request", refusals.map((r) => r.message).join(" "), {
        details: { refusals },
      });
    return pack.pack.version;
  };

  /** The things a saved row asks the checks about. */
  const thingsFor = async (
    c: Queryable,
    venueId: string,
    table: MenuTable,
    row: Record<string, unknown>,
  ): Promise<Promotable[]> => {
    const itemThing = async (itemId: string): Promise<Promotable[]> => {
      const item = await menuRow(c, "menu_items", venueId, itemId);
      if (!item) return [];
      const variants = await listMenuRows(c, "menu_variants", venueId, itemId);
      return [
        {
          kind: "menuItem",
          name: String(item["name"]),
          alcohol: item["alcohol"] === true,
          priceCents: variants.map((v) => Number(v["price_cents"])),
        },
      ];
    };
    switch (table) {
      case "menu_items":
        return itemThing(String(row["id"]));
      case "menu_variants":
        return itemThing(String(row["item_id"]));
      case "packages":
        return [
          {
            kind: "package",
            name: String(row["name"]),
            priceCents: Number(row["price_cents"]),
            hourly: row["hourly"] === true,
            privateFunctionOnly: row["private_function_only"] === true,
            contents: (row["contents"] as { item_id: string; qty: number | null }[]).map((x) => ({
              itemId: x.item_id,
              qty: x.qty,
            })),
          },
        ];
      case "price_rules": {
        const target = row["target"] as { item_ids: string[]; qty?: number };
        return [
          {
            kind: "priceRule",
            name: String(row["name"]),
            hourly: row["kind"] === "hourly",
            target: { itemIds: target.item_ids, ...(target.qty ? { qty: target.qty } : {}) },
            ...(row["price_cents"] != null ? { priceCents: Number(row["price_cents"]) } : {}),
            ...(row["pct_off"] != null ? { pctOff: Number(row["pct_off"]) } : {}),
          },
        ];
      }
      default:
        return [];
    }
  };

  /** Checks a body's references belong to this venue, and fills in what the table needs. */
  const resolve = async (
    c: Queryable,
    venueId: string,
    table: MenuTable,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const must = async (t: MenuTable, refId: unknown, what: string) => {
      const row = await menuRow(c, t, venueId, String(refId));
      if (!row) throw new ApiError("invalid_request", `no such ${what}`);
      return row;
    };
    if (body["category_id"] !== undefined)
      await must("menu_categories", body["category_id"], "category");
    if (body["item_id"] !== undefined) await must("menu_items", body["item_id"], "item");
    if (body["group_id"] !== undefined) {
      const group = await must("modifier_groups", body["group_id"], "choice group");
      return { ...body, item_id: group["item_id"] };
    }
    if (table === "price_rules" && body["pct_off"] != null && body["price_cents"] != null)
      throw new ApiError("invalid_request", "give pct_off or price_cents, not both");
    return body;
  };

  const save = async (
    request: FastifyRequest,
    table: MenuTable,
    body: Record<string, unknown>,
    rowId: string | null,
  ) =>
    request.inVenue(async (c) => {
      const venueId = request.venueId!;
      const values = await resolve(c, venueId, table, body);
      let row: Record<string, unknown>;
      try {
        row =
          rowId === null
            ? await insertMenuRow(c, table, venueId, {
                ...values,
                ...(table === "packages" || table === "price_rules"
                  ? { checked_pack_version: "unchecked" }
                  : {}),
              })
            : await patchMenuRow(c, table, venueId, rowId, values);
      } catch (error) {
        if (error instanceof MenuRowMissing) throw new ApiError("not_found", "no such menu row");
        if (error instanceof Error && "code" in error && error.code === "23514")
          throw new ApiError("invalid_request", "that combination isn't allowed");
        throw error;
      }
      if (table === "price_rules" && (row["pct_off"] == null) === (row["price_cents"] == null))
        throw new ApiError("invalid_request", "a price rule needs pct_off or price_cents");
      const version = await check(c, venueId, await thingsFor(c, venueId, table, row));
      if (version !== null && (table === "packages" || table === "price_rules"))
        row = await patchMenuRow(c, table, venueId, String(row["id"]), {
          checked_pack_version: version,
        });
      await emitEvent(c, { venueId, type: "menu.changed", entityId: String(row["id"]) });
      return present(row, nowIso());
    });

  for (const { table, path, module, byItem } of PATHS) {
    app.get<{ Params: { venueId: string }; Querystring: { item_id?: string } }>(
      `/v1/venues/:venueId/${path}`,
      { config: read(module) },
      async (request) => {
        const itemId = byItem ? request.query.item_id : undefined;
        if (itemId !== undefined && !id.safeParse(itemId).success)
          throw new ApiError("invalid_request", "item_id must be an id");
        const rows = await request.inVenue((c) => listMenuRows(c, table, request.venueId!, itemId));
        const now = nowIso();
        return { items: rows.map((r) => present(r, now)), next_cursor: null };
      },
    );

    app.post<{ Params: { venueId: string }; Body: unknown }>(
      `/v1/venues/:venueId/${path}`,
      { config: write(module) },
      async (request, reply) => {
        const parsed = BODIES[table].safeParse(request.body);
        if (!parsed.success) throw bad(parsed.error);
        return reply.code(201).send(await save(request, table, parsed.data, null));
      },
    );

    app.patch<{ Params: { venueId: string; menuRowId: string }; Body: unknown }>(
      `/v1/venues/:venueId/${path}/:menuRowId`,
      { config: write(module) },
      async (request) => {
        if (!id.safeParse(request.params.menuRowId).success)
          throw new ApiError("not_found", "no such menu row");
        const schema = BODIES[table].partial();
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) throw bad(parsed.error);
        return save(request, table, parsed.data, request.params.menuRowId);
      },
    );
  }

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/menu",
    { config: read("core") },
    async (request) => ({
      categories: await request.inVenue((c) => menuTree(c, request.venueId!, nowIso())),
    }),
  );

  const outBody = z
    .object({
      out: z.boolean().optional(),
      variant_id: id.optional(),
      option_id: id.optional(),
    })
    .strict()
    .refine((b) => !(b.variant_id && b.option_id), "86 an item, a variant or a choice, not two");

  app.post<{ Params: { venueId: string; menuItemId: string }; Body: unknown }>(
    "/v1/venues/:venueId/menu/items/:menuItemId/out-tonight",
    {
      config: route({
        principals: ["owner_manager", "staff", "shared_device"],
        module: "core",
        action: "orders.accept",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const parsed = outBody.safeParse(request.body ?? {});
      if (!parsed.success) throw bad(parsed.error);
      if (!id.safeParse(request.params.menuItemId).success)
        throw new ApiError("not_found", "no such item");
      const out = parsed.data.out ?? true;
      return request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const venue = await venueOf(c, venueId);
        // Out until the end of the business date: the next cutover. The night close (M7) clears it sooner.
        const bd = businessDate(
          options.clock.now(),
          venue.time_zone,
          venue.day_cutover,
        ).businessDate;
        const until = wallClock(
          bd.add({ days: 1 }),
          venue.day_cutover,
          venue.time_zone,
          venue.day_cutover,
        );
        const changed = await setOutTonight(c, venueId, {
          itemId: request.params.menuItemId,
          variantId: parsed.data.variant_id,
          optionId: parsed.data.option_id,
          outUntil: out ? until.toString() : null,
        });
        if (!changed) throw new ApiError("not_found", "no such item");
        await emitEvent(c, {
          venueId,
          type: "menu.changed",
          entityId: request.params.menuItemId,
        });
        return {
          item_id: request.params.menuItemId,
          variant_id: parsed.data.variant_id ?? null,
          option_id: parsed.data.option_id ?? null,
          out_tonight: out,
          out_until: out ? until.toString() : null,
        };
      });
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/v1/public/venues/:slug/menu",
    { config: route({ principals: ["public"], module: "core", idempotency: "none" }) },
    async (request, reply) => {
      const venueId = await resolveVenueSlug(options.pool, request.params.slug);
      if (!venueId) throw new ApiError("not_found", "no such venue");
      const categories = await withVenue(
        options.pool,
        { venueId, requestId: request.requestId },
        (c) => menuTree(c, venueId, nowIso(), { shownOnly: true }),
      );
      reply.header("Cache-Control", "no-store");
      return {
        categories: categories
          .map((cat) => ({
            ...cat,
            items: cat.items.map(({ station: _s, shown: _h, ...item }) => item),
          }))
          .filter((cat) => cat.items.length > 0),
      };
    },
  );
}
