import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { decide } from "../approvals/service.js";

/** M3-19: comps and voids of sent lines, within the reason-only limit or through approval. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let who: Principal;
const as = (slug: string, role: string): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: "pin",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});
const req = (method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const left = async () => (await req("GET", "/reason-only")).json().left_cents as number;
const lineOf = async (check: string, description: string) =>
  (await req("GET", `/checks/${ids[check]}`))
    .json()
    .lines.find(
      (l: { description: string; kind: string }) =>
        l.description === description && l.kind === "item",
    ) as { id: number; amount_cents: number };
const peach = async () =>
  (
    await raw.query<{ id: string }>(
      "select o.id from menu_options o join menu_items i on i.id = o.item_id where i.name = 'Margarita' and o.name = 'Peach'",
    )
  ).rows[0]!.id;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  who = as("maya", "bartender");
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => who],
    moduleCacheMs: 0,
  });
  await app.ready();
  // o1 accepted: 2 × Margarita · Peach on Room 9, $13.00 each.
  expect((await req("POST", `/orders/${ids["order_o1"]}/accept`, {})).statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("the fix panel", () => {
  it("Maya has $63 left this shift from her $12.00 comp tonight", async () => {
    who = as("maya", "bartender");
    expect(await left()).toBe(6300);
  });

  it("Maya comps one $13.00 Margarita on Room 9 with a reason: no approval, then $50 left", async () => {
    const line = await lineOf("chk_room9", "Margarita · Peach");
    const r = await req("POST", `/checks/${ids["chk_room9"]}/lines/${line.id}/comp`, {
      reason: "Spilled on the way",
      made: true,
      qty: 1,
    });
    expect(r.statusCode).toBe(201);
    const comp = (await req("GET", `/checks/${ids["chk_room9"]}`))
      .json()
      .lines.find((l: { kind: string }) => l.kind === "comp");
    expect(comp).toMatchObject({
      description: "COMP · Margarita · Peach",
      amount_cents: -1300,
      reverses_id: line.id,
    });
    expect(await left()).toBe(5000);
  });

  it("Diego's void of a $26.00 line waits for Andy; the VOID line appears only once Andy approves on his phone", async () => {
    who = as("maya", "bartender");
    await req("POST", `/checks/${ids["chk_room5"]}/orders`, {
      lines: [{ variant_id: ids["menu_marg_regular"], qty: 2, option_ids: [await peach()] }],
    });
    const line = await lineOf("chk_room5", "Margarita · Peach");
    expect(line.amount_cents).toBe(2600);
    who = as("diego", "front_desk");
    const r = await req("POST", `/checks/${ids["chk_room5"]}/lines/${line.id}/void`, {
      reason: "Rang on the wrong room",
      made: false,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: "Andy C." },
    });
    const view = (await req("GET", `/checks/${ids["chk_room5"]}`)).json();
    expect(view.pending_fixes).toEqual([
      { line_id: line.id, kind: "void", waiting_for: "Andy C." },
    ]);
    expect(view.lines.some((l: { kind: string }) => l.kind === "void")).toBe(false);
    // Andy decides on his own phone.
    const phone = await raw.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, user_id) values ($1, 'staff_phone', 'Andy''s phone', $2) returning id",
      [venueId, ids["andy"]],
    );
    await withVenue(pool, { venueId }, (c) =>
      decide(c, venueId, r.json().approval_id, {
        decision: "approve",
        userId: ids["andy"]!,
        deviceId: phone.rows[0]!.id,
        at: clock.now(),
      }),
    );
    const after = (await req("GET", `/checks/${ids["chk_room5"]}`)).json();
    expect(after.lines.find((l: { kind: string }) => l.kind === "void")).toMatchObject({
      description: "VOID · Margarita · Peach",
      amount_cents: -2600,
    });
    expect(after.pending_fixes).toEqual([]);
  });

  it("Andy's own void of more than $25.00 goes to Abhishek", async () => {
    who = as("andy", "manager");
    const line = await lineOf("chk_room9", "Chamisul Fresh");
    const r = await req("POST", `/checks/${ids["chk_room9"]}/lines/${line.id}/void`, {
      reason: "Never brought",
      made: false,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().waiting_for.name).toMatch(/^Abhishek/);
  });

  it("a fix needs a reason", async () => {
    who = as("maya", "bartender");
    const line = await lineOf("chk_room9", "Jäger Bomb");
    const r = await req("POST", `/checks/${ids["chk_room9"]}/lines/${line.id}/comp`, {
      reason: " ",
      made: true,
    });
    expect(r.statusCode).toBe(400);
  });
});
