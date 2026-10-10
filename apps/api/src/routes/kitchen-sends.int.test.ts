import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, reasonOnlyUsed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Send to kitchen (K-05; Kitchen and food · Ordering food; D99). Food staff ring goes on the tab or
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
const kitchenJobs = async (check: string) =>
  (
    await owner.query<{ id: string; payload: Record<string, unknown>; reprint_n: number }>(
      `select id, payload, reprint_n from print_jobs where check_id = $1 and station = 'kitchen'
        order by created_at, reprint_n`,
      [check],
    )
  ).rows;
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

describe("Send to kitchen (K-05)", () => {
  it("food sent with a round on Jess P.'s tab is on the tab, Not sent, and prints nothing", async () => {
    as("maya", "bartender", "pin");
    const tab = ids["chk_t1"]!;
    await round(tab, [wings(), beer()]);
    const lines = await unsent(tab);
    expect(lines.map((l) => l.description)).toEqual(["TEST wings · TEST soy garlic"]);
    expect(await kitchenJobs(tab)).toHaveLength(0);
    // The beer rung with it prints no bar ticket while drink tickets are off (M6-29).
    const bar = await owner.query(
      "select 1 from print_jobs j join orders o on o.id = j.order_id where o.check_id = $1",
      [tab],
    );
    expect(bar.rowCount).toBe(0);
  });

  it("Send prints one ticket, Bar · Jess P., with the note boxed as an allergy, and the lines read sent", async () => {
    as("maya", "bartender", "pin");
    const tab = ids["chk_t1"]!;
    const [line] = await unsent(tab);
    // The Idempotency-Key is required.
    expect(
      (await call("POST", `/checks/${tab}/kitchen-sends`, { lines: [{ line_id: line!.id }] }))
        .statusCode,
    ).toBe(400);
    const r = await send(
      tab,
      [{ line_id: line!.id, kitchen_note: "peanuts", kitchen_note_allergy: true }],
      "jess-1",
    );
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      ticket: "Bar · Jess P.",
      sent_at: expect.stringMatching(/^2026-09-26T02:4/),
    });
    const jobs = await kitchenJobs(tab);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({
      kitchen: true,
      room: "Bar · Jess P.",
      sent_at: expect.stringMatching(/^2026-09-26T02:4/),
      lines: [
        {
          qty: 1,
          name: "TEST wings",
          options: ["TEST soy garlic"],
          kitchen_note: "peanuts",
          allergy: true,
        },
      ],
    });
    expect(await unsent(tab)).toHaveLength(0);
    const sent = (await viewOf(tab)).lines.find((l) => l.id === line!.id)!;
    expect(sent.kitchen).toMatchObject({
      sent_at: expect.stringMatching(/^2026-09-26T02:4/),
      job_id: jobs[0]!.id,
    });

    // The same request again answers the same, and prints nothing more.
    const again = await send(
      tab,
      [{ line_id: line!.id, kitchen_note: "peanuts", kitchen_note_allergy: true }],
      "jess-1",
    );
    expect(again.statusCode).toBe(201);
    // Another screen sending the same line is refused.
    const twice = await send(tab, [{ line_id: line!.id }]);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.details).toMatchObject({ reason: "already_sent" });
    expect(await kitchenJobs(tab)).toHaveLength(1);
  });

  it("a second Send lists only food added since, and two screens at once print one ticket", async () => {
    as("maya", "bartender", "pin");
    const tab = ids["chk_t1"]!;
    await round(tab, [fries()]);
    const lines = await unsent(tab);
    expect(lines.map((l) => l.description)).toEqual(["TEST French Fries"]);
    const both = await Promise.all([
      send(tab, [{ line_id: lines[0]!.id }]),
      send(tab, [{ line_id: lines[0]!.id }]),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await kitchenJobs(tab)).toHaveLength(2);
  });

  it("Reprint prints REPRINT 2 and changes nothing on the check", async () => {
    as("maya", "bartender", "pin");
    const tab = ids["chk_t1"]!;
    const before = await viewOf(tab);
    const first = (await kitchenJobs(tab))[0]!;
    const r = await call("POST", `/print-jobs/${first.id}/reprint`, {});
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().reprint_n).toBe(2);
    const after = await viewOf(tab);
    expect(after.amount_due_cents).toBe(before.amount_due_cents);
    expect(after.lines).toEqual(before.lines);
  });

  it("unsent food comes off with no reason or approval; sent food only by a void, under the reason-only limit", async () => {
    as("maya", "bartender", "pin");
    const tab = ids["chk_room9"]!;
    // Seven fries ($35) and one wings: the removal is over the $25 reason-only limit, and needs nothing.
    await round(tab, [fries(7), wings()]);
    const [friesLine, wingsLine] = await unsent(tab);
    const used = await reasonOnlyUsed(owner, venueId, ids["maya"]!, "2026-09-25");
    const removed = await call("POST", `/checks/${tab}/lines/${friesLine!.id}/remove-unsent`);
    expect(removed.statusCode, removed.body).toBe(200);
    const off = await owner.query<{ reason: string; added_by: string; approved_by: string | null }>(
      "select reason, added_by, approved_by from check_lines where id = $1",
      [removed.json().line_id],
    );
    expect(off.rows[0]).toEqual({
      reason: "Not sent to the kitchen",
      added_by: ids["maya"],
      approved_by: null,
    });
    expect(await reasonOnlyUsed(owner, venueId, ids["maya"]!, "2026-09-25")).toBe(used);
    // Sent food can't be removed that way.
    await send(tab, [{ line_id: wingsLine!.id }]);
    const refused = await call("POST", `/checks/${tab}/lines/${wingsLine!.id}/remove-unsent`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details).toMatchObject({ reason: "kitchen_sent" });
    // A void of the sent $12 wings fits the reason-only limit.
    const voided = await call("POST", `/checks/${tab}/lines/${wingsLine!.id}/void`, {
      reason: "Guest changed their mind",
      made: true,
    });
    expect(voided.statusCode, voided.body).toBe(201);
    // Three sent wings ($36) are over the $25 limit: a manager decides.
    await round(tab, [{ ...wings(), qty: 3 }]);
    const [three] = await unsent(tab);
    await send(tab, [{ line_id: three!.id }]);
    const asked = await call("POST", `/checks/${tab}/lines/${three!.id}/void`, {
      reason: "Wrong order",
      made: true,
    });
    expect(asked.statusCode, asked.body).toBe(202);
  });

  it("a quick sale's Send to kitchen asks for a name, and the ticket reads Bar · Seat 3", async () => {
    as("maya", "bartender", "pin");
    const sale = await call("POST", "/quick-sales", {
      client_order_id: `kitchen-quick-${++n}`,
      lines: [fries(), beer()],
    });
    expect(sale.statusCode, sale.body).toBe(201);
    const check = sale.json().check_id as string;
    const [line] = await unsent(check);
    const nameless = await send(check, [{ line_id: line!.id }]);
    expect(nameless.statusCode).toBe(400);
    expect(nameless.json().error.details).toMatchObject({ reason: "name_required" });
    const r = await send(check, [{ line_id: line!.id }], undefined, "Seat 3");
    expect(r.statusCode, r.body).toBe(201);
    expect((await kitchenJobs(check))[0]!.payload).toMatchObject({ room: "Bar · Seat 3" });
    // Back to the sale would send the food again later: refused once it's sent.
    const back = await call("POST", `/quick-sales/${check}/void`);
    expect(back.statusCode).toBe(400);
    expect(back.json().error.details).toMatchObject({ reason: "kitchen_sent" });
  });

  it("food from Room 9's tab is on the check at once as Not sent, and Send prints Room 9", async () => {
    as("maya", "bartender", "pin");
    const room = ids["chk_room9"]!;
    await round(room, [fries(2)]);
    const [line] = await unsent(room);
    expect(line!.kitchen!.open_qty).toBe(2);
    const before = (await kitchenJobs(room)).length;
    expect(await kitchenJobs(room)).toHaveLength(before);
    const r = await send(room, [{ line_id: line!.id, kitchen_note: "no salt" }]);
    expect(r.statusCode, r.body).toBe(201);
    expect((await kitchenJobs(room)).at(-1)!.payload).toMatchObject({
      room: "Room 9",
      lines: [{ qty: 2, name: "TEST French Fries", kitchen_note: "no salt", allergy: false }],
    });
  });

  it("a drink isn't food, and with the module off the route isn't there", async () => {
    as("maya", "bartender", "pin");
    const room = ids["chk_room9"]!;
    const drink = (await viewOf(room)).lines.find((l) => l.kind === "item" && !l.kitchen)!;
    const r = await send(room, [{ line_id: drink.id }]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toMatchObject({ reason: "not_food" });
    await owner.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'kitchen'",
      [venueId],
    );
    expect((await send(room, [{ line_id: drink.id }])).statusCode).toBe(404);
    await owner.query(
      "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'kitchen'",
      [venueId],
    );
  });
});
