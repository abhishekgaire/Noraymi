import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withVenue } from "@west4/db";
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
import { route } from "./conventions.js";
import type { Principal } from "./principal.js";

let db: TestDatabase;
let v: TwoVenues;
let calls = 0;
let release: (() => void) | undefined;

function makeApp(): FastifyInstance {
  const owner: Principal = {
    kind: "user",
    userId: v.ownerA,
    session: "passkey",
    memberships: [{ venueId: v.venueA, membershipId: v.membershipA, role: "owner" }],
  };
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  return buildApp({
    config,
    clock: new FrozenClock(SEED_NOW),
    authenticators: [async () => owner],
    staffRateLimit: { max: 5, windowMs: 60_000 },
    extraRoutes: (a) => {
      a.post<{ Body: { name: string } }>(
        "/v1/venues/:venueId/things",
        {
          config: route({
            principals: ["owner_manager"],
            module: "core",
            action: "admin.access",
            idempotency: "required",
          }),
        },
        async (request, reply) => {
          calls += 1;
          if (release) await new Promise<void>((resolve) => (release = resolve));
          return reply.code(201).send({ id: `thing-${calls}`, name: request.body.name });
        },
      );
      a.get(
        "/v1/venues/:venueId/things",
        { config: route({ principals: ["owner_manager"], module: "core" }) },
        async () => ({ items: [] }),
      );
    },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
});

afterAll(async () => {
  await db.drop();
});

describe("Idempotency-Key", () => {
  it("the same POST sent twice with one key does its work once and returns the same answer both times", async () => {
    const app = makeApp();
    // The test's app pool switches to app_rw like the API does.
    const first = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/things`,
      headers: { "idempotency-key": "k1" },
      payload: { name: "A" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/things`,
      headers: { "idempotency-key": "k1" },
      payload: { name: "A" },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(calls).toBe(1);
    await app.close();
  });

  it("the same key with a different body answers 422 key_reused; a copy while the first runs answers 409 in_progress", async () => {
    const app = makeApp();
    const reused = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/things`,
      headers: { "idempotency-key": "k1" },
      payload: { name: "B" },
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe("key_reused");

    // Hold the first request open, send a copy, then let the first finish.
    release = () => {};
    const slow = app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/things`,
      headers: { "idempotency-key": "k2" },
      payload: { name: "C" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const copy = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/things`,
      headers: { "idempotency-key": "k2" },
      payload: { name: "C" },
    });
    expect(copy.statusCode).toBe(409);
    expect(copy.json().error.code).toBe("in_progress");
    expect(copy.json().error.retryable).toBe(true);
    release?.();
    release = undefined;
    expect((await slow).statusCode).toBe(201);
    await app.close();
  });

  it("a replay survives a restart: a new process with the same database answers from the stored response", async () => {
    const before = calls;
    const fresh = makeApp();
    const replayed = await fresh.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/things`,
      headers: { "idempotency-key": "k1" },
      payload: { name: "A" },
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toMatchObject({ id: "thing-1", name: "A" });
    expect(calls).toBe(before);
    await fresh.close();
  });

  it("money routes require the key, and the key row is written before the work starts", async () => {
    const app = makeApp();
    const missing = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/things`,
      payload: { name: "D" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toMatch(/Idempotency-Key is required/);
    const pool = appPool(db.url);
    const rows = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query<{ key: string; state: string; principal_id: string }>(
        "select key, state, principal_id from idempotency_keys order by key",
      ),
    );
    expect(rows.rows).toEqual([
      { key: "k1", state: "done", principal_id: `user:${v.ownerA}` },
      { key: "k2", state: "done", principal_id: `user:${v.ownerA}` },
    ]);
    // Venue B sees none of them.
    const other = await withVenue(pool, { venueId: v.venueB }, (c) =>
      c.query("select key from idempotency_keys"),
    );
    expect(other.rowCount).toBe(0);
    await pool.end();
    await app.close();
  });

  it("staff routes are rate-limited per venue", async () => {
    const app = makeApp();
    const codes: number[] = [];
    for (let i = 0; i < 7; i += 1)
      codes.push(
        (await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/things` })).statusCode,
      );
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
    const limited = await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/things` });
    expect(limited.json().error).toMatchObject({ code: "rate_limited", retryable: true });
    await app.close();
  });
});
