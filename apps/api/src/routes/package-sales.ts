import type { FastifyInstance, FastifyRequest } from "fastify";
import { menuPromotionRefusals, orderableVariant, type Queryable } from "@west4/db";
import { businessDate, packageLineShares } from "@west4/rules";
import { cents, type Clock, type Temporal } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { inVenueRefusing } from "../orders/alcohol.js";
import { orderItemsFor, placeStaffOrder, type StaffLine } from "../orders/place.js";
import { promotableOf } from "../menu/promotions.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Selling a package on a room's tab (K-09; spec 16 · Food in packages):
 *   GET  /v1/venues/{v}/package-menu   the packages staff can add: each with its units in order, and
 *        the choices each unit needs (picks)
 *   POST /v1/venues/{v}/checks/{c}/packages   { package_id, client_order_id?, picks?: [{ option_ids?,
 *        kitchen_note?, kitchen_note_allergy? }] } (one pick per content entry, in order): a staff
 *        order accepted at once. Its drinks print at the bar at once; its food reads Not sent until
 *        Send to kitchen (D99, the cautious default while when package food fires is open). The price
 *        is divided across its lines by their regular prices, largest remainder; each line keeps its
 *        own tax category and `package_id`.
 * The promotion checks run again at the sale: a package the rule pack now refuses isn't sold. An
 * hourly package isn't sold on a tab (its price is per hour), and one that relies on the
 * private-function exception isn't either. A content entry with no fixed quantity (a soda refill)
 * is one line.
 */
