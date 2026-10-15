import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * U-09: the check-in sheet's room chips and + Walk-in's pick, on the demo seed at 10:41 PM, read
 * as the API runs (app_rw, row-level security forced). The fit and the free state come from the
 * server: + Walk-in for 6 gets the smallest free room that fits, as the waitlist's Offer picks it.
 */
interface Choice {
  room_id: string;
  name: string;
  capacity_min: number;
  capacity_max: number;
  ok: boolean;
  why: string | null;
  until: string | null;
}

let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;

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
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'front_desk'",
      [venueId],
    )
  ).rows[0]!;
  const diego: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: m.id, role: "front_desk" }],
  };
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url.replace("//west4:west4@", "//app_rw:app_rw@"),
    }),
    clock: new SimulatedClock(SEED_NOW),
    authenticators: [async () => diego],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

const get = (path: string) => app.inject({ method: "GET", url: `/v1/venues/${venueId}${path}` });
const byName = (rooms: Choice[], name: string) => rooms.find((r) => r.name === name)!;

describe("U-09 · the check-in sheet's rooms at 10:41 PM", () => {
  it("+ Walk-in for 6 picks Room 11, the only free room that fits for an hour", async () => {
    const r = await get("/check-in/preview?walk_in=1&party=6");
    expect(r.statusCode).toBe(200);
    const p = r.json<{
      room_id: string;
      room_name: string;
      room_fits: boolean;
      suggested_room_id: string;
      rooms: Choice[];
    }>();
    expect(p).toMatchObject({
      room_id: ids["room_11"],
      room_name: "Room 11",
      room_fits: true,
      suggested_room_id: ids["room_11"],
    });
    // Every room comes back with its size and the reason it can't take the party now.
    expect(byName(p.rooms, "Room 11")).toMatchObject({
      ok: true,
      why: null,
      capacity_min: 12,
      capacity_max: 20,
    });
    expect(byName(p.rooms, "Room 8")).toMatchObject({ ok: true, capacity_max: 12 });
    expect(byName(p.rooms, "Room 8").until).not.toBeNull(); // the Nguyens at 11:00
    expect(byName(p.rooms, "Room 3")).toMatchObject({ ok: false, why: "in_use" });
    expect(byName(p.rooms, "Room 2")).toMatchObject({ ok: false, why: "held" });
    expect(byName(p.rooms, "Room 6")).toMatchObject({ ok: false, why: "cleaning" });
    expect(byName(p.rooms, "Room 4")).toMatchObject({ ok: false, why: "out_of_service" });
  });

  it("a party too big for every free room gets no pick, and the free rooms say too small", async () => {
    const p = (await get("/check-in/preview?walk_in=1&party=25")).json<{
      room_id: string | null;
      suggested_room_id: string | null;
      room_fits: boolean;
      rooms: Choice[];
    }>();
    expect(p).toMatchObject({ room_id: null, suggested_room_id: null, room_fits: false });
    expect(byName(p.rooms, "Room 11")).toMatchObject({ ok: false, why: "too_small" });
    expect(byName(p.rooms, "VIP room")).toMatchObject({ ok: false, why: "in_use" });
  });

  it("Jae & co.'s room is still in use; Sam O.'s room, held for him, is his to take", async () => {
    const jae = (await get(`/check-in/preview?booking=${ids["bk_jae"]}`)).json<{
      room_name: string;
      rooms: Choice[];
    }>();
    expect(jae.room_name).toBe("Room 3");
    expect(byName(jae.rooms, "Room 3")).toMatchObject({ ok: false, why: "in_use" });
    const sam = (await get(`/check-in/preview?booking=${ids["bk_sam"]}`)).json<{
      rooms: Choice[];
    }>();
    expect(byName(sam.rooms, "Room 2")).toMatchObject({ ok: true, why: null });
  });

  it("asks for a booking, a room or walk_in=1", async () => {
    expect((await get("/check-in/preview")).statusCode).toBe(400);
  });
});
