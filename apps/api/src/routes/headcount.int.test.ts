import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M2-28 acceptance on the demo seed at 10:41 PM. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
type Count = {
  inside: number;
  in_rooms: number;
  waiting: number;
  door: number;
  limit: number | null;
  warn: boolean;
};
const count = async () => (await req("GET", "/headcount")).json<Count>();
const door = async (delta: 1 | -1) => (await req("POST", "/door-counts", { delta })).json<Count>();

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

describe("the headcount", () => {
  it("with no limit set: 93 inside (77 in rooms, 16 waiting) and no limit number", async () => {
    expect(await count()).toMatchObject({
      inside: 93,
      in_rooms: 77,
      waiting: 16,
      door: 0,
      limit: null,
      warn: false,
    });
  });

  it("a +1 on the door counter makes it 94 at once, and a −1 takes it back", async () => {
    expect(await door(1)).toMatchObject({ inside: 94, door: 1 });
    expect(
      (await raw.query("select 1 from venue_events where type = 'headcount.updated'")).rowCount,
    ).toBe(1);
    expect(await door(-1)).toMatchObject({ inside: 93, door: 0 });
    expect((await req("POST", "/door-counts", { delta: 2 })).statusCode).toBe(400);
  });

  it("with a limit of 100 it warns at 90 inside and not at 89", async () => {
    await raw.query(
      "update venue_settings set value = jsonb_set(value, '{occupancyLimit}', '100') where venue_id = $1 and key = 'safety'",
      [venueId],
    );
    for (let i = 0; i < 4; i++) await door(-1);
    expect(await count()).toMatchObject({ inside: 89, limit: 100, warn: false });
    expect(await door(1)).toMatchObject({ inside: 90, warn: true });
  });
});
