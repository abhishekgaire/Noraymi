import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepQuietDevices } from "../jobs/device-watch.js";
import { barConnected, barLost } from "./bar-presence.js";

/** M3-17 on the simulated clock: the bar computer drops, during opening hours and after the close. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);

const barPushes = async () =>
  (
    await raw.query<{ role: string }>(
      "select payload->'audience'->>'kind' as role from jobs where kind = 'push.send' and payload->'message'->>'key' = 'bar.lost.push'",
    )
  ).rows.map((r) => r.role);
const noBarAlert = async () =>
  (
    (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/board` })).json() as {
      alerts: { kind: string; color: string }[];
    }
  ).alerts.find((a) => a.kind === "no_bar");

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

describe("no bar device connected", () => {
  it("the bar computer's last socket closing at 10:41 PM buzzes the bar phones at once and puts the alert on the board", async () => {
    expect(await noBarAlert()).toBeUndefined();
    const raised = await withVenue(pool, { venueId }, (c) => barLost(c, venueId, SEED_NOW));
    expect(raised).toBe(true);
    // One buzz to the bar-role people on the clock (M7-01).
    expect(await barPushes()).toEqual(["bar_on_clock"]);
    expect(await noBarAlert()).toMatchObject({ color: "pink" });
    // Once per outage.
    expect(await withVenue(pool, { venueId }, (c) => barLost(c, venueId, SEED_NOW))).toBe(false);
    expect(await barPushes()).toHaveLength(1);
  });

  it("reconnecting clears the alert everywhere", async () => {
    expect(await withVenue(pool, { venueId }, (c) => barConnected(c, venueId))).toBe(true);
    expect(await noBarAlert()).toBeUndefined();
    const cleared = await raw.query<{ n: number }>(
      "select count(*)::int as n from venue_events where type = 'bar.connected'",
    );
    expect(cleared.rows[0]!.n).toBe(1);
  });

  it("a bar computer gone quiet is caught by the heartbeat watch too", async () => {
    const later = SEED_NOW.add({ minutes: 3 });
    clock.set(later);
    await sweepQuietDevices(pool, later);
    expect(await noBarAlert()).toMatchObject({ color: "pink" });
    await withVenue(pool, { venueId }, (c) => barConnected(c, venueId));
  });

  it("at 5:00 AM, after the close, nothing is raised", async () => {
    const five = Temporal.Instant.from("2026-09-26T05:00:00-04:00");
    clock.set(five);
    const before = (await barPushes()).length;
    expect(await withVenue(pool, { venueId }, (c) => barLost(c, venueId, five))).toBe(false);
    await sweepQuietDevices(pool, five.add({ minutes: 5 }));
    expect(await barPushes()).toHaveLength(before);
    const lost = await raw.query<{ lost: boolean }>(
      "select lost_at is not null as lost from bar_presence where venue_id = $1",
      [venueId],
    );
    expect(lost.rows[0]?.lost ?? false).toBe(false);
  });
});
