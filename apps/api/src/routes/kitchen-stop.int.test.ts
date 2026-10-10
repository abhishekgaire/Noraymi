import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, loadDemoSeed, publishRulePack, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  newYorkCounty,
  newYorkCountyTaxed,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * 86 food, close the kitchen, and the last-order time (K-07; Kitchen and food · 86 and closing
 * the kitchen). Every route that creates a food line (the room page, a room tab, a bar tab and a
 * quick sale) refuses an 86'd food choice, a closed kitchen and a passed last order, while drinks
 * keep their own rules. The menu is a TEST one, no venue's.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let slug = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let host = "";
let n = 0;
let who: Principal | undefined;
const food: Record<string, string> = {};
const TEST_NOTICE = { en: "TEST ONLY · allergy notice", es: "SOLO PRUEBA · aviso de alergias" };

const as = (person: string, role: string, session: "passkey" | "pin" = "pin") => {
  who = {
    kind: "user",
    userId: ids[person]!,
    session,
    memberships: [{ venueId, membershipId: ids[`${person}.membership`]!, role } as never],
  };
};
const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;
const guestOrder = (lines: object[]) =>
  app.inject({
    method: "POST",
    url: "/v1/public/room-session/orders",
    headers: { cookie: host },
    payload: { client_order_id: `kitchen-stop-${++n}-abcdef`, lines },
  });
const staff = (method: "GET" | "POST" | "PUT", path: string, payload?: object, key?: string) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload ? { payload } : {}),
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  });
const wings = () => ({ variant_id: food["wings"]!, qty: 1, option_ids: [food["soy"]!] });
const hot = () => ({ variant_id: food["wings"]!, qty: 1, option_ids: [food["hot"]!] });
const beer = () => ({ variant_id: food["drink"]!, qty: 1 });
const staffOrder = (check: string, lines: object[]) =>
  staff("POST", `/checks/${check}/orders`, { client_order_id: `kitchen-stop-${++n}`, lines });
const quickSale = (lines: object[]) =>
  staff("POST", "/quick-sales", { client_order_id: `kitchen-stop-${++n}`, lines });
/** Every route that creates a food line, with the reason each refusal names. */
const everyRoute = async (lines: object[]) => {
  as("maya", "bartender");
  const answers = [
    await guestOrder(lines),
    await staffOrder(ids["chk_room9"]!, lines),
    await staffOrder(ids["chk_t1"]!, lines),
    await quickSale(lines),
  ];
  return answers.map((r) =>
    r.statusCode >= 400 ? (r.json().error.details?.reason ?? r.body) : r.statusCode,
  );
};
type Item = {
  name: string;
  out_tonight: boolean;
  kitchen_stop?: string | null;
  groups: { options: { name: string; out_tonight: boolean }[] }[];
};
const itemsOf = (body: { categories: { items: Item[] }[] }) =>
  body.categories.flatMap((c) => c.items);
const guestMenuItem = async (name: string) =>
  itemsOf((await app.inject({ method: "GET", url: `/v1/public/venues/${slug}/menu` })).json()).find(
    (i) => i.name === name,
  )!;
const staffMenuItem = async (name: string) => {
  as("maya", "bartender");
  return itemsOf((await staff("GET", "/menu")).json()).find((i) => i.name === name)!;
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  const signing = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(raw, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: signing,
    });
  slug = (await raw.query<{ slug: string }>("select slug from venues where id = $1", [venueId]))
    .rows[0]!.slug;
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const one = async (sql: string, params: unknown[]) =>
    (await raw.query<{ id: string }>(sql, params)).rows[0]!.id;
  const cat = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Wings', 900, 'food') returning id",
    [venueId],
  );
  food["item"] = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST wings', 'kitchen') returning id",
    [venueId, cat],
  );
  food["wings"] = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 1200) returning id",
    [venueId, food["item"]],
  );
  const sauce = await one(
    "insert into modifier_groups (venue_id, item_id, name, required, min_choices) values ($1, $2, 'TEST sauce', true, 1) returning id",
    [venueId, food["item"]],
  );
  food["soy"] = await one(
    "insert into menu_options (venue_id, item_id, group_id, name) values ($1, $3, $2, 'TEST soy garlic') returning id",
    [venueId, sauce, food["item"]],
  );
  food["hot"] = await one(
    "insert into menu_options (venue_id, item_id, group_id, name, sort) values ($1, $3, $2, 'TEST hot', 1) returning id",
    [venueId, sauce, food["item"]],
  );
  food["drink"] = (
    await raw.query<{ id: string }>(
      `select v.id from menu_variants v join menu_items i on i.id = v.item_id
        where i.venue_id = $1 and i.station = 'bar' and i.alcohol and i.shown and i.out_until is null and v.out_until is null
          and not exists (select 1 from modifier_groups g where g.item_id = i.id and (g.required or g.min_choices > 0))
        order by i.name limit 1`,
      [venueId],
    )
  ).rows[0]!.id;
  await raw.query(
    "update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id = 'kitchen'",
    [venueId],
  );
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

