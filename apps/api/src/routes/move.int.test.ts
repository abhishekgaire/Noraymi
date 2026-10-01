import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { hashRoomCode } from "../rooms/checkin.js";

/** M2-18 acceptance on the demo seed at 10:41 PM: Rob & Kim (7) move from Room 7. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string) => Temporal.Instant.from(`2026-09-25T${hhmm}:00-04:00`);
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
type Option = { name: string; ok: boolean; why: string | null; all_night: boolean };

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
  const diego: Principal = {
    kind: "user",
    userId: ids["diego"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["diego.membership"]!, role: "front_desk" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
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

describe("the move sheet", () => {
  it("lists Room 11, free all night, and greys out the other rooms with their reason", async () => {
    const r = await req("GET", `/sessions/${ids["sess_room7"]}/move-options`);
    expect(r.statusCode, r.body).toBe(200);
    const rooms = r.json<{ rooms: Option[] }>().rooms;
    expect(rooms.filter((o) => o.ok).map((o) => o.name)).toEqual(["Room 11"]);
    expect(rooms.find((o) => o.name === "Room 11")).toMatchObject({ all_night: true });
    expect(rooms.filter((o) => !o.ok).every((o) => o.why !== null)).toBe(true);
    const why = Object.fromEntries(rooms.map((o) => [o.name, o.why]));
    expect(why).toMatchObject({
      "Room 1": "too_small",
      "Room 4": "out_of_service",
      "Room 8": "booked_next",
      "Room 9": "in_use",
      "Room 6": "cleaning",
    });
    expect(rooms.map((o) => o.name)).not.toContain("Room 7");
  });

  it("a move into Room 8 answers 409 room_not_free", async () => {
    const r = await req("POST", `/sessions/${ids["sess_room7"]}/move`, { room_id: ids["room_8"] });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: { code: "room_not_free" } });
  });

  it("moving to Room 11 opens a segment there at $70.00 an hour, issues a new code, stops the old one and cleans Room 7 for the Parks; the check keeps every line", async () => {
    const before = (
      await raw.query<{ room_code_hash: string; token_version: number; check_id: string }>(
        "select room_code_hash, token_version, check_id from room_sessions where id = $1",
        [ids["sess_room7"]],
      )
    ).rows[0]!;
    const lines = async () =>
      (
        await raw.query("select id from check_lines where check_id = $1 order by id", [
          before.check_id,
        ])
      ).rows;
    const linesBefore = await lines();
    const r = await req("POST", `/sessions/${ids["sess_room7"]}/move`, { room_id: ids["room_11"] });
    expect(r.statusCode, r.body).toBe(200);
    const moved = r.json<{ room_code: string; hourly_cents: number; to_room: { name: string } }>();
    expect(moved.to_room.name).toBe("Room 11");
    expect(moved.hourly_cents).toBe(7000);
    expect(moved.room_code).toMatch(/^[A-Z2-9]{5}$/);
    expect(moved.room_code).not.toMatch(/1/);
    const after = (
      await raw.query<{
        room_id: string;
        room_code_hash: string;
        token_version: number;
        check_id: string;
      }>(
        "select room_id, room_code_hash, token_version, check_id from room_sessions where id = $1",
        [ids["sess_room7"]],
      )
    ).rows[0]!;
    expect(after.room_id).toBe(ids["room_11"]);
    expect(after.room_code_hash).toBe(hashRoomCode(venueId, moved.room_code));
    expect(after.room_code_hash).not.toBe(before.room_code_hash);
    expect(after.token_version).toBe(before.token_version + 1);
    expect(after.check_id).toBe(before.check_id);
    expect(await lines()).toEqual(linesBefore);
    const segs = await raw.query<{
      room_id: string;
      hourly_cents: number;
      started_at: Date;
      ended_at: Date | null;
    }>(
      "select room_id, hourly_cents, started_at, ended_at from session_segments where session_id = $1 order by started_at",
      [ids["sess_room7"]],
    );
    expect(segs.rows.map((s) => [s.room_id, s.hourly_cents])).toEqual([
      [ids["room_7"], 7000],
      [ids["room_11"], 7000],
    ]);
    expect(segs.rows[1]!.started_at.toISOString()).toBe(
      new Date(at("22:41").epochMilliseconds).toISOString(),
    );
    // Room 7 goes to cleaning; the Parks' 11:00 PM booking stays where it was.
    const parks = await raw.query<{ room_id: string }>(
      "select room_id from bookings where id = $1",
      [ids["bk_parks"]],
    );
    expect(parks.rows[0]!.room_id).toBe(ids["room_7"]);
    const avail = (await req("GET", "/rooms/availability")).json<{
      rooms: { name: string; state: string; current: { kind: string } | null }[];
    }>().rooms;
    expect(avail.find((x) => x.name === "Room 7")).toMatchObject({
      state: "cleaning",
      current: { kind: "cleaning" },
    });
    expect(avail.find((x) => x.name === "Room 11")).toMatchObject({
      state: "in_use",
      current: { kind: "session" },
    });
    const events = await raw.query(
      "select type from venue_events where entity_id = $1 and type = 'session.moved' and room_id = $2",
      [ids["sess_room7"], ids["room_7"]],
    );
    expect(events.rowCount).toBe(1);
  });
});
