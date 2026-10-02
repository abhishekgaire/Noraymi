import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

/** M3-10: tonight so far, the stay and wrap-up lines, Call staff and the host lock. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;
const as = (cookie: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/public/room-session${url}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
const hostOf = async (session: string) =>
  cookieOf(
    (
      await app.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken(session) },
      })
    ).headers["set-cookie"],
  );

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
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("the room page's bill, calls and host lock", () => {
  it("Room 9 so far: 161 min $322.00, drinks $158.00, $480.00, $2.00 a minute for 12, $120 deposit, stay on until 4 AM", async () => {
    const bill = (await as(await hostOf("sess_room9"), "GET", "/bill")).json();
    expect(bill).toMatchObject({
      minutes: 161,
      room_time_cents: 32200,
      drinks_cents: 15800,
      tab_so_far_cents: 48000,
      per_minute_cents: 200,
      party_size: 12,
      deposit_cents: 12000,
      wrap_up_at: null,
    });
    expect(Temporal.Instant.from(bill.stay_on_until).toString()).toBe(
      Temporal.Instant.from("2026-09-26T04:00:00-04:00").toString(),
    );
  });

  it("Room 3's page has the wrap-up time for the party at 11:00 PM", async () => {
    const bill = (await as(await hostOf("sess_room3"), "GET", "/bill")).json();
    expect(bill.stay_on_until).toBeNull();
    expect(Temporal.Instant.from(bill.wrap_up_at).toString()).toBe(
      Temporal.Instant.from("2026-09-25T23:00:00-04:00").toString(),
    );
  });

  it("a call for another mic reaches the board", async () => {
    const r = await as(await hostOf("sess_room9"), "POST", "/calls", { kind: "mic" });
    expect(r.statusCode).toBe(201);
    const calls = await raw.query<{ n: number }>(
      "select count(*)::int as n from room_calls where session_id = $1 and acked_at is null",
      [ids["sess_room9"]],
    );
    expect(calls.rows[0]!.n).toBe(2);
    const pushes = await raw.query<{ n: number }>(
      "select count(*)::int as n from jobs where kind = 'push.send' and payload->'message'->>'key' = 'calls.push.mic'",
    );
    expect(pushes.rows[0]!.n).toBeGreaterThan(0);
  });

  it("with Marcus's host lock on, a friend's order is refused and the page names Marcus", async () => {
    const marcus = await hostOf("sess_room9");
    const friendJoin = await app.inject({
      method: "POST",
      url: `/v1/public/venues/west4karaoke/rooms/${ids["room_9"]}/join`,
      payload: { code: "KX4M7" },
    });
    let friend = cookieOf(friendJoin.headers["set-cookie"]);
    // Only the host may lock.
    expect((await as(friend, "POST", "/lock", { on: true })).statusCode).toBe(403);
    expect((await as(marcus, "POST", "/lock", { on: true })).json()).toMatchObject({
      host_lock: true,
    });
    // The friend's phone takes its fresh token and sees the lock.
    const view = await as(friend, "GET", "");
    friend = cookieOf(view.headers["set-cookie"]);
    expect(view.json()).toMatchObject({ host_lock: true, host_name: "Marcus", is_host: false });
    expect(view.json().code).not.toBe("KX4M7");
    const order = {
      client_order_id: "lock-test-0001",
      lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }],
    };
    const refused = await as(friend, "POST", "/orders", order);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toMatchObject({ reason: "host_lock" });
    // Marcus still orders; unlocking lets the friend order again.
    expect(
      (await as(marcus, "POST", "/orders", { ...order, client_order_id: "lock-test-0002" }))
        .statusCode,
    ).toBe(201);
    await as(marcus, "POST", "/lock", { on: false });
    expect((await as(friend, "POST", "/orders", order)).statusCode).toBe(201);
  });
});

describe("Same again", () => {
  it("after o3 is delivered, Room 3 lists 2 × Margarita · Peach and 1 × Margarita · Strawberry for $39.00", async () => {
    await raw.query("update orders set status = 'delivered', delivered_at = now() where id = $1", [
      ids["order_o3"],
    ]);
    const host = await hostOf("sess_room3");
    const rounds = (await as(host, "GET", "/same-again")).json().rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      order_id: ids["order_o3"],
      total_cents: 3900,
      left_out: [],
      lines: [
        { name: "Margarita", options: ["Peach"], qty: 2, unit_cents: 1300 },
        { name: "Margarita", options: ["Strawberry"], qty: 1, unit_cents: 1300 },
      ],
    });
    const r = await as(host, "POST", "/same-again", {
      order_id: ids["order_o3"],
      client_order_id: "again-o3-0001",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().order).toMatchObject({
      status: "ringing",
      same_again_of: ids["order_o3"],
      amount_cents: 3900,
    });
  });

  it("a round with something 86'd tonight is offered without it, and says so", async () => {
    await raw.query(
      `update menu_options set out_until = '2026-09-26T10:00:00Z'
        where name = 'Strawberry' and item_id = (select id from menu_items where name = 'Margarita')`,
    );
    const rounds = (await as(await hostOf("sess_room3"), "GET", "/same-again")).json().rounds;
    expect(rounds[0]).toMatchObject({
      total_cents: 2600,
      left_out: [{ name: "Margarita · Strawberry", reason: "out_tonight" }],
    });
    expect(rounds[0].lines).toHaveLength(1);
  });
});