type Row = Record<string, unknown>;
const id = z.string().uuid();
const saleBody = z
  .object({
    package_id: id,
    client_order_id: z.string().min(8).max(64).optional(),
    picks: z
      .array(
        z
          .object({
            option_ids: z.array(id).max(10).optional(),
            kitchen_note: z.string().max(200).nullable().optional(),
            kitchen_note_allergy: z.boolean().optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();

const person = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
  const m = p.memberships.find((x) => x.venueId === request.venueId);
  if (!m) throw new ApiError("forbidden", "not a member of this venue");
  return {
    userId: p.userId,
    membershipId: m.membershipId,
    deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
  };
};

/** Each content item's first variant, the one its regular price comes from (as the promotion checks). */
async function defaultVariants(c: Queryable, venueId: string, itemIds: readonly string[]) {
  const r = await c.query<{ item_id: string; id: string }>(
    `select distinct on (item_id) item_id, id from menu_variants
      where venue_id = $1 and item_id = any($2::uuid[]) order by item_id, sort, name, id`,
    [venueId, [...new Set(itemIds)]],
  );
  return new Map(r.rows.map((x) => [x.item_id, x.id]));
}

const contentsOf = (row: Row) => row["contents"] as { item_id: string; qty: number | null }[];

async function today(c: Queryable, venueId: string, now: Temporal.Instant) {
  const clock = await venueClock(c, venueId);
  return businessDate(now, clock.timeZone, clock.dayCutover).businessDate;
}

/**
 * Why a package can't be sold now, or null: on a tab, or at a room's start (P-04), where only a
 * package with a length is sold, and one with a length but nothing in it is room time alone. A
 * package with a length sets the room's time, so it's never added to a running tab.
 */
async function unsellable(
  c: Queryable,
  venueId: string,
  row: Row,
  now: Temporal.Instant,
  atStart = false,
): Promise<{ reason: string; message: string } | null> {
  if (row["hourly"] === true)
    return { reason: "hourly_package", message: `${String(row["name"])} is priced by the hour` };
  if (row["private_function_only"] === true)
    return {
      reason: "private_function_not_cleared",
      message: `${String(row["name"])} relies on the private-function exception`,
    };
  const length = row["minutes"] == null ? null : Number(row["minutes"]);
  if (atStart && length === null)
    return { reason: "no_length", message: `${String(row["name"])} has no length of room time` };
  if (!atStart && length !== null)
    return {
      reason: "starts_room",
      message: `${String(row["name"])} sets the room's time: pick it when the room starts`,
    };
  if (contentsOf(row).length === 0 && length === null)
    return { reason: "empty_package", message: `${String(row["name"])} has nothing in it` };
  const { refusals } = await menuPromotionRefusals(
    c,
    venueId,
    [promotableOf("packages", row)],
    await today(c, venueId, now),
  );
  if (refusals.length > 0)
    return { reason: "promotion_refused", message: refusals.map((r) => r.message).join(" ") };
  return null;
}

export function packageSaleRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get(
    "/v1/venues/:venueId/package-menu",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "packages",
        idempotency: "none",
      }),
    },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const now = options.clock.now();
        const nowIso = new Date(now.epochMilliseconds).toISOString();
        // ?at_start=1 (P-04): the packages a walk-in can start with: each with a length, and none
        // whose lines need a choice, since the walk-in dialog asks for none.
        const atStart = (request.query as { at_start?: string }).at_start === "1";
        const rows = (
          await c.query<Row>(
            `select id, name, price_cents, hourly, private_function_only, contents, minutes from packages
              where venue_id = $1 order by name, id`,
            [venueId],
          )
        ).rows;
        const packages = [];
        for (const row of rows) {
          if (await unsellable(c, venueId, row, now, atStart)) continue;
          const variants = await defaultVariants(
            c,
            venueId,
            contentsOf(row).map((x) => x.item_id),
          );
          const contents = [];
          for (const entry of contentsOf(row)) {
            const variantId = variants.get(entry.item_id);
            const v = variantId ? await orderableVariant(c, venueId, variantId, nowIso) : null;
            contents.push({
              item_id: entry.item_id,
              variant_id: variantId ?? null,
              name: v?.item_name ?? null,
              qty: entry.qty ?? 1,
              food: v?.station === "kitchen",
              alcohol: v?.alcohol ?? false,
              available: Boolean(v?.shown) && !v?.out_tonight && !v?.kitchen_stop,
              groups: (v?.groups ?? []).map((g) => ({
                id: g.id,
                name: g.name,
                required: g.required,
                min_choices: g.min_choices,
                max_choices: g.max_choices,
                // K-12: the group's included and extra picks, its sizes and the choice that opens it.
                included_choices: g.included_choices,
                extra_choice_cents: g.extra_choice_cents,
                variant_ids: g.variant_ids,
                when_option_id: g.when_option_id,
                options: g.options
                  .filter((o) => !o.out_tonight)
                  .map((o) => ({
                    id: o.id,
                    name: o.name,
                    price_delta_cents: o.price_delta_cents,
                    out_tonight: o.out_tonight,
                    component: o.component,
                  })),
              })),
            });
          }
          if (atStart && contents.some((x) => !x.variant_id || x.groups.some((g) => g.required)))
            continue;
          packages.push({
            id: String(row["id"]),
            name: String(row["name"]),
            price_cents: Number(row["price_cents"]),
            minutes: row["minutes"] == null ? null : Number(row["minutes"]),
            contents,
          });
        }
        return { packages };
      }),
  );

  app.post<{ Params: { venueId: string; checkId: string }; Body: unknown }>(
    "/v1/venues/:venueId/checks/:checkId/packages",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "packages",
        action: "orders.accept",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      const parsed = saleBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      if (!id.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such check");
      const me = person(request);
      const venueId = request.venueId!;
      const checkId = request.params.checkId;
      const body = parsed.data;
      const order = await inVenueRefusing(request, async (c) => {
        const now = options.clock.now();
        const found = await c.query<Row>(
          `select id, name, price_cents, hourly, private_function_only, contents, minutes from packages
            where venue_id = $1 and id = $2`,
          [venueId, body.package_id],
        );
        const row = found.rows[0];
        if (!row) throw new ApiError("not_found", "no such package");
        const check = await c.query<{ room_session_id: string | null }>(
          "select room_session_id from checks where venue_id = $1 and id = $2",
          [venueId, checkId],
        );
        if (!check.rows[0]) throw new ApiError("not_found", "no such check");
        // Packages are added from a room's tab (spec 16); a bar tab or quick sale has none.
        if (!check.rows[0].room_session_id)
          throw new ApiError("invalid_request", "a package goes on a room's tab", {
            details: { reason: "room_only" },
          });
        const why = await unsellable(c, venueId, row, now);
        if (why)
          throw new ApiError("invalid_request", why.message, { details: { reason: why.reason } });
        const contents = contentsOf(row);
        if ((body.picks?.length ?? 0) > contents.length)
          throw new ApiError("invalid_request", "more picks than the package has lines");
        const variants = await defaultVariants(
          c,
          venueId,
          contents.map((x) => x.item_id),
        );
        // One line per unit: "2 beers" is two lines, each with the entry's picks.
        const lines: StaffLine[] = contents.flatMap((entry, n) => {
          const variantId = variants.get(entry.item_id);
          if (!variantId)
            throw new ApiError("invalid_request", "an item in this package isn't on the menu", {
              details: { reason: "not_on_menu", item_id: entry.item_id },
            });
          const pick = body.picks?.[n];
          return Array.from({ length: entry.qty ?? 1 }, () => ({
            variant_id: variantId,
            qty: 1,
            option_ids: pick?.option_ids,
            kitchen_note: pick?.kitchen_note ?? null,
            kitchen_note_allergy: pick?.kitchen_note_allergy,
          }));
        });
        return placeStaffOrder(c, venueId, {
          checkId,
          lines,
          clientOrderId: body.client_order_id ?? null,
          ...me,
          now,
          keepDraft: true,
          package: { id: String(row["id"]), priceCents: Number(row["price_cents"]) },
        });
      });
      return reply.code(201).send({ order });
    },
  );
}

