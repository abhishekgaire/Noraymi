import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal, defaultPermissions } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { selfRunOrders, stepOrder } from "../orders/pipeline.js";

/** M3-18: runs on staff phones, returns, refusals and the runner's ID check at the room. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let who: Principal;
const req = (method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const as = (slug: string, role: string): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: "pin",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});

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
  // A runner, with the Staff role.
  const u = await raw.query<{ id: string }>(
    "insert into users (name, email) values ('Rae R.', 'rae@example.test') returning id",
  );
  const m = await raw.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status) values ($1, $2, 'staff', 'active') returning id",
    [venueId, u.rows[0]!.id],
  );
  ids["rae"] = u.rows[0]!.id;
  ids["rae.membership"] = m.rows[0]!.id;
  who = as("andy", "manager");
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => who],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("runs", () => {
  it("Andy's I've got it on o3 reads On its way · Andy; Delivered at 10:52 charges nothing", async () => {
    const o3 = ids["order_o3"]!;
    const before = (await req("GET", `/checks/${ids["chk_room3"]}`)).json().lines_cents;
    const claimed = (await req("POST", `/orders/${o3}/claim`, {})).json().order;
    expect(claimed).toMatchObject({ status: "on_the_way", claimed_by_name: "Andy C." });
    clock.set(Temporal.Instant.from("2026-09-25T22:52:00-04:00"));
    const done = (await req("POST", `/orders/${o3}/deliver`, {})).json().order;
    expect(done).toMatchObject({ status: "delivered", delivered_by_name: "Andy C." });
    // The simulated clock ticks on from 10:52, so the minute is what's checked.
    expect(
      Temporal.Instant.from(done.delivered_at)
        .toZonedDateTimeISO("America/New_York")
        .toString()
        .slice(0, 16),
    ).toBe("2026-09-25T22:52");
    expect((await req("GET", `/checks/${ids["chk_room3"]}`)).json().lines_cents).toBe(before);
  });

  it("a runner returning o4 for no ID: Couldn't serve under Returned, Andy's phone, a refusal logged", async () => {
    who = as("rae", "staff");
    const r = await req("POST", `/orders/${ids["order_o4"]}/return`, { reason: "no_id" });
    expect(r.statusCode).toBe(200);
    expect(r.json().order).toMatchObject({
      status: "returned",
      returned_reason: "no_id",
      returned_by_name: "Rae R.",
    });
    const refusals = await raw.query<{ reason: string; item: string }>(
      "select reason, item from alcohol_refusals where order_id = $1",
      [ids["order_o4"]],
    );
    expect(refusals.rows).toEqual([{ reason: "no_id", item: "Corona" }]);
    const push = await raw.query<{ n: number }>(
      "select count(*)::int as n from jobs where kind = 'push.send' and payload->'message'->>'key' = 'orders.returned.push' and payload->'audience'->>'user_id' = $1",
      [ids["andy"]],
    );
    expect(push.rows[0]!.n).toBe(1);
  });

  it("a runner may not cut off; the manager may", () => {
    expect(defaultPermissions["cutoff.apply"].staff).toBe(false);
    expect(defaultPermissions["cutoff.apply"].manager).toBe(true);
  });

  it("the runner records Room 1's last ID for the order: ID ✓ 4 of 4", async () => {
    who = as("rae", "staff");
    const r = await req("POST", `/sessions/${ids["sess_room1"]}/id-checks`, {
      method: "visual",
      order_id: ids["order_o4"],
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ids_checked: 4 });
    const row = await raw.query<{ n: number }>(
      "select count(*)::int as n from id_checks where order_id = $1",
      [ids["order_o4"]],
    );
    expect(row.rows[0]!.n).toBe(1);
  });
});

/** U-11 (D133): "We run our own orders": Accept, Ready and Delivered from Bar orders, no runner. */
describe("We run our own orders (U-11)", () => {
  // Admin → Bar POS saves it (the e2e "U-11 …" goes through Save and publish); here it's written as is.
  const setSelfRun = (on: boolean) =>
    raw.query(
      "update venue_settings set value = value || jsonb_build_object('selfRunOrders', $2::boolean) where venue_id = $1 and key = 'pos'",
      [venueId, on],
    );
  const readyPushes = async (orderId: string) =>
    (
      await raw.query<{ n: number }>(
        "select count(*)::int as n from jobs where kind = 'push.send' and payload->'message'->>'key' = 'orders.push.ready' and payload->'message'->>'tag' = $1",
        [`run-${orderId}`],
      )
    ).rows[0]!.n;

  it("is off by default: the bar's list says so", async () => {
    who = as("andy", "manager");
    const list = (await req("GET", "/orders?status=ready")).json<{ self_run: boolean }>();
    expect(list.self_run).toBe(false);
  });

  it("on: Room 9's order is Accept (the sale), Ready with no runner's push, Delivered charging nothing", async () => {
    who = as("andy", "manager");
    await setSelfRun(true);
    expect((await req("GET", "/orders?status=ready")).json().self_run).toBe(true);
    const o1 = ids["order_o1"]!;
    const before = (await req("GET", `/checks/${ids["chk_room9"]}`)).json().lines_cents;
    expect((await req("POST", `/orders/${o1}/accept`, {})).statusCode).toBe(200);
    const sold = (await req("GET", `/checks/${ids["chk_room9"]}`)).json().lines_cents;
    expect(sold).toBeGreaterThan(before);
    expect((await req("POST", `/orders/${o1}/ready`, {})).json().order.status).toBe("ready");
    expect(await readyPushes(o1)).toBe(0);
    // Straight from Ready to Delivered, no I've got it; the check doesn't move.
    const done = (await req("POST", `/orders/${o1}/deliver`, {})).json().order;
    expect(done).toMatchObject({
      status: "delivered",
      claimed_by: null,
      delivered_by_name: "Andy C.",
    });
    expect((await req("GET", `/checks/${ids["chk_room9"]}`)).json().lines_cents).toBe(sold);
  });

  it("works as the API's own role (app_rw), behind the venue wall", async () => {
    const rw = appPool(db.url);
    try {
      const o2 = ids["order_o2"]!;
      const at = clock.now();
      const input = { userId: ids["andy"]!, now: at };
      const on = await withVenue(rw, { venueId }, (c) => selfRunOrders(c, venueId, at));
      expect(on).toBe(true);
      for (const step of ["accept", "ready", "deliver"] as const)
        await withVenue(rw, { venueId }, (c) => stepOrder(c, venueId, o2, step, input));
      const row = await raw.query<{ status: string }>("select status from orders where id = $1", [
        o2,
      ]);
      expect(row.rows[0]!.status).toBe("delivered");
      expect(await readyPushes(o2)).toBe(0);
      // Another venue's context can't see West 4 at all, let alone its setting.
      const other = "00000000-0000-4000-8000-0000000000aa";
      await expect(
        withVenue(rw, { venueId: other }, (c) => selfRunOrders(c, venueId, at)),
      ).rejects.toThrow("no such venue");
    } finally {
      await rw.end();
    }
  });

  it("off again: the bar's list says so", async () => {
    who = as("andy", "manager");
    await setSelfRun(false);
    expect((await req("GET", "/orders?status=ready")).json().self_run).toBe(false);
  });
});
