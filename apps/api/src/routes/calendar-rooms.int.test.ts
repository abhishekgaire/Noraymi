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
 * U-13: the Calendar's New booking lists only the rooms that fit the party and are free for the
 * whole booking, read as the API runs (app_rw, row-level security forced) by the front desk, on
 * the demo seed at 10:41 PM. The server still refuses a room too small or a time already past.
 */
interface Free {
  past_close: boolean;
  rooms: { room_id: string; name: string; capacity_min: number; capacity_max: number }[];
}

let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId: string;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
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

/** 9:00 PM on Sat Sep 26, 2026 in New York (EDT). */
const SAT_9PM = "2026-09-27T01:00:00Z";
const free = async (party: number, from: string, minutes: number) => {
  const r = await app.inject({
    method: "GET",
    url: `/v1/venues/${venueId}/rooms/free?party=${party}&from=${encodeURIComponent(from)}&minutes=${minutes}`,
  });
  expect(r.statusCode).toBe(200);
  return r.json<Free>();
};
const book = (body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/bookings`,
    payload: {
      guest: { name: "Test Six", phone_e164: "+13475550190" },
      party_size: 6,
      business_date: "2026-09-26",
      time: "21:00",
      hours: 2,
      ...body,
    } as never,
  });

describe("U-13 · New booking on the Calendar, tomorrow at 9 PM for 6 and 2 hours", () => {
  it("lists only rooms that fit 6, smallest first, each with its size", async () => {
    const f = await free(6, SAT_9PM, 120);
    expect(f.past_close).toBe(false);
    expect(f.rooms.length).toBeGreaterThan(0);
    for (const r of f.rooms) expect(r.capacity_max).toBeGreaterThanOrEqual(6);
    const sizes = f.rooms.map((r) => r.capacity_max);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    // A party of 13 sees only the large rooms and the VIP room: the 6s and 12s are too small.
    const big = await free(13, SAT_9PM, 120);
    expect(big.rooms.length).toBeGreaterThan(0);
    for (const r of big.rooms) expect(r.capacity_max).toBeGreaterThanOrEqual(13);
    expect(f.rooms.some((r) => r.capacity_max < 13)).toBe(true);
  });

  it("books the first fitting room, and that room then leaves the list for the same slot", async () => {
    const [first] = (await free(6, SAT_9PM, 120)).rooms;
    const r = await book({ room_id: first!.room_id });
    expect(r.statusCode).toBe(201);
    const again = await free(6, SAT_9PM, 120);
    expect(again.rooms.map((x) => x.room_id)).not.toContain(first!.room_id);
  });

  it("still refuses a room too small for the party, and a time already past", async () => {
    const small = (await free(6, SAT_9PM, 120)).rooms.find((r) => r.capacity_max < 13)!;
    const tooSmall = await book({ room_id: small.room_id, party_size: 13, time: "19:00" });
    expect(tooSmall.statusCode).toBe(400);
    const past = await book({ business_date: "2026-09-25", time: "21:00" });
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({ error: { details: { reason: "past" } } });
  });

  it("says when the length runs past the close", async () => {
    // 3:00 AM on Sun Sep 27 (business date Sat Sep 26) for 2 hours ends after 4:00 AM.
    const f = await free(6, "2026-09-27T07:00:00Z", 120);
    expect(f).toMatchObject({ past_close: true, rooms: [] });
  });
});