/**
 * The package a room starts with (P-04; spec 05 · rule 3, Prepaid block): one with a length, sold
 * at the start, or a refusal. Read before the room is seated, so its length sets the room's time.
 */
export async function packageForStart(
  c: Queryable,
  venueId: string,
  packageId: string,
  now: Temporal.Instant,
): Promise<{ id: string; name: string; minutes: number }> {
  const found = await c.query<Row>(
    `select id, name, price_cents, hourly, private_function_only, contents, minutes from packages
      where venue_id = $1 and id = $2`,
    [venueId, packageId],
  );
  const row = found.rows[0];
  if (!row) throw new ApiError("not_found", "no such package");
  const why = await unsellable(c, venueId, row, now, true);
  if (why) throw new ApiError("invalid_request", why.message, { details: { reason: why.reason } });
  return { id: String(row["id"]), name: String(row["name"]), minutes: Number(row["minutes"]) };
}

/**
 * Sells the package a room starts with, on its new check (P-04). The package's price covers its
 * length of room time and its lines: it's divided across the block (its minutes at the room's
 * rate) and each line's regular price, largest remainder (Money rules 1). The block's share is the
 * session's prepaid block; the lines are a staff order accepted at once, as on a tab (K-09). A
 * package with nothing in it is room time alone. It takes no choices: the walk-in dialog offers
 * only packages whose lines need none. Returns the block's share.
 */
export async function sellPackageAtStart(
  c: Queryable,
  venueId: string,
  input: {
    packageId: string;
    checkId: string;
    sessionId: string;
    /** The block's minutes at the room's rate: what its room time would have been. */
    blockRegularCents: number;
    userId: string;
    membershipId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<number> {
  const found = await c.query<Row>(
    "select id, price_cents, contents from packages where venue_id = $1 and id = $2",
    [venueId, input.packageId],
  );
  const row = found.rows[0];
  if (!row) throw new ApiError("not_found", "no such package");
  const price = Number(row["price_cents"]);
  const contents = contentsOf(row);
  const variants = await defaultVariants(
    c,
    venueId,
    contents.map((x) => x.item_id),
  );
  const lines: StaffLine[] = contents.flatMap((entry) => {
    const variantId = variants.get(entry.item_id);
    if (!variantId)
      throw new ApiError("invalid_request", "an item in this package isn't on the menu", {
        details: { reason: "not_on_menu", item_id: entry.item_id },
      });
    return Array.from({ length: entry.qty ?? 1 }, () => ({ variant_id: variantId, qty: 1 }));
  });
  const regular = lines.length ? await orderItemsFor(c, venueId, lines, input.now) : [];
  const shares = packageLineShares(cents(price), [
    { regularCents: input.blockRegularCents },
    ...regular.map((i) => ({
      regularCents: i.unitCents + i.options.reduce((sum, o) => sum + o.price_delta_cents, 0),
    })),
  ]);
  const block = shares[0]!;
  if (lines.length)
    await placeStaffOrder(c, venueId, {
      checkId: input.checkId,
      lines,
      clientOrderId: null,
      userId: input.userId,
      membershipId: input.membershipId,
      deviceId: input.deviceId,
      now: input.now,
      keepDraft: true,
      package: { id: input.packageId, priceCents: price - block },
    });
  await c.query("update room_sessions set prepaid_cents = $3 where venue_id = $1 and id = $2", [
    venueId,
    input.sessionId,
    block,
  ]);
  return block;
}
