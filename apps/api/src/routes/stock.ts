import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { moveStock, readSetting, type Queryable, type StockMoveKind } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Inventory (P-16; spec 04 · Inventory; module `inventory`, off by default, which answers 404
 * module_off when it's off). Owners and managers, from Reports → Stock:
 *   GET  /v1/venues/{v}/stock                          what's counted: on hand, the low level, 86'd or not
 *   PUT  /v1/venues/{v}/stock/{menuItemId}             { variant_id?, counting, low_at? } start or stop
 *                                                      counting an item (or one variant), set its low level
 *   POST /v1/venues/{v}/stock/{menuItemId}/receive     { variant_id?, qty }       a delivery comes in
 *   POST /v1/venues/{v}/stock/{menuItemId}/count       { variant_id?, on_hand }   what's on the shelf now
 *   POST /v1/venues/{v}/stock/{menuItemId}/adjust      { variant_id?, delta, reason } breakage, spills, a fix
 *   GET  /v1/venues/{v}/stock/report?from=&to=         per level: on hand, used, received and adjusted
 *                                                      by business date; 93 days at most
 * Sales and voids move the counts on their own (packages/db stock.ts). Every change is a
 * `stock_moves` row and both tables are audited.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 93;
const uuid = z.string().uuid();

interface LevelRow {
  id: string;
  item_id: string;
  variant_id: string | null;
  item: string;
  variant: string | null;
  on_hand: number;
  low_at: number | null;
  active: boolean;
  auto_out: boolean;
  out: boolean;
}

const LEVELS = `select s.id, s.item_id, s.variant_id, i.name as item, v.name as variant, s.on_hand, s.low_at,
                       s.active, s.auto_out,
                       (coalesce(i.out_until > $2::timestamptz, false)
                        or coalesce(v.out_until > $2::timestamptz, false)) as out
                  from stock_levels s
                  join menu_items i on i.venue_id = s.venue_id and i.id = s.item_id
                  left join menu_variants v on v.venue_id = s.venue_id and v.id = s.variant_id
                 where s.venue_id = $1`;

const view = (r: LevelRow) => ({
  id: r.id,
  item_id: r.item_id,
  variant_id: r.variant_id,
  item: r.item,
  variant: r.variant,
  on_hand: r.on_hand,
  low_at: r.low_at,
  low: r.low_at !== null && r.on_hand <= r.low_at,
  counting: r.active,
  out_tonight: r.out,
  auto_out: r.auto_out,
});

export function stockRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({
    principals: ["owner_manager"],
    module: "inventory",
    action: "reports.view",
  });
  const write = route({
    principals: ["owner_manager"],
    module: "inventory",
    action: "reports.view",
    idempotency: "optional",
  });
  const userOf = (request: FastifyRequest) => {
    const p = request.principal;
    if (p.kind !== "user") throw new ApiError("forbidden", "stock is a person's work");
    return p.userId;
  };
  const nowIso = () => options.clock.now().toString();

  /** The item (and variant) in this venue, or 404. */
  const target = async (
    c: Queryable,
    venueId: string,
    itemId: string,
    variantId?: string | null,
  ) => {
    if (!uuid.safeParse(itemId).success) throw new ApiError("not_found", "no such item");
    const item = await c.query("select 1 from menu_items where venue_id = $1 and id = $2", [
      venueId,
      itemId,
    ]);
    if (!item.rowCount) throw new ApiError("not_found", "no such item");
    if (variantId) {
      const v = await c.query(
        "select 1 from menu_variants where venue_id = $1 and id = $2 and item_id = $3",
        [venueId, variantId, itemId],
      );
      if (!v.rowCount) throw new ApiError("not_found", "no such variant on this item");
    }
  };
  const levelOf = async (
    c: Queryable,
    venueId: string,
    itemId: string,
    variantId: string | null,
  ): Promise<LevelRow | null> => {
    const r = await c.query<LevelRow>(
      `${LEVELS} and s.item_id = $3 and s.variant_id is not distinct from $4::uuid`,
      [venueId, nowIso(), itemId, variantId],
    );
    return r.rows[0] ?? null;
  };

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/stock",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const rows = await c.query<LevelRow>(`${LEVELS} order by i.name, v.sort, v.name`, [
          venueId,
          nowIso(),
        ]);
        const v = await venueClock(c, venueId);
        const bd = businessDate(options.clock.now(), v.timeZone, v.dayCutover).businessDate;
        const s = await readSetting(c, venueId, "inventory", bd);
        return {
          business_date: bd.toString(),
          auto_eighty_six: s?.value.autoEightySix ?? true,
          levels: rows.rows.map(view),
        };
      }),
  );

  const putBody = z
    .object({
      variant_id: uuid.nullable().optional(),
      counting: z.boolean(),
      low_at: z.number().int().min(0).max(100000).nullable().optional(),
    })
    .strict();
  app.put<{ Params: { venueId: string; menuItemId: string }; Body: unknown }>(
    "/v1/venues/:venueId/stock/:menuItemId",
    { config: write },
    async (request) => {
      const parsed = putBody.safeParse(request.body ?? {});
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { counting, variant_id?, low_at? }");
      userOf(request);
      const b = parsed.data;
      return request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const itemId = request.params.menuItemId;
        const variantId = b.variant_id ?? null;
        await target(c, venueId, itemId, variantId);
        const had = await levelOf(c, venueId, itemId, variantId);
        if (!had) {
          if (!b.counting) throw new ApiError("not_found", "this item isn't counted");
          await c.query(
            `insert into stock_levels (venue_id, item_id, variant_id, low_at) values ($1, $2, $3, $4)`,
            [venueId, itemId, variantId, b.low_at ?? null],
          );
        } else
          await c.query(
            `update stock_levels set active = $3, low_at = case when $5 then $4 else low_at end,
                    updated_at = now() where venue_id = $1 and id = $2`,
            [venueId, had.id, b.counting, b.low_at ?? null, b.low_at !== undefined],
          );
        return view((await levelOf(c, venueId, itemId, variantId))!);
      });
    },
  );

  const moveRoute = (
    path: "receive" | "count" | "adjust",
    body: z.ZodType<{ variant_id?: string | null | undefined } & Record<string, unknown>>,
    hint: string,
    plan: (b: Record<string, unknown>, onHand: number) => { kind: StockMoveKind; delta: number },
  ) =>
    app.post<{ Params: { venueId: string; menuItemId: string }; Body: unknown }>(
      `/v1/venues/:venueId/stock/:menuItemId/${path}`,
      { config: write },
      async (request) => {
        const parsed = body.safeParse(request.body ?? {});
        if (!parsed.success) throw new ApiError("invalid_request", hint);
        const by = userOf(request);
        const b = parsed.data;
        return request.inVenue(async (c) => {
          const venueId = request.venueId!;
          const itemId = request.params.menuItemId;
          const variantId = b.variant_id ?? null;
          await target(c, venueId, itemId, variantId);
          const level = await levelOf(c, venueId, itemId, variantId);
          if (!level || !level.active) throw new ApiError("not_found", "this item isn't counted");
          // A count against the row as locked, so a sale in between can't be lost.
          const locked = await c.query<{ on_hand: number }>(
            "select on_hand from stock_levels where venue_id = $1 and id = $2 for update",
            [venueId, level.id],
          );
          const m = plan(b, locked.rows[0]!.on_hand);
          if (m.delta !== 0 || m.kind === "count")
            await moveStock(c, venueId, level.id, {
              kind: m.kind,
              delta: m.delta,
              reason: typeof b["reason"] === "string" ? b["reason"].trim() : null,
              by,
              at: nowIso(),
            });
          return view((await levelOf(c, venueId, itemId, variantId))!);
        });
      },
    );

  moveRoute(
    "receive",
    z
      .object({ variant_id: uuid.nullable().optional(), qty: z.number().int().min(1).max(100000) })
      .strict(),
    "send { qty } of at least 1",
    (b) => ({ kind: "receive", delta: Number(b["qty"]) }),
  );
  moveRoute(
    "count",
    z
      .object({
        variant_id: uuid.nullable().optional(),
        on_hand: z.number().int().min(0).max(1000000),
      })
      .strict(),
    "send { on_hand } of 0 or more",
    (b, onHand) => ({ kind: "count", delta: Number(b["on_hand"]) - onHand }),
  );
  moveRoute(
    "adjust",
    z
      .object({
        variant_id: uuid.nullable().optional(),
        delta: z
          .number()
          .int()
          .min(-100000)
          .max(100000)
          .refine((d) => d !== 0),
        reason: z.string().trim().min(1).max(200),
      })
      .strict(),
    "send { delta } (not 0) and a reason",
    (b) => ({ kind: "adjust", delta: Number(b["delta"]) }),
  );

  app.get<{ Params: { venueId: string }; Querystring: { from?: string; to?: string } }>(
    "/v1/venues/:venueId/stock/report",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const v = await venueClock(c, venueId);
        const tonight = businessDate(options.clock.now(), v.timeZone, v.dayCutover).businessDate;
        const { from: rawFrom, to: rawTo } = request.query;
        if ((rawFrom && !DATE.test(rawFrom)) || (rawTo && !DATE.test(rawTo)))
          throw new ApiError("invalid_request", "dates are YYYY-MM-DD");
        const to = rawTo ? Temporal.PlainDate.from(rawTo) : tonight;
        const from = rawFrom ? Temporal.PlainDate.from(rawFrom) : to;
        if (Temporal.PlainDate.compare(from, to) > 0)
          throw new ApiError("invalid_request", "from is after to");
        if (from.until(to).days >= MAX_DAYS)
          throw new ApiError("invalid_request", `${MAX_DAYS} days at most`);
        const r = await c.query<
          LevelRow & { used: string; received: string; adjusted: string; moves: string }
        >(
          `${LEVELS.replace(
            "from stock_levels s",
            `, coalesce(m.used, 0)::text as used, coalesce(m.received, 0)::text as received,
               coalesce(m.adjusted, 0)::text as adjusted, coalesce(m.moves, 0)::text as moves
               from stock_levels s
               left join (select stock_id,
                                 -sum(delta) filter (where kind in ('sale', 'void')) as used,
                                 sum(delta) filter (where kind = 'receive') as received,
                                 sum(delta) filter (where kind in ('count', 'adjust')) as adjusted,
                                 count(*) as moves
                            from stock_moves where venue_id = $1 and business_date between $3::date and $4::date
                           group by stock_id) m on m.stock_id = s.id`,
          )} order by i.name, v.sort, v.name`,
          [venueId, nowIso(), from.toString(), to.toString()],
        );
        return {
          from: from.toString(),
          to: to.toString(),
          levels: r.rows
            .filter((x) => x.active || Number(x.moves) > 0)
            .map((x) => ({
              ...view(x),
              used: Number(x.used),
              received: Number(x.received),
              adjusted: Number(x.adjusted),
            })),
        };
      }),
  );
}
