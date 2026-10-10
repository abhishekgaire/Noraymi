import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Runs for food (K-06; Kitchen and food · Runners and delivery): Picked up, Delivered, Remake.
 * Set up as for Send to kitchen (K-05; Kitchen and food · Ordering food; D99). Food staff ring goes on the tab or
 * check exactly when a drink would and reads Not sent; Send to kitchen prints one kitchen ticket and
 * marks its lines sent, once. West 4 has no kitchen, so a test-only kitchen menu marked TEST is laid
 * over the seed: TEST wings with a required TEST sauce and an optional meal, and TEST French Fries.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let n = 0;
const food: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const as = (slug: string, role: string, session: "passkey" | "pin" = "passkey") => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session,
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "POST", path: string, payload?: object, key?: string) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload ? { payload } : {}),
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  });
const wings = () => ({ variant_id: food["wings"]!, qty: 1, option_ids: [food["soy"]!] });
const fries = (qty = 1) => ({ variant_id: food["fries"]!, qty });
const beer = () => ({ variant_id: ids["menu_modelo_regular"]!, qty: 1 });
const round = async (check: string, lines: object[]) => {
  const r = await call("POST", `/checks/${check}/orders`, {
    client_order_id: `kitchen-sends-${++n}`,
    lines,
  });
  expect(r.statusCode, r.body).toBe(201);
};
interface ViewLine {
  id: number;
  kind: string;
  description: string;
  kitchen?: { sent_at: string | null; open_qty: number; job_id: string | null };
}
const viewOf = async (check: string) => {
  const r = await call("GET", `/checks/${check}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { lines: ViewLine[]; amount_due_cents: number };
};
const unsent = async (check: string) =>
  (await viewOf(check)).lines.filter(
    (l) => l.kitchen && !l.kitchen.sent_at && l.kitchen.open_qty > 0,
  );
const send = (check: string, lines: object[], key = `send-${++n}`, name?: string) =>
  call("POST", `/checks/${check}/kitchen-sends`, { lines, ...(name ? { name } : {}) }, key);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  const one = async (sql: string, params: unknown[]) =>
    (await owner.query<{ id: string }>(sql, params)).rows[0]!.id;
  const cat = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Wings', 900, 'food') returning id",
    [venueId],
  );
  const item = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST wings', 'kitchen') returning id",
    [venueId, cat],
  );
  food["wings"] = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 1200) returning id",
    [venueId, item],
  );
  const sauce = await one(
    "insert into modifier_groups (venue_id, item_id, name, required, min_choices) values ($1, $2, 'TEST sauce', true, 1) returning id",
    [venueId, item],
  );
  food["soy"] = await one(
    "insert into menu_options (venue_id, item_id, group_id, name) values ($1, $3, $2, 'TEST soy garlic') returning id",
    [venueId, sauce, item],
  );
  const sides = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Sides', 910, 'food') returning id",
    [venueId],
  );
  const friesItem = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST French Fries', 'kitchen') returning id",
    [venueId, sides],
  );
  food["fries"] = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 500) returning id",
    [venueId, friesItem],
  );
  await owner.query(
    "update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id = 'kitchen'",
    [venueId],
  );
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

const orderOf = async (check: string, description: string) =>
  (
    await owner.query<{ id: string }>(
      `select o.id from orders o join order_items i on i.order_id = o.id
        where o.check_id = $1 and i.name_snapshot = $2 order by o.placed_at desc limit 1`,
      [check, description],
    )
  ).rows[0]!.id;
const pickUp = (order: string) => call("POST", `/orders/${order}/pick-up`, {});

describe("Picked up (K-06)", () => {
  it("staff-rung food for Room 9: refused while Not sent, then On its way · Maya, and Delivered charges nothing", async () => {
    as("maya", "bartender", "pin");
    const room = ids["chk_room9"]!;
    await round(room, [fries()]);
    const order = await orderOf(room, "TEST French Fries");
    const early = await pickUp(order);
    expect(early.statusCode).toBe(400);
    expect(early.json().error.details).toMatchObject({ reason: "not_sent" });
    const [line] = await unsent(room);
    expect((await send(room, [{ line_id: line!.id }])).statusCode).toBe(201);
    const listed = (await call("GET", "/orders?status=accepted")).json().orders as {
      id: string;
      kitchen_sent_at: string | null;
    }[];
    expect(listed.find((o) => o.id === order)!.kitchen_sent_at).toMatch(/^2026-09-26T02:4/);

    const due = (await viewOf(room)).amount_due_cents;
    const r = await pickUp(order);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().order).toMatchObject({
      status: "on_the_way",
      claimed_by: ids["maya"],
      claimed_by_name: "Maya S.",
    });
    expect(r.json().order.ready_at).toBeTruthy();
    const events = await owner.query<{ type: string }>(
      "select type from venue_events where entity_id = $1 and type in ('order.ready', 'order.claimed') order by id",
      [order],
    );
    expect(events.rows.map((e) => e.type)).toEqual(["order.ready", "order.claimed"]);
    // A second tap is refused: it's already on its way.
    expect((await pickUp(order)).statusCode).toBe(409);
    const delivered = await call("POST", `/orders/${order}/deliver`, {});
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect((await viewOf(room)).amount_due_cents).toBe(due);
  });

  it("a guest's food is refused while ringing, and picked up once accepted", async () => {
    as("maya", "bartender", "pin");
    const host = String(
      (
        await api.inject({
          method: "POST",
          url: "/v1/public/room-session/host",
          payload: { token: seedHostToken("sess_room9") },
        })
      ).headers["set-cookie"],
    ).split(";")[0]!;
    const placed = await api.inject({
      method: "POST",
      url: "/v1/public/room-session/orders",
      headers: { cookie: host },
      payload: { client_order_id: `kitchen-runs-${++n}-abcdef`, lines: [fries()] },
    });
    expect(placed.statusCode, placed.body).toBe(201);
    const order = (placed.json().orders as { id: string }[])[0]!.id;
    const ringing = await pickUp(order);
    expect(ringing.statusCode).toBe(409);
    expect(ringing.json().error.details).toMatchObject({ reason: "status", status: "ringing" });
    expect((await call("POST", `/orders/${order}/accept`, {})).statusCode).toBe(200);
    expect((await pickUp(order)).json().order.status).toBe("on_the_way");
  });

  it("a remake prints REMAKE in the kitchen and charges nothing again", async () => {
    as("maya", "bartender", "pin");
    const room = ids["chk_room9"]!;
    await round(room, [wings()]);
    const order = await orderOf(room, "TEST wings");
    const [line] = await unsent(room);
    await send(room, [{ line_id: line!.id }]);
    expect((await pickUp(order)).statusCode).toBe(200);
    const back = await call("POST", `/orders/${order}/return`, { reason: "nobody_there" });
    expect(back.statusCode, back.body).toBe(200);
    const due = (await viewOf(room)).amount_due_cents;
    const remake = await call("POST", `/orders/${order}/resolve`, { resolution: "remake" });
    expect(remake.statusCode, remake.body).toBe(200);
    const jobs = await owner.query<{ payload: { remake: boolean; kitchen: boolean } }>(
      "select payload from print_jobs where order_id = $1 and station = 'kitchen'",
      [order],
    );
    expect(jobs.rows.map((j) => j.payload)).toEqual([
      expect.objectContaining({ kitchen: true, remake: true }),
    ]);
    expect((await viewOf(room)).amount_due_cents).toBe(due);
  });

  it("drinks, and food on a bar tab, have no run", async () => {
    as("maya", "bartender", "pin");
    const tab = ids["chk_t1"]!;
    await round(tab, [fries(), beer()]);
    const food = await orderOf(tab, "TEST French Fries");
    const [line] = await unsent(tab);
    await send(tab, [{ line_id: line!.id }]);
    const noRun = await pickUp(food);
    expect(noRun.statusCode).toBe(400);
    expect(noRun.json().error.details).toMatchObject({ reason: "no_run" });
    const drink = await pickUp(await orderOf(tab, "Modelo"));
    expect(drink.statusCode).toBe(400);
    expect(drink.json().error.details).toMatchObject({ reason: "not_food" });
  });
});
