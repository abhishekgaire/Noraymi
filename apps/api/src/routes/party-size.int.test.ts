import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { decide } from "../approvals/service.js";
import type { Principal } from "../http/principal.js";

/** M2-17 acceptance on the demo seed and the simulated clock. */
let db: TestDatabase;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string) => Temporal.Instant.from(`2026-09-25T${hhmm}:00-04:00`);
/**
 * A lower party size after the gratuity applies waits for approval (M4-23): Andy asks, Abhishek
 * approves, and the size changes from that minute; asking for the same size again reads the rate.
 */
const lower = async (session: string, size: number) => {
  const asked = await req("POST", `/sessions/${session}/party-size`, { party_size: size });
  expect(asked.statusCode, asked.body).toBe(202);
  const pool = appPool(db.url);
  try {
    await withVenue(pool, { venueId }, (c) =>
      decide(c, venueId, asked.json().approval_id, {
        decision: "approve",
        userId: ids["abhishek"]!,
        deviceId: randomUUID(),
        at: clock.now(),
      }),
    );
  } finally {
    await pool.end();
  }
  return req("POST", `/sessions/${session}/party-size`, { party_size: size });
};
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
type View = {
  room_time_cents: number;
  party_size: number;
  ids_checked: number;
  segments: {
    started_at: string;
    ended_at: string | null;
    hourly_cents: number;
    billable_guests: number;
  }[];
};
const view = async (sessionId: string) =>
  (await req("GET", `/sessions/${sessionId}`)).json<{ session: View }>().session;
const minutes = (s: View["segments"][number]) =>
  Temporal.Instant.from(s.started_at).until(Temporal.Instant.from(s.ended_at!)).total("minutes");

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  const raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  await raw.end();
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => andy],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe("party size", () => {
  it("raising Room 9 from 12 to 14 at 10:41 PM closes the 161-minute segment at $140.00 an hour; at 11:11 PM room time is $392.00, and the chip reads 12 of 14", async () => {
    clock.set(at("22:41"));
    const r = await req("POST", `/sessions/${ids["sess_room9"]}/party-size`, { party_size: 14 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      party_size: 14,
      billable_guests: 14,
      hourly_cents: 14000,
      ids_checked: 12,
    });
    const v = await view(ids["sess_room9"]!);
    expect(v.segments).toHaveLength(2);
    expect(minutes(v.segments[0]!)).toBe(161);
    expect(v.segments[1]).toMatchObject({
      hourly_cents: 14000,
      billable_guests: 14,
      ended_at: null,
    });
    clock.set(at("23:11"));
    const later = await view(ids["sess_room9"]!);
    expect(later.room_time_cents).toBe(39200);
    expect([later.ids_checked, later.party_size]).toEqual([12, 14]);
  });

  it("lowering Sam O.'s party from 3 to 2 on a Friday still bills the minimum of 4, at $40.00 an hour", async () => {
    clock.set(at("22:44"));
    const checkIn = await req("POST", `/bookings/${ids["bk_sam"]}/check-in`, {
      party_size: 3,
      ids_checked: 3,
    });
    expect(checkIn.statusCode, checkIn.body).toBe(201);
    const session = checkIn.json<{ session_id: string }>().session_id;
    clock.set(at("22:50"));
    const r = await lower(session, 2);
    expect(r.json()).toMatchObject({
      party_size: 2,
      min_guests: 4,
      billable_guests: 4,
      hourly_cents: 4000,
    });
  });

  it("Bianca L.'s party going from 22 to 19 in the VIP room changes $250.00 to $190.00 an hour from that minute", async () => {
    clock.set(at("22:52").add({ seconds: 30 }));
    const r = await lower(ids["sess_vip"]!, 19);
    expect(r.json()).toMatchObject({ rate_kind: "per_person", hourly_cents: 19000 });
    const v = await view(ids["sess_vip"]!);
    expect(v.segments.map((s) => s.hourly_cents)).toEqual([25000, 19000]);
    expect(Temporal.Instant.from(v.segments[1]!.started_at).toString()).toBe(
      at("22:52").toString(),
    );
    // Back over 20: the VIP rate again.
    clock.set(at("23:00"));
    expect(
      (await req("POST", `/sessions/${ids["sess_vip"]}/party-size`, { party_size: 21 })).json(),
    ).toMatchObject({ rate_kind: "vip", hourly_cents: 25000 });
  });
});
