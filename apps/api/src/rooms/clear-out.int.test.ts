import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepClearOut } from "./clear-out.js";

/** M3-23 on the simulated clock: the clear-out check at 4:30 AM, once per night, on all three nights. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (iso: string) => Temporal.Instant.from(iso);
const checks = async (date: string) =>
  (
    await raw.query<{ n: number }>(
      "select count(*)::int as n from clear_out_checks where business_date = $1",
      [date],
    )
  ).rows[0]!.n;

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
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
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
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("the clear-out check", () => {
  it("at 4:30 AM the board asks to walk every room and Andy's phone gets it; once only", async () => {
    expect(await sweepClearOut(pool, at("2026-09-26T04:29:59-04:00"))).toBe(0);
    expect(await sweepClearOut(pool, at("2026-09-26T04:30:00-04:00"))).toBe(1);
    expect(await sweepClearOut(pool, at("2026-09-26T04:30:15-04:00"))).toBe(0);
    expect(await sweepClearOut(pool, at("2026-09-26T05:10:00-04:00"))).toBe(0);
    expect(await checks("2026-09-25")).toBe(1);
    const push = await raw.query<{ user_id: string }>(
      "select payload->'audience'->>'user_id' as user_id from jobs where kind = 'push.send' and payload->'message'->>'key' = 'clearOut.push'",
    );
    expect(push.rows).toEqual([{ user_id: ids["andy"] }]);
    clock.set(at("2026-09-26T04:30:05-04:00"));
    const board = (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/board` })).json();
    expect(board.alerts.find((a: { kind: string }) => a.kind === "clear_out")).toMatchObject({
      done: false,
      color: "amber",
    });
  });

  it("Andy's Done at 4:31 AM records Clear-out check · Andy · 4:31 AM", async () => {
    clock.set(at("2026-09-26T04:31:00-04:00"));
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/nights/2026-09-25/clear-out`,
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ done_by_name: "Andy" });
    expect(
      Temporal.Instant.from(r.json().done_at)
        .toZonedDateTimeISO("America/New_York")
        .toString()
        .slice(11, 16),
    ).toBe("04:31");
    const board = (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/board` })).json();
    expect(board.alerts.find((a: { kind: string }) => a.kind === "clear_out")).toMatchObject({
      done: true,
      done_by: "Andy",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/venues/${venueId}/nights/2026-09-25/clear-out`,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
  });

  it("on the daylight-saving nights it's 4:30 AM by the wall clock: EST on Nov 1, EDT on Mar 14", async () => {
    expect(await sweepClearOut(pool, at("2026-11-01T04:29:59-05:00"))).toBe(0);
    expect(await sweepClearOut(pool, at("2026-11-01T04:30:00-05:00"))).toBe(1);
    expect(await checks("2026-10-31")).toBe(1);
    expect(await sweepClearOut(pool, at("2027-03-14T04:29:59-04:00"))).toBe(0);
    expect(await sweepClearOut(pool, at("2027-03-14T04:30:00-04:00"))).toBe(1);
    expect(await checks("2027-03-13")).toBe(1);
  });
});
