import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M3-07: staff orders from a room's tab, accepted as placed, and unsent drinks saved with a version. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const req = (method: "GET" | "POST" | "PUT", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
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
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const maya: Principal = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => maya],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("unsent drinks", () => {
  it("save with the version they read; a stale save answers 409 with what's there now", async () => {
    const key = `/drafts/${ids["chk_room9"]}`;
    expect((await req("GET", key)).json()).toMatchObject({ lines: [], version: 0 });
    const marg = { variant_id: ids["menu_marg_regular"]!, qty: 2 };
    const first = await req("PUT", key, { lines: [marg], version: 0 });
    expect(first.json()).toMatchObject({ version: 1 });
    const stale = await req("PUT", key, { lines: [], version: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details).toMatchObject({ version: 1, lines: [marg] });
    expect((await req("PUT", key, { lines: [marg], version: 1 })).json().version).toBe(2);
    expect((await req("GET", key)).json()).toMatchObject({ lines: [marg], version: 2 });
    // Never on the check.
    const check = (await req("GET", `/checks/${ids["chk_room9"]}`)).json();
    expect(check.lines_cents).toBe(15800);
  });

  it("the quick sale has its own draft", async () => {
    expect((await req("GET", "/drafts/quick")).json()).toMatchObject({ version: 0 });
    expect((await req("GET", "/drafts/not-a-check")).statusCode).toBe(404);
  });
});

describe("a staff order from a room's tab", () => {
  it("refuses a Margarita with no flavor, naming what's missing", async () => {
    const r = await req("POST", `/checks/${ids["chk_room9"]}/orders`, {
      lines: [{ variant_id: ids["menu_marg_regular"], qty: 2 }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ message: "Pick flavor for Margarita" });
    expect(r.json().error.details).toMatchObject({ reason: "choice_missing", group: "Flavor" });
  });

  it("refuses Hoegaarden: 86'd tonight", async () => {
    const r = await req("POST", `/checks/${ids["chk_room9"]}/orders`, {
      lines: [{ variant_id: ids["menu_hoe_regular"], qty: 1 }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("Hoegaarden is 86'd tonight");
  });

  it("2 × Margarita · Peach goes on Room 9's check at once, prints a ticket and empties the draft", async () => {
    const body = {
      client_order_id: "room9-send-0001",
      lines: [{ variant_id: ids["menu_marg_regular"], qty: 2, option_ids: [await peach()] }],
    };
    const r = await req("POST", `/checks/${ids["chk_room9"]}/orders`, body);
    expect(r.statusCode).toBe(201);
    expect(r.json().order).toMatchObject({
      source: "staff",
      status: "accepted",
      placed_by: ids["maya"],
      accepted_by: ids["maya"],
      amount_cents: 2600,
    });
    const check = (await req("GET", `/checks/${ids["chk_room9"]}`)).json();
    expect(check.lines_cents).toBe(18400);
    const tickets = await raw.query<{ n: number }>(
      "select count(*)::int as n from print_jobs where order_id = $1",
      [r.json().order.id],
    );
    expect(tickets.rows[0]!.n).toBe(1);
    expect((await req("GET", `/drafts/${ids["chk_room9"]}`)).json()).toMatchObject({ lines: [] });
    // A retried send makes no second order.
    const again = await req("POST", `/checks/${ids["chk_room9"]}/orders`, body);
    expect(again.json().order.id).toBe(r.json().order.id);
    expect((await req("GET", `/checks/${ids["chk_room9"]}`)).json().lines_cents).toBe(18400);
    // Then it runs like any room order.
    expect((await req("POST", `/orders/${r.json().order.id}/ready`, {})).json().order.status).toBe(
      "ready",
    );
  });
});
