import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Stations (K-02; Kitchen and food · Stations; D100). West 4's seed has no kitchen, so the test
 * lays a test-only kitchen menu over it, marked TEST: two food categories, wings with an "Add
 * fries" choice, and a side. No Sing Sing fact is used. Row-level security stays on: the app
 * test reads as app_rw in venue B's context, and venue B never sees venue A's baskets.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let host = "";
let n = 0;
let who: Principal | undefined;
const food: Record<string, string> = {};

const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;
const staff = (method: "GET" | "POST" | "PATCH", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const guestOrder = (lines: object[]) =>
  app.inject({
    method: "POST",
    url: "/v1/public/room-session/orders",
    headers: { cookie: host },
    payload: { client_order_id: `kitchen-basket-${++n}-abcdef`, lines },
  });
const setKitchen = (state: "on" | "off") =>
  raw.query("update venue_modules set state = $2 where venue_id = $1 and module_id = 'kitchen'", [
    venueId,
    state,
  ]);
const wingsWithFries = () => ({
  variant_id: food["wings"],
  qty: 1,
  option_ids: [food["fries"]],
});
const twoBeers = () => ({ variant_id: food["drink"], qty: 2 });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  // The test-only kitchen menu, written straight to the tables (the module is off at first).
  const one = async (sql: string, params: unknown[]) =>
    (await raw.query<{ id: string }>(sql, params)).rows[0]!.id;
  food["catWings"] = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Wings', 900, 'food') returning id",
    [venueId],
  );
  food["catSides"] = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Sides', 910, 'food') returning id",
    [venueId],
  );
  const wingsItem = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST wings', 'kitchen') returning id",
    [venueId, food["catWings"]],
  );
  food["wingsItem"] = wingsItem;
  food["wings"] = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 1200) returning id",
    [venueId, wingsItem],
  );
  const group = await one(
    "insert into modifier_groups (venue_id, item_id, name) values ($1, $2, 'Add') returning id",
    [venueId, wingsItem],
  );
  food["fries"] = await one(
    "insert into menu_options (venue_id, item_id, group_id, name, price_delta_cents) values ($1, $3, $2, 'TEST fries', 300) returning id",
    [venueId, group, wingsItem],
  );
  const sideItem = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST side', 'kitchen') returning id",
    [venueId, food["catSides"]],
  );
  food["side"] = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 500) returning id",
    [venueId, sideItem],
  );
  // A drink from the seed with no required choice and not 86'd tonight.
  food["drink"] = (
    await raw.query<{ id: string }>(
      `select v.id from menu_variants v join menu_items i on i.id = v.item_id
        where i.venue_id = $1 and i.station = 'bar' and i.shown and i.out_until is null and v.out_until is null
          and not exists (select 1 from modifier_groups g where g.item_id = i.id and (g.required or g.min_choices > 0))
        order by i.name limit 1`,
      [venueId],
    )
  ).rows[0]!.id;
  await raw.query(
    "update venue_modules set allowed = true where venue_id = $1 and module_id = 'kitchen'",
    [venueId],
  );

  const abhishek: Principal = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  };
  who = abhishek;
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async (r) => (r.url.startsWith("/v1/venues/") ? who : undefined)],
    moduleCacheMs: 0,
  });
  await app.ready();
  host = cookieOf(
    (
      await app.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken("sess_room9") },
      })
    ).headers["set-cookie"],
  );
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("with Kitchen & food off", () => {
  it("a kitchen item can't be saved", async () => {
    const made = await staff("POST", "/menu/items", {
      category_id: food["catWings"],
      name: "TEST more wings",
      station: "kitchen",
    });
    expect(made.statusCode).toBe(400);
    expect(made.json().error.details).toEqual({ reason: "kitchen_off" });
    const beer = (
      await raw.query<{ id: string }>("select item_id as id from menu_variants where id = $1", [
        ids["menu_marg_regular"],
      ])
    ).rows[0]!.id;
    const moved = await staff("PATCH", `/menu/items/${beer}`, { station: "kitchen" });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error.details).toEqual({ reason: "kitchen_off" });
    // Another station than bar or kitchen is never one.
    expect(
      (
        await staff("POST", "/menu/items", {
          category_id: food["catWings"],
          name: "TEST expo",
          station: "expo",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("food is hidden from the staff menu and the room page, kept in Admin → Menu, and can't be ordered", async () => {
    const names = (cats: { name: string }[]) => cats.map((c) => c.name);
    expect(names((await staff("GET", "/menu")).json().categories)).not.toContain("TEST Wings");
    expect(names((await staff("GET", "/menu?include_hidden=true")).json().categories)).toContain(
      "TEST Wings",
    );
    const guest = await app.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/menu" });
    expect(names(guest.json().categories)).not.toContain("TEST Wings");

    const r = await guestOrder([wingsWithFries()]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toMatchObject({ reason: "kitchen_off" });
    const s = await staff("POST", `/checks/${ids["chk_room9"]}/orders`, {
      lines: [{ variant_id: food["side"], qty: 1 }],
    });
    expect(s.statusCode).toBe(400);
    expect(s.json().error.details).toMatchObject({ reason: "kitchen_off" });
  });
});

describe("with Kitchen & food on", () => {
  beforeAll(() => setKitchen("on"));

  it("a basket of one food item and two drinks becomes two orders, one per station, with one basket_id", async () => {
    const r = await guestOrder([wingsWithFries(), twoBeers()]);
    expect(r.statusCode, r.body).toBe(201);
    const orders = r.json().orders as { id: string }[];
    expect(orders).toHaveLength(2);
    const rows = (
      await raw.query<{ id: string; station: string; basket_id: string; status: string }>(
        "select id, station, basket_id, status from orders where id = any($1::uuid[])",
        [orders.map((o) => o.id)],
      )
    ).rows;
    expect(rows.map((o) => o.station).sort()).toEqual(["bar", "kitchen"]);
    expect(new Set(rows.map((o) => o.basket_id)).size).toBe(1);
    expect(rows[0]!.basket_id).toBeTruthy();
    expect(rows.every((o) => o.status === "ringing")).toBe(true);
    // The first order is the bar's, and both ring at the bar.
    expect(rows.find((o) => o.id === orders[0]!.id)!.station).toBe("bar");

    // A retry with the same client_order_id answers the same two orders.
    const again = await app.inject({
      method: "POST",
      url: "/v1/public/room-session/orders",
      headers: { cookie: host },
      payload: {
        client_order_id: `kitchen-basket-${n}-abcdef`,
        lines: [wingsWithFries(), twoBeers()],
      },
    });
    expect((again.json().orders as { id: string }[]).map((o) => o.id)).toEqual(
      orders.map((o) => o.id),
    );
  });

  it("an option on a food item stays on the kitchen order", async () => {
    const r = await guestOrder([twoBeers(), wingsWithFries()]);
    const kitchen = (
      await raw.query<{ station: string; options: { name: string }[]; item_station: string }>(
        `select o.station, i.options, i.station as item_station from orders o
           join order_items i on i.order_id = o.id
          where o.id = any($1::uuid[]) and i.name_snapshot = 'TEST wings'`,
        [(r.json().orders as { id: string }[]).map((o) => o.id)],
      )
    ).rows;
    expect(kitchen).toHaveLength(1);
    expect(kitchen[0]).toMatchObject({ station: "kitchen", item_station: "kitchen" });
    expect(kitchen[0]!.options.map((o) => o.name)).toEqual(["TEST fries"]);
  });

  it("a staff round with food and drinks is two accepted orders in one basket", async () => {
    const s = await staff("POST", `/checks/${ids["chk_room9"]}/orders`, {
      client_order_id: "staff-kitchen-round-1",
      lines: [twoBeers(), { variant_id: food["side"], qty: 1 }],
    });
    expect(s.statusCode, s.body).toBe(201);
    const rows = (
      await raw.query<{ station: string; status: string; basket_id: string }>(
        `select station, status, basket_id from orders
          where basket_id = (select basket_id from orders where client_order_id = 'staff-kitchen-round-1')
          order by station`,
      )
    ).rows;
    expect(rows.map((o) => [o.station, o.status])).toEqual([
      ["bar", "accepted"],
      ["kitchen", "accepted"],
    ]);
  });

  it("renaming a food category or moving it up changes the staff menu's and the room page's food order", async () => {
    expect(
      (await staff("PATCH", `/menu/categories/${food["catSides"]}`, { name: "TEST Sides & more" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await staff("PATCH", `/menu/categories/${food["catSides"]}`, { sort: 890 })).statusCode,
    ).toBe(200);
    const foodOrder = (cats: { name: string; items: { station: string }[] }[]) =>
      cats.filter((c) => c.items.some((i) => i.station === "kitchen")).map((c) => c.name);
    expect(foodOrder((await staff("GET", "/menu")).json().categories)).toEqual([
      "TEST Sides & more",
      "TEST Wings",
    ]);
    const guest = await app.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/menu" });
    const guestFood = (guest.json().categories as { name: string; food: boolean }[])
      .filter((c) => c.food)
      .map((c) => c.name);
    expect(guestFood).toEqual(["TEST Sides & more", "TEST Wings"]);
  });

  it("venue B never sees venue A's baskets: row-level security stays on the new columns", async () => {
    const b = await raw.query<{ id: string }>(
      `insert into venues (org_id, name, slug) select org_id, 'TEST venue B', 'test-venue-b' from venues
        where id = $1 returning id`,
      [venueId],
    );
    const basket = (
      await raw.query<{ basket_id: string }>(
        "select basket_id from orders where client_order_id = 'staff-kitchen-round-1'",
      )
    ).rows[0]!.basket_id;
    await raw.query("begin");
    try {
      await raw.query("set local role app_rw");
      await raw.query("select set_config('app.venue_id', $1, true)", [b.rows[0]!.id]);
      const seen = await raw.query("select 1 from orders where basket_id = $1", [basket]);
      expect(seen.rowCount).toBe(0);
      const items = await raw.query(
        "select 1 from order_items where station = 'kitchen' and kitchen_note_allergy = false",
      );
      expect(items.rowCount).toBe(0);
    } finally {
      await raw.query("rollback");
    }
  });
});
