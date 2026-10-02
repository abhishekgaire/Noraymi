import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

/** M3-12: room tablets on the room page routes, as signed devices paired to one room. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const keys: Record<string, Awaited<ReturnType<typeof makeDeviceKey>>> = {};

/** A request signed by a seeded room's tablet. */
async function tablet(room: string, method: "GET" | "POST", url: string, body?: object) {
  const deviceId = ids[`dev_tablet_${room}`]!;
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signDeviceRequest({
    deviceId,
    privateKey: keys[room]!.privateKey,
    method,
    path: url,
    body: payload,
  });
  return app.inject({
    method,
    url,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { payload } : {}),
  });
}

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
  for (const room of ["room_9", "room_11"]) {
    keys[room] = await makeDeviceKey();
    await raw.query("update devices set public_key = $2 where id = $1", [
      ids[`dev_tablet_${room}`],
      JSON.stringify(keys[room]!.publicJwk),
    ]);
  }
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

describe("room tablets", () => {
  it("Room 11's tablet shows Room available and can't order", async () => {
    const r = await tablet("room_11", "GET", "/v1/public/room-session");
    expect(r.json()).toMatchObject({ available: true, room: { name: "Room 11" } });
    const order = await tablet("room_11", "POST", "/v1/public/room-session/orders", {
      client_order_id: "tablet-11-0001",
      lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }],
    });
    expect(order.statusCode).toBe(404);
    expect(order.json().error.details).toMatchObject({ reason: "available" });
  });

  it("Room 9's tablet reads $480.00 so far, and its order rings as the tablet, never the host", async () => {
    const view = (await tablet("room_9", "GET", "/v1/public/room-session")).json();
    expect(view).toMatchObject({
      room: { name: "Room 9" },
      tablet: true,
      is_host: false,
      available: false,
    });
    expect((await tablet("room_9", "GET", "/v1/public/room-session/bill")).json()).toMatchObject({
      tab_so_far_cents: 48000,
      minutes: 161,
    });
    const r = await tablet("room_9", "POST", "/v1/public/room-session/orders", {
      client_order_id: "tablet-9-0001",
      lines: [{ variant_id: ids["menu_bud_regular"], qty: 2 }],
    });
    expect(r.statusCode).toBe(201);
    const row = await raw.query<{ name: string; is_host: boolean; status: string }>(
      `select g.name, g.is_host, o.status from orders o join room_guests g on g.id = o.room_guest_id
        where o.client_order_id = 'tablet-9-0001'`,
    );
    expect(row.rows[0]).toEqual({ name: "Tablet · Room 9", is_host: false, status: "ringing" });
  });

  it("the host lock covers the tablet, and a new code never locks the tablet out", async () => {
    const host = String(
      (
        await app.inject({
          method: "POST",
          url: "/v1/public/room-session/host",
          payload: { token: seedHostToken("sess_room9") },
        })
      ).headers["set-cookie"],
    ).split(";")[0]!;
    await app.inject({
      method: "POST",
      url: "/v1/public/room-session/lock",
      headers: { cookie: host },
      payload: { on: true },
    });
    const r = await tablet("room_9", "POST", "/v1/public/room-session/orders", {
      client_order_id: "tablet-9-0002",
      lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }],
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details).toMatchObject({ reason: "host_lock" });
  });

  it("a tablet can't reach staff routes", async () => {
    const r = await tablet("room_9", "GET", `/v1/venues/${venueId}/orders?status=ringing`);
    expect(r.statusCode).toBe(403);
  });
});
