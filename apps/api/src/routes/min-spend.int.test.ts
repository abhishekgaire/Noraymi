import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { presentCheck } from "../rooms/present.js";

/** Minimum spend (M4-27): off at West 4; on a test venue, a $300.00 Friday minimum for Room 11's size. */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(Temporal.Instant.from("2026-09-26T02:46:00Z"));
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const tileOf = async (room: string) =>
  (
    (await req("GET", "/board")).json() as {
      rooms: { room_id: string; session: { min_spend_left_cents: number | null } | null }[];
    }
  ).rooms.find((r) => r.room_id === ids[room])!.session;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  const diego: Principal = {
    kind: "user",
    userId: ids["diego"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["diego.membership"]!, role: "front_desk" }],
  };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => diego],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("minimum spend", () => {
  it("at West 4, no tile has a minimum", async () => {
    const board = (await req("GET", "/board")).json() as {
      rooms: { session: { min_spend_left_cents: number | null } | null }[];
    };
    expect(
      board.rooms.filter((r) => r.session).every((r) => r.session!.min_spend_left_cents === null),
    ).toBe(true);
  });

  it("on a test venue, $216.00 of drinks leaves $84 to the minimum; room time doesn't count; a comp lowers the spend; Present adds the shortfall", async () => {
    const tier = (await owner.query("select size_tier from rooms where id = $1", [ids["room_11"]]))
      .rows[0].size_tier as string;
    await owner.query(
      `update venue_settings set value = jsonb_set(value, '{minSpend}', $1::jsonb) where key = 'prices'`,
      [JSON.stringify([{ tier, days: [5], band: null, cents: 30000 }])],
    );
    const seated = await req("POST", `/bookings/${ids["bk_jae"]}/check-in`, {
      party_size: 5,
      ids_checked: 5,
      room_id: ids["room_11"],
    });
    expect(seated.statusCode, seated.body).toBe(201);
    const checkId = seated.json().check_id as string;
    expect((await tileOf("room_11"))!.min_spend_left_cents).toBe(30000);
    const item = (cents: number, kind = "item") =>
      owner.query(
        `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category, business_date, added_at)
         values ($1, $2, $3, 'Bottle service', 1, $4, $4, 'drink', '2026-09-25', now())`,
        [venueId, checkId, kind, cents],
      );
    await item(21600);
    expect((await tileOf("room_11"))!.min_spend_left_cents).toBe(8400);
    await item(-1600, "comp");
    expect((await tileOf("room_11"))!.min_spend_left_cents).toBe(10000);
    await item(1600, "item");
    await withVenue(app, { venueId }, (c) =>
      presentCheck(c, venueId, checkId, { userId: ids["andy"]!, now: clock.now() }),
    );
    const lines = await owner.query(
      "select kind, amount_cents::int, tax_category from check_lines where check_id = $1 and kind = 'min_spend'",
      [checkId],
    );
    expect(lines.rows).toEqual([{ kind: "min_spend", amount_cents: 8400, tax_category: "fee" }]);
  });
});
