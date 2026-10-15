import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { bellReads, markBellRead } from "./bell.js";

/**
 * P-11: one bell for everything waiting. What's waiting comes from the lists the staff app already
 * reads; the API keeps which of those each person marked read, per person, behind the venue wall,
 * and refuses both routes while the owner has the bell off.
 */
let db: TestDatabase;
let owner: pg.Client;
let rw: pg.Pool;
let app: FastifyInstance;
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
const people = {} as Record<"front_desk" | "bartender", Principal & { kind: "user" }>;
let current: Principal;
const req = (method: "GET" | "POST", payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}/bell/reads`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const keys = async () => (await req("GET")).json<{ keys: string[] }>().keys;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  rw = appPool(db.url);
  for (const role of ["front_desk", "bartender"] as const) {
    const m = (
      await owner.query<{ id: string; user_id: string }>(
        "select id, user_id from memberships where venue_id = $1 and role = $2 limit 1",
        [venueId, role],
      )
    ).rows[0]!;
    people[role] = {
      kind: "user",
      userId: m.user_id,
      session: "pin",
      memberships: [{ venueId, membershipId: m.id, role }],
    };
  }
  current = people.front_desk;
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => current],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rw.end();
  await owner.end();
  await db.drop();
});

describe("the bell's reads", () => {
  it("start empty, and marking read keeps each key once", async () => {
    expect(await keys()).toEqual([]);
    const r = await req("POST", { keys: ["order:o1", "approval:a1", "order:o1"] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ keys: ["order:o1", "approval:a1"] });
    expect((await req("POST", { keys: ["order:o1"] })).statusCode).toBe(200);
    expect((await keys()).sort()).toEqual(["approval:a1", "order:o1"]);
    expect(
      (await owner.query("select 1 from bell_reads where venue_id = $1", [venueId])).rowCount,
    ).toBe(2);
  });

  it("are per person: the bartender's bell still counts what the front desk read", async () => {
    current = people.bartender;
    expect(await keys()).toEqual([]);
    await req("POST", { keys: ["print:j1"] });
    expect(await keys()).toEqual(["print:j1"]);
    current = people.front_desk;
    expect(await keys()).not.toContain("print:j1");
  });

  it("refuses an empty or oversized list", async () => {
    expect((await req("POST", { keys: [] })).statusCode).toBe(400);
    expect((await req("POST", { keys: ["x".repeat(201)] })).statusCode).toBe(400);
    expect((await req("POST", {})).statusCode).toBe(400);
  });

  it("keep the last three days only", async () => {
    clock.advance(Temporal.Duration.from({ hours: 73 }));
    try {
      expect(await keys()).toEqual([]);
    } finally {
      clock.set(SEED_NOW);
    }
    expect((await keys()).length).toBe(2);
  });

  it("work as the API's own role (app_rw), behind the venue wall", async () => {
    const at = SEED_NOW.toString();
    await withVenue(rw, { venueId }, (c) =>
      markBellRead(c, venueId, people.front_desk.userId, ["text:t1:a"], at),
    );
    const mine = await withVenue(rw, { venueId }, (c) =>
      bellReads(c, venueId, people.front_desk.userId, "2026-09-01T00:00:00Z"),
    );
    expect(mine).toContain("text:t1:a");
    // Another venue's context sees none of these rows.
    const other = "00000000-0000-4000-8000-0000000000aa";
    const seen = await withVenue(rw, { venueId: other }, (c) =>
      c.query("select 1 from bell_reads"),
    );
    expect(seen.rowCount).toBe(0);
  });

  it("answer 404 module_off while the owner has the bell off", async () => {
    await owner.query(
      `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'bell', true, 'off')
       on conflict (venue_id, module_id) do update set state = 'off'`,
      [venueId],
    );
    const get = await req("GET");
    expect(get.statusCode).toBe(404);
    expect(get.json<{ error: { code: string } }>().error.code).toBe("module_off");
    expect((await req("POST", { keys: ["order:o9"] })).statusCode).toBe(404);
    await owner.query(
      "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'bell'",
      [venueId],
    );
    expect((await req("GET")).statusCode).toBe(200);
  });
});

/**
 * U-18: the bell's own light read of the rooms, not the whole board. Only the room lines the bell
 * shows (time's up, room calls, a free room for the waitlist, a guest running late), each naming
 * its room so a tap opens that room's panel; no wipe or new-room-code lines.
 */
describe("the bell's room alerts (U-18)", () => {
  type Line = {
    kind: string;
    room_id: string;
    room_name: string;
    words?: { kind: string; minutes_past: number };
  };
  const alerts = () => app.inject({ method: "GET", url: `/v1/venues/${venueId}/bell/alerts` });

  it("lists the rooms whose time is up in the tile's words, and every line names its room", async () => {
    current = people.front_desk;
    const r = await alerts();
    expect(r.statusCode).toBe(200);
    const lines = r.json<{ alerts: Line[] }>().alerts;
    const up = lines.filter((l) => l.kind === "time_up");
    expect(up.map((l) => [l.room_name, l.words])).toEqual([
      ["Room 7", { kind: "needed_now", minutes_past: 11 }],
      ["Room 10", { kind: "staying", minutes_past: 41 }],
    ]);
    // Room 3 is only near its end (Wrap up): on the tile and the strip, not a thing to do.
    expect(lines.some((l) => l.room_name === "Room 3" && l.kind === "time_up")).toBe(false);
    expect(lines.find((l) => l.kind === "offer")).toMatchObject({ room_name: "Room 11" });
    for (const l of lines) {
      expect(["time_up", "call", "offer", "late"]).toContain(l.kind);
      expect(l.room_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const room7 = (
      await owner.query<{ id: string }>(
        "select id from rooms where venue_id = $1 and name = 'Room 7'",
        [venueId],
      )
    ).rows[0]!.id;
    expect(up[0]!.room_id).toBe(room7);
  });

  it("is lighter than the board: no tiles, tabs or guests' names", async () => {
    const body = (await alerts()).json<Record<string, unknown>>();
    expect(body).toHaveProperty("alerts");
    for (const heavy of ["rooms", "counts", "headcount", "alcohol"])
      expect(body).not.toHaveProperty(heavy);
    expect(JSON.stringify(body)).not.toMatch(/Rob & Kim|tab_so_far|guest_name/);
  });

  it("answers 404 module_off while the bell or Rooms is off", async () => {
    for (const module of ["bell", "rooms"]) {
      await owner.query(
        `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, $2, true, 'off')
         on conflict (venue_id, module_id) do update set state = 'off'`,
        [venueId, module],
      );
      try {
        const r = await alerts();
        expect(r.statusCode).toBe(404);
        expect(r.json<{ error: { code: string } }>().error.code).toBe("module_off");
      } finally {
        await owner.query(
          "update venue_modules set state = 'on' where venue_id = $1 and module_id = $2",
          [venueId, module],
        );
      }
    }
    expect((await alerts()).statusCode).toBe(200);
  });
});
