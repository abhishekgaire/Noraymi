import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadDemoSeed, withVenue } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { driveRush, practiceRooms } from "./rush.js";
import { summarize, trialEvidence } from "./trial.js";

/**
 * M9-11: the timed staff trial. The capture is taken only in training; the rush driver places
 * its room orders on practice sessions only; the report finds the taps and the orders.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let apiUrl = "";
let venueId = "";
let ids: Record<string, string> = {};
let config: ReturnType<typeof loadConfig>;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  const maya: Principal = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({
    config,
    clock: new FrozenClock(SEED_NOW),
    moduleCacheMs: 0,
    authenticators: [async (request) => (request.url.startsWith("/v1/public/") ? null : maya)],
    logger: false,
  });
  apiUrl = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

const post = (events: unknown) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/trial-events`,
    payload: { events },
  });
const training = (on: boolean) =>
  owner.query("update memberships set training = $2 where id = $1", [ids["maya.membership"], on]);

describe("the timed staff trial (M9-11)", () => {
  it("takes the capture only in training mode", async () => {
    const at = "2026-09-26T02:41:00Z";
    const live = await post([{ kind: "tap", label: "Pay", screen: "/bar", at }]);
    expect(live.statusCode).toBe(403);
    await training(true);
    expect((await post([])).statusCode).toBe(400);
    const ok = await post([
      { kind: "tap", label: "Repeat round", screen: "/bar", at },
      { kind: "tap", label: "Send", screen: "/bar", at: "2026-09-26T02:41:02Z" },
      { kind: "error", label: "invalid_request", at: "2026-09-26T02:41:03Z" },
    ]);
    expect(ok.statusCode, ok.body).toBe(201);
    const rows = await owner.query<{ membership_id: string; kind: string }>(
      "select membership_id, kind from trial_events where venue_id = $1 order by at",
      [venueId],
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(["tap", "tap", "error"]);
    expect(rows.rows[0]!.membership_id).toBe(ids["maya.membership"]);
    await training(false);
  });

  it("drives room orders onto practice sessions only, and the report times their accept", async () => {
    const none = await withVenue(owner, { venueId, requestId: "t" }, (c) =>
      practiceRooms(c, venueId, config.auth.secretKey),
    );
    expect(none).toEqual([]);
    // One of the night's open rooms becomes a practice session, check and all.
    const s = (
      await owner.query<{ id: string; check_id: string }>(
        `update room_sessions set training = true where id = (
           select id from room_sessions where venue_id = $1 and ended_at is null and room_code_enc is not null
           order by started_at limit 1) returning id, check_id`,
        [venueId],
      )
    ).rows[0]!;
    await owner.query("update checks set training = true where id = $1", [s.check_id]);
    const rooms = await withVenue(owner, { venueId, requestId: "t" }, (c) =>
      practiceRooms(c, venueId, config.auth.secretKey),
    );
    expect(rooms).toHaveLength(1);
    const drive = () =>
      driveRush(
        {
          apiUrl,
          slug: "west4karaoke",
          rooms,
          runId: "test",
          script: [
            { atS: 0, drinks: 1, alcohol: false },
            { atS: 0, drinks: 2, alcohol: true },
          ],
        },
        { sleep: async () => undefined },
      );
    // At a real venue a practice session can't be joined (M7-03): the wall holds for the driver.
    const walled = await drive();
    expect(walled.placed).toBe(0);
    expect(walled.failed[0]).toMatch(/joining Room \d+ answered 404 .*closed/);
    // On a test venue (the staging dry run), the driver's orders go in.
    await owner.query(
      `insert into venue_flags (venue_id, flag, "on", set_by) values ($1, 'synthetic.test_venue', true, $2)`,
      [venueId, ids["abhishek"]],
    );
    const result = await drive();
    expect(result.failed.join("\n")).toBe("");
    expect(result.placed).toBe(2);
    const evidence = await withVenue(owner, { venueId, requestId: "t" }, (c) =>
      trialEvidence(c, venueId, new Date("2026-01-01"), new Date("2027-01-01")),
    );
    expect(evidence.orders).toHaveLength(2);
    expect(evidence.orders.every((o) => o.acceptedAt === null)).toBe(true);
    expect(summarize([], evidence.orders).find((r) => r.id === "accept_room_order")!.met).toBe(
      "no",
    );
    // The capture from the first test: one round on a tab.
    expect(evidence.samples.map((x) => [x.task, x.seconds, x.errors])).toEqual([
      ["another_round", 2, 0],
    ]);
  });
});
