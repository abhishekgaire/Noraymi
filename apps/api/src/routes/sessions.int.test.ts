import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal, t } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepWrapUps } from "../jobs/wrap-up-sweep.js";

/**
 * M2-07 acceptance on the demo seed and the simulated clock: the room clocks
 * at 10:41 PM, Room 10 staying on, a mistaken end and resume, and the close.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string, day = "2026-09-25") => Temporal.Instant.from(`${day}T${hhmm}:00-04:00`);
type S = {
  id: string;
  room_name: string;
  minutes: number;
  room_time_cents: number;
  tile: Record<string, unknown>;
  stay_on_offer: boolean;
  wrap_up: boolean;
  check_id: string;
};
const sessions = async () =>
  (
    JSON.parse(
      (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/sessions` })).body,
    ) as { sessions: S[] }
  ).sessions;
const room = (list: S[], name: string) => list.find((s) => s.room_name === name)!;

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
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({ config, clock, authenticators: [async () => diego], moduleCacheMs: 0 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("the room clock", () => {
  it("at 10:41 PM: Room 9 161 minutes and $322.00, the VIP room 71 and $295.83, Room 5 41 and $40.00", async () => {
    clock.set(at("22:41"));
    const list = await sessions();
    expect(list).toHaveLength(8);
    expect(room(list, "Room 9")).toMatchObject({
      minutes: 161,
      room_time_cents: 32200,
      tile: { kind: "in_room", minutesLeft: 19 },
    });
    expect(room(list, "VIP room")).toMatchObject({ minutes: 71, room_time_cents: 29583 });
    expect(room(list, "Room 5")).toMatchObject({ minutes: 41, room_time_cents: 4000 });
  });

  it("Room 10 reads 'Staying · 41 min past', keeps billing, and offers to stay on by the minute until 4 AM", async () => {
    clock.set(at("22:41"));
    const r10 = room(await sessions(), "Room 10");
    expect(r10).toMatchObject({
      minutes: 221,
      room_time_cents: 33150,
      tile: { kind: "staying", minutesPast: 41 },
      stay_on_offer: true,
      wrap_up: false,
    });
    expect(t("en", "session.staying", { min: 41 })).toBe("Staying · 41 min past");
    expect(t("en", "session.stayOn", { time: "4 AM" })).toBe(
      "Stay on by the minute until we close at 4 AM",
    );
    clock.set(at("22:46"));
    expect(room(await sessions(), "Room 10")).toMatchObject({
      minutes: 226,
      room_time_cents: 33900,
    });
    // Room 7 is needed now: the Parks are booked at 11:00.
    expect(room(await sessions(), "Room 7")).toMatchObject({
      tile: { kind: "needed_now" },
      stay_on_offer: false,
      wrap_up: true,
    });
  });

  it("ending Room 5 by mistake at 10:50 PM and resuming at 10:55 PM keeps its code and check, and bills straight through", async () => {
    const r5 = room(await sessions(), "Room 5");
    const before = await raw.query<{
      room_code_hash: string | null;
      check_id: string;
      token_version: number;
    }>("select room_code_hash, check_id, token_version from room_sessions where id = $1", [r5.id]);
    clock.set(at("22:50"));
    const ended = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/sessions/${r5.id}/end`,
    });
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await sessions()).map((s) => s.room_name)).not.toContain("Room 5");
    expect(
      (await raw.query("select state from room_states where room_id = $1", [ids["room_5"]]))
        .rows[0],
    ).toEqual({ state: "cleaning" });
    clock.set(at("22:55"));
    const resumed = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/sessions/${r5.id}/resume`,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    const after = await raw.query(
      "select room_code_hash, check_id, token_version from room_sessions where id = $1",
      [r5.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(
      (await raw.query("select state from room_states where room_id = $1", [ids["room_5"]]))
        .rows[0],
    ).toEqual({ state: "in_use" });
    clock.set(at("23:00"));
    // 10:00 PM to 11:00 PM straight through: 60 minutes, $40.00, one segment.
    const r = room(await sessions(), "Room 5");
    expect(r).toMatchObject({ minutes: 60, room_time_cents: 4000 });
    expect(
      (
        await raw.query("select count(*)::int as n from session_segments where session_id = $1", [
          r5.id,
        ])
      ).rows[0],
    ).toEqual({ n: 1 });
    // Too late: a resume more than 10 minutes after the end is refused.
    clock.set(at("23:05"));
    await app.inject({ method: "POST", url: `/v1/venues/${venueId}/sessions/${r5.id}/end` });
    clock.set(at("23:16"));
    expect(
      (await app.inject({ method: "POST", url: `/v1/venues/${venueId}/sessions/${r5.id}/resume` }))
        .statusCode,
    ).toBe(400);
  });

  it("at 3:30 AM no session offers to stay on, and at the 4:00 AM close every room is in wrap-up", async () => {
    clock.set(at("03:30", "2026-09-26"));
    const late = await sessions();
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((s) => !s.stay_on_offer)).toBe(true);
    clock.set(at("04:00", "2026-09-26"));
    const closing = await sessions();
    expect(closing.every((s) => s.wrap_up)).toBe(true);
    await sweepWrapUps(pool, at("04:00", "2026-09-26"));
    const states = await raw.query<{ state: string }>(
      "select st.state from room_sessions s join room_states st on st.room_id = s.room_id where s.venue_id = $1 and s.ended_at is null",
      [venueId],
    );
    expect(states.rows.length).toBe(closing.length);
    expect(states.rows.every((r) => r.state === "wrap_up")).toBe(true);
  });
});