describe("86 food (K-07)", () => {
  it("an 86'd food choice greys out on the bar POS and the room page, and every route refuses it", async () => {
    as("maya", "bartender");
    const out = await staff(
      "POST",
      `/menu/items/${food["item"]}/out-tonight`,
      { option_id: food["soy"] },
      "86-soy",
    );
    expect(out.statusCode, out.body).toBe(200);
    const soy = (i: Item) => i.groups[0]!.options.find((o) => o.name === "TEST soy garlic")!;
    expect(soy(await staffMenuItem("TEST wings")).out_tonight).toBe(true);
    expect(soy(await guestMenuItem("TEST wings")).out_tonight).toBe(true);
    expect(await everyRoute([wings()])).toEqual(Array(4).fill("out_tonight"));
    // The other sauce still orders, on every route.
    expect(await everyRoute([hot()])).toEqual([201, 201, 201, 201]);
  });
});

describe("the last order time (K-07)", () => {
  it("with lastOrder empty, food can be ordered at 3:59 AM while room ordering is open", async () => {
    clock.set(Temporal.Instant.from("2026-09-26T07:59:00Z")); // Sat 3:59 AM EDT
    try {
      as("maya", "bartender");
      expect((await staff("GET", "/kitchen")).json()).toMatchObject({
        last_order: null,
        stop: null,
      });
      expect((await guestOrder([hot()])).statusCode).toBe(201);
    } finally {
      clock.set(SEED_NOW);
    }
  });

  it("after a 01:30 last order food greys out with the reason and is refused, and drinks are unchanged", async () => {
    as("abhishek", "owner", "passkey");
    const saved = await staff("PUT", "/settings/kitchen", {
      value: { allergyNotice: TEST_NOTICE, lastOrder: "01:30", unsentWarnMin: 5 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    as("maya", "bartender");
    // 10:41 PM: before the last order.
    expect((await staff("GET", "/kitchen")).json().stop).toBeNull();
    expect((await guestMenuItem("TEST wings")).kitchen_stop).toBeNull();
    clock.set(Temporal.Instant.from("2026-09-26T05:31:00Z")); // Sat 1:31 AM EDT
    try {
      as("maya", "bartender");
      expect((await staff("GET", "/kitchen")).json().stop).toBe("last_order");
      expect(await guestMenuItem("TEST wings")).toMatchObject({
        out_tonight: true,
        kitchen_stop: "last_order",
      });
      expect(await everyRoute([hot()])).toEqual(Array(4).fill("last_order"));
      // A drink still follows only the alcohol rules.
      expect((await guestOrder([beer()])).statusCode).toBe(201);
    } finally {
      clock.set(SEED_NOW);
      as("abhishek", "owner", "passkey");
      await staff("PUT", "/settings/kitchen", {
        value: { allergyNotice: TEST_NOTICE, lastOrder: null, unsentWarnMin: 5 },
      });
    }
  });
});

describe("Close the kitchen (K-07)", () => {
  it("only a manager or the owner can close it", async () => {
    as("maya", "bartender");
    expect((await staff("POST", "/kitchen/close", {})).statusCode).toBe(403);
  });

  it("greys every food item, shows Kitchen closed, refuses food, and accepted food still prints", async () => {
    // A guest's food order ringing before the close is accepted after it, and prints.
    const placed = await guestOrder([hot()]);
    expect(placed.statusCode, placed.body).toBe(201);
    const meal = (placed.json().orders as { id: string }[])[0]!.id;

    as("abhishek", "owner", "passkey");
    const closed = await staff("POST", "/kitchen/close", {});
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({
      closed: true,
      stop: "kitchen_closed",
      closed_until: "2026-09-26T10:00:00Z",
    });
    expect(await guestMenuItem("TEST wings")).toMatchObject({
      out_tonight: true,
      kitchen_stop: "kitchen_closed",
    });
    expect((await staffMenuItem("TEST wings")).kitchen_stop).toBe("kitchen_closed");
    expect(await everyRoute([hot()])).toEqual(Array(4).fill("kitchen_closed"));
    expect((await guestOrder([beer()])).statusCode).toBe(201);

    as("maya", "bartender");
    const accepted = await staff("POST", `/orders/${meal}/accept`, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    const job = await raw.query(
      "select 1 from print_jobs where order_id = $1 and station = 'kitchen'",
      [meal],
    );
    expect(job.rowCount).toBe(1);
  });

  it("Reopen the kitchen undoes it the same night, and an item 86'd on its own stays 86'd", async () => {
    as("abhishek", "owner", "passkey");
    const r = await staff("POST", "/kitchen/reopen", {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ closed: false, stop: null });
    const item = await guestMenuItem("TEST wings");
    expect(item.kitchen_stop).toBeNull();
    expect(item.groups[0]!.options.find((o) => o.name === "TEST soy garlic")!.out_tonight).toBe(
      true,
    );
    expect(await everyRoute([hot()])).toEqual([201, 201, 201, 201]);
  });

  it("is over by itself at the next cutover", async () => {
    as("abhishek", "owner", "passkey");
    expect((await staff("POST", "/kitchen/close", {})).statusCode).toBe(200);
    clock.set(Temporal.Instant.from("2026-09-26T10:00:00Z")); // Sat 6:00 AM, a new business date
    try {
      as("maya", "bartender");
      expect((await staff("GET", "/kitchen")).json().stop).toBeNull();
    } finally {
      clock.set(SEED_NOW);
    }
  });
});
