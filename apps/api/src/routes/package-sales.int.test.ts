import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { packageLineShares } from "@west4/rules";
import { SEED_NOW, SimulatedClock, cents, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * A package with food (K-09; spec 16 · Food in packages; D99). Added from a room's tab, it's a
 * staff order accepted at once: its drinks print at the bar, its food reads Not sent until Send to
 * kitchen. The price is divided across its lines by their regular prices, largest remainder. The
 * test kitchen menu (TEST wings with a required TEST sauce, TEST French Fries) is laid over the
 * seed, as in kitchen-sends.int.test.ts; the package's prices are test data.
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
interface ViewLine {
  id: number;
  kind: string;
  description: string;
  amount_cents: number;
  tax_category: string | null;
  package?: { id: string; name: string };
  kitchen?: { sent_at: string | null; open_qty: number; job_id: string | null };
}
const viewOf = async (check: string) => {
  const r = await call("GET", `/checks/${check}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { lines: ViewLine[] };
};
const packageLines = async (check: string) =>
  (await viewOf(check)).lines.filter((l) => l.kind === "item" && l.package);
const jobs = async (check: string, station: string) =>
  (
    await owner.query(
      `select j.id from print_jobs j left join orders o on o.id = j.order_id
        where coalesce(j.check_id, o.check_id) = $1 and j.station = $2`,
      [check, station],
    )
  ).rowCount;
let party = "";
const sell = (check: string, picks: object[], key = `package-sale-${++n}`) =>
  call("POST", `/checks/${check}/packages`, { package_id: party, client_order_id: key, picks });
const wingsPick = () => ({
  option_ids: [food["soy"]!],
  kitchen_note: "No sesame",
  kitchen_note_allergy: true,
});

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
  const item = (food["wings_item"] = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST wings', 'kitchen') returning id",
    [venueId, cat],
  ));
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
  const friesItem = (food["fries_item"] = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST French Fries', 'kitchen') returning id",
    [venueId, sides],
  ));
  food["fries"] = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 500) returning id",
    [venueId, friesItem],
  );
  await owner.query(
    "update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id in ('kitchen', 'packages')",
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

describe("selling a package with food (K-09)", () => {
  it("refuses to save an hourly package with food, with the reason", async () => {
    as("abhishek", "owner");
    const r = await call("POST", "/packages", {
      name: "TEST wings by the hour",
      price_cents: 3000,
      hourly: true,
      contents: [{ item_id: food["wings_item"], qty: 1 }],
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.details.refusals[0].code).toBe("hourly_includes_food");
  });

  it("saves the TEST party pack and lists it for staff with the wings' sauce to pick", async () => {
    as("abhishek", "owner");
    const modelo = (
      await owner.query<{ item_id: string }>("select item_id from menu_variants where id = $1", [
        ids["menu_modelo_regular"],
      ])
    ).rows[0]!.item_id;
    const r = await call("POST", "/packages", {
      name: "TEST party pack",
      price_cents: 10000,
      contents: [
        { item_id: modelo, qty: 2 },
        { item_id: food["wings_item"], qty: 1 },
        { item_id: food["fries_item"], qty: 1 },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    party = r.json().id;
    as("maya", "bartender", "pin");
    const menu = await call("GET", "/package-menu");
    expect(menu.statusCode, menu.body).toBe(200);
    const pack = menu.json().packages.find((p: { id: string }) => p.id === party);
    expect(pack.contents.map((x: { qty: number; food: boolean }) => [x.qty, x.food])).toEqual([
      [2, false],
      [1, true],
      [1, true],
    ]);
    expect(pack.contents[1].groups[0]).toMatchObject({ name: "TEST sauce", required: true });
  });

  it("on Room 9's tab: lines add up to $100.00 by regular prices, drinks print at once, food reads Not sent", async () => {
    as("maya", "bartender", "pin");
    const room9 = ids["chk_room9"]!;
    const barBefore = await jobs(room9, "bar");
    const r = await sell(room9, [{}, wingsPick(), {}], "package-room9-1");
    expect(r.statusCode, r.body).toBe(201);
    const lines = await packageLines(room9);
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.package?.name === "TEST party pack")).toBe(true);
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(10000);
    // Each share is the regular price's part of $100.00, largest remainder (money case package_lines).
    const regular = (
      await owner.query<{ price_cents: number }>(
        "select price_cents from menu_variants where id = any($1::uuid[]) order by array_position($1::uuid[], id)",
        [[ids["menu_modelo_regular"], food["wings"], food["fries"]]],
      )
    ).rows.map((x) => x.price_cents);
    const expected = packageLineShares(cents(10000), [
      { regularCents: regular[0]! },
      { regularCents: regular[0]! },
      { regularCents: regular[1]! },
      { regularCents: regular[2]! },
    ]);
    const byCategory = (cat: string) =>
      lines.filter((l) => l.tax_category === cat).reduce((s, l) => s + l.amount_cents, 0);
    expect(byCategory("drink")).toBe(expected[0]! + expected[1]!);
    expect(byCategory("food")).toBe(expected[2]! + expected[3]!);
    // Drinks: the bar ticket printed at Accept. Food: Not sent, no kitchen ticket yet.
    expect(await jobs(room9, "bar")).toBe(barBefore! + 1);
    expect(await jobs(room9, "kitchen")).toBe(0);
    const food2 = lines.filter((l) => l.kitchen);
    expect(food2).toHaveLength(2);
    expect(food2.every((l) => l.kitchen!.sent_at === null)).toBe(true);
    // Send to kitchen prints it in the kitchen, with the allergy note.
    const sent = await call(
      "POST",
      `/checks/${room9}/kitchen-sends`,
      { lines: food2.map((l) => ({ line_id: l.id })) },
      "package-send-1",
    );
    expect(sent.statusCode, sent.body).toBe(201);
    expect(await jobs(room9, "kitchen")).toBe(1);
    const note = await owner.query<{ kitchen_note: string; kitchen_note_allergy: boolean }>(
      "select kitchen_note, kitchen_note_allergy from order_items where package_id = $1 and kitchen_note is not null",
      [party],
    );
    expect(note.rows).toEqual([{ kitchen_note: "No sesame", kitchen_note_allergy: true }]);
  });

  it("a retry with the same client_order_id adds nothing twice", async () => {
    as("maya", "bartender", "pin");
    const room9 = ids["chk_room9"]!;
    const before = (await packageLines(room9)).length;
    const r = await sell(room9, [{}, wingsPick(), {}], "package-room9-1");
    expect(r.statusCode, r.body).toBe(201);
    expect((await packageLines(room9)).length).toBe(before);
  });

  it("needs the wings' sauce, and goes on a room's tab only", async () => {
    as("maya", "bartender", "pin");
    const missing = await sell(ids["chk_room9"]!, [{}, {}, {}]);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.details.reason).toBe("choice_missing");
    const bar = await sell(ids["chk_t1"]!, [{}, wingsPick(), {}]);
    expect(bar.statusCode).toBe(400);
    expect(bar.json().error.details.reason).toBe("room_only");
  });

  it("an 86'd item in the package refuses the sale", async () => {
    as("abhishek", "owner");
    const out = (v: boolean) =>
      call("POST", `/menu/items/${food["fries_item"]}/out-tonight`, { out: v });
    expect((await out(true)).statusCode).toBeLessThan(300);
    as("maya", "bartender", "pin");
    const r = await sell(ids["chk_room9"]!, [{}, wingsPick(), {}]);
    as("abhishek", "owner");
    expect((await out(false)).statusCode).toBeLessThan(300);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.reason).toBe("out_tonight");
  });
});
