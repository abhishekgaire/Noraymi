import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { setModuleAllowed, setModuleState, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * M2-04: rooms and room states. The owner creates West 4's 14 rooms in four
 * tiers and switches Room 4 off; archiving hides a room from the list and
 * keeps its row; with Rooms & room clock off every route answers 404.
 */
let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let pool: pg.Pool;
const clock = new FrozenClock(SEED_NOW);
const owner = (venueId: string, membershipId: string, userId: string): Principal => ({
  kind: "user",
  userId,
  session: "passkey",
  memberships: [{ venueId, membershipId, role: "owner" }],
});
let who: Principal;
const call = (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/venues/${v.venueA}${path}`, payload: payload as never });
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

const tiers: [string, number, number, number, number][] = [
  ["small", 1, 5, 3, 6],
  ["medium", 6, 10, 6, 12],
  ["large", 11, 13, 12, 20],
];

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  who = owner(v.venueA, v.membershipA, v.ownerA);
  // The test venues start with no modules; West 4 has Rooms & room clock on.
  await withVenue(pool, { venueId: v.venueA }, async (c) => {
    await setModuleAllowed(c, v.venueA, "rooms", true, undefined);
    await setModuleState(c, v.venueA, "rooms", "on", undefined);
  });
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({ config, clock, authenticators: [async () => who], moduleCacheMs: 0 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe("rooms", () => {
  const ids: Record<string, string> = {};

  it("West 4's 14 rooms in four tiers, and Room 4 switched off", async () => {
    for (const [tier, from, to, min, max] of tiers) {
      for (let n = from; n <= to; n++) {
        const r = await call("POST", "/rooms", {
          name: `Room ${n}`,
          size_tier: tier,
          capacity_min: min,
          capacity_max: max,
        });
        expect(r.statusCode, r.body).toBe(201);
        ids[`Room ${n}`] = (json(r)["room"] as { id: string }).id;
      }
    }
    const vip = await call("POST", "/rooms", {
      name: "VIP room",
      size_tier: "vip",
      capacity_min: 20,
      capacity_max: 40,
      is_vip: true,
      bookable_online: false,
    });
    expect(vip.statusCode).toBe(201);
    expect(
      (
        await call("POST", "/rooms", {
          name: "Room 4",
          size_tier: "small",
          capacity_min: 3,
          capacity_max: 6,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call("POST", "/rooms", {
          name: "Room X",
          size_tier: "small",
          capacity_min: 6,
          capacity_max: 3,
        })
      ).statusCode,
    ).toBe(400);

    const off = await call("PATCH", `/rooms/${ids["Room 4"]}/state`, {
      state: "out_of_service",
      reason: "Switched off",
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(json(off)).toMatchObject({
      room: { state: "out_of_service", state_reason: "Switched off" },
      reassigned: { moved: [], unplaced: [] },
    });

    const list = json(await call("GET", "/rooms"))["rooms"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(14);
    expect(list.map((r) => r["name"])).toEqual([
      ...Array.from({ length: 13 }, (_, i) => `Room ${i + 1}`),
      "VIP room",
    ]);
    const byTier = (t: string) => list.filter((r) => r["size_tier"] === t);
    expect(byTier("small").map((r) => [r["capacity_min"], r["capacity_max"]])).toEqual(
      Array(5).fill([3, 6]),
    );
    expect(byTier("medium")).toHaveLength(5);
    expect(byTier("large")).toHaveLength(3);
    expect(byTier("vip")[0]).toMatchObject({ capacity_min: 20, capacity_max: 40, is_vip: true });
    expect(list.find((r) => r["name"] === "Room 4")).toMatchObject({ state: "out_of_service" });
    expect(list.filter((r) => r["state"] === "available")).toHaveLength(13);
  });

  it("archiving a room hides it from the list and keeps its history; nothing deletes it", async () => {
    const r = await call("PATCH", `/rooms/${ids["Room 13"]}`, { archived: true });
    expect(r.statusCode, r.body).toBe(200);
    expect((json(r)["room"] as { archived_at: string }).archived_at).toBeTruthy();
    const live = json(await call("GET", "/rooms"))["rooms"] as Array<{ name: string }>;
    expect(live.map((x) => x.name)).not.toContain("Room 13");
    const all = json(await call("GET", "/rooms?all=1"))["rooms"] as Array<{ name: string }>;
    expect(all.map((x) => x.name)).toContain("Room 13");
    expect(
      (await call("PATCH", `/rooms/${ids["Room 13"]}/state`, { state: "available" })).statusCode,
    ).toBe(400);
    const audit = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query(
        "select 1 from audit_log where venue_id = $1 and target = $2 and action = 'rooms.update' and 'archived_at' = any(changed_fields)",
        [v.venueA, `rooms/${ids["Room 13"]}`],
      ),
    );
    expect(audit.rowCount).toBe(1);
    // Back from the archive, the room is a room again.
    expect((await call("PATCH", `/rooms/${ids["Room 13"]}`, { archived: false })).statusCode).toBe(
      200,
    );
  });

  it("edits: rename, capacity, cleaning minutes (null means the venue's default), VIP and bookable online", async () => {
    const r = await call("PATCH", `/rooms/${ids["Room 1"]}`, {
      name: "Room 1A",
      capacity_max: 7,
      cleaning_min: 20,
      bookable_online: false,
    });
    expect(json(r)["room"]).toMatchObject({
      name: "Room 1A",
      capacity_max: 7,
      cleaning_min: 20,
      bookable_online: false,
    });
    expect(
      json(await call("PATCH", `/rooms/${ids["Room 1"]}`, { cleaning_min: null }))["room"],
    ).toMatchObject({ cleaning_min: null });
    expect((await call("PATCH", `/rooms/${ids["Room 1"]}`, { capacity_max: 1 })).statusCode).toBe(
      400,
    );
    expect((await call("PATCH", `/rooms/${ids["Room 1"]}`, { name: "Room 2" })).statusCode).toBe(
      400,
    );
    expect((await call("PATCH", `/rooms/${ids["Room 1"]}`, {})).statusCode).toBe(400);
    expect(
      (await call("PATCH", "/rooms/00000000-0000-4000-8000-000000000000", { name: "x" }))
        .statusCode,
    ).toBe(404);
  });

  it("with Rooms & room clock off, every route here answers 404 module_off", async () => {
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      setModuleState(c, v.venueA, "rooms", "off", undefined),
    );
    for (const [method, path, body] of [
      ["GET", "/rooms", undefined],
      ["POST", "/rooms", { name: "Z", size_tier: "small", capacity_min: 1, capacity_max: 2 }],
      ["PATCH", `/rooms/${ids["Room 1"]}`, { name: "Z" }],
      ["PATCH", `/rooms/${ids["Room 1"]}/state`, { state: "cleaning" }],
    ] as const) {
      const r = await call(method, path, body);
      expect(r.statusCode, `${method} ${path}`).toBe(404);
      expect(json(r)["error"]).toMatchObject({ code: "module_off" });
    }
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      setModuleState(c, v.venueA, "rooms", "on", undefined),
    );
  });
});
