import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken, seedRoomCode } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M3-08 acceptance on the demo seed: the host link, a friend with KX4M7, wrong codes, a closed room, a move. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const SLUG = "west4karaoke";
const cookieOf = (setCookie: string | string[] | undefined) =>
  String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0]!;
const join = (room: string, code: string) =>
  app.inject({
    method: "POST",
    url: `/v1/public/venues/${SLUG}/rooms/${ids[room]}/join`,
    payload: { code },
  });
const mine = (cookie: string) =>
  app.inject({ method: "GET", url: "/v1/public/room-session", headers: { cookie } });

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
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async (request) => (request.url.startsWith("/v1/venues/") ? andy : undefined)],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("joining a room", () => {
  let friend = "";

  it("Marcus T.'s Room code link joins him as Room 9's host, on an httpOnly 128-bit cookie", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/public/room-session/host",
      payload: { token: seedHostToken("sess_room9") },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ is_host: true, room_name: "Room 9" });
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["cache-control"]).toBe("no-store");
    const set = String(r.headers["set-cookie"]);
    expect(set).toMatch(/HttpOnly/);
    const token = cookieOf(r.headers["set-cookie"]).split("=")[1]!;
    expect(Buffer.from(token, "base64url").length).toBe(16);
    const me = await mine(cookieOf(r.headers["set-cookie"]));
    expect(me.json()).toMatchObject({
      room: { name: "Room 9" },
      code: "KX4M7",
      is_host: true,
      moved: null,
    });
    expect(me.headers["cache-control"]).toBe("no-store");
  });

  it("a friend who types KX4M7 joins Room 9 as a friend, with no-referrer and no-store", async () => {
    const r = await join("room_9", "kx4m7");
    expect(r.statusCode).toBe(201);
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["cache-control"]).toBe("no-store");
    friend = cookieOf(r.headers["set-cookie"]);
    expect((await mine(friend)).json()).toMatchObject({ is_host: false, code: "KX4M7" });
  });

  it("a wrong code says so; the tenth rotates Room 9's code and alerts the board and Andy's phone", async () => {
    const pushes = async () =>
      (
        await raw.query<{ n: number }>(
          "select count(*)::int as n from jobs where kind = 'push.send'",
        )
      ).rows[0]!.n;
    const before = await pushes();
    for (let n = 1; n <= 10; n++) {
      const r = await join("room_9", "QQQQQ");
      expect(r.statusCode, `try ${n}`).toBe(400);
      expect(r.json().error.details).toMatchObject({ reason: "wrong_code" });
    }
    expect(await pushes()).toBe(before + 1);
    const board = (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/board` })).json<{
      alerts: { kind: string; room_name: string }[];
    }>();
    expect(board.alerts.find((a) => a.kind === "code")).toMatchObject({ room_name: "Room 9" });
    // The old code stops working; the friend's phone gets a fresh token and the new code.
    expect((await join("room_9", "KX4M7")).statusCode).toBe(400);
    const me = await mine(friend);
    expect(me.json()).toMatchObject({ rotated: true, moved: null });
    expect(me.json().code).toMatch(/^[A-Z2-9]{5}$/);
    expect(me.json().code).not.toBe("KX4M7");
    friend = cookieOf(me.headers["set-cookie"]);
    expect((await join("room_9", me.json().code)).statusCode).toBe(201);
    expect((await mine(friend)).json()).toMatchObject({ rotated: false });
  });

  it("Room 11 has no session: its page says it's closed", async () => {
    const page = await app.inject({
      method: "GET",
      url: `/v1/public/venues/${SLUG}/rooms/${ids["room_11"]}`,
    });
    expect(page.json()).toMatchObject({ room_name: "Room 11", open: false });
    const r = await join("room_11", "ABCDE");
    expect(r.statusCode).toBe(404);
    expect(r.json().error.details).toMatchObject({ reason: "closed" });
  });

  it("after Rob & Kim move to Room 11, the old code stops working and joined phones are told", async () => {
    const oldCode = seedRoomCode("sess_room7", "Room 7");
    const joined = await join("room_7", oldCode);
    expect(joined.statusCode).toBe(201);
    const phone = cookieOf(joined.headers["set-cookie"]);
    const move = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/sessions/${ids["sess_room7"]}/move`,
      payload: { room_id: ids["room_11"] },
    });
    expect(move.statusCode).toBe(200);
    expect((await join("room_7", oldCode)).statusCode).toBe(404);
    expect((await join("room_11", oldCode)).statusCode).toBe(400);
    const me = await mine(phone);
    expect(me.json()).toMatchObject({
      room: { name: "Room 11" },
      moved: { from: "Room 7", to: "Room 11" },
      rotated: true,
    });
    expect(me.json().code).not.toBe(oldCode);
    expect((await join("room_11", me.json().code)).statusCode).toBe(201);
  });

  it("an unknown or expired host link says so", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/public/room-session/host",
      payload: { token: "x".repeat(32) },
    });
    expect(r.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/public/room-session" })).statusCode).toBe(
      403,
    );
  });
});
