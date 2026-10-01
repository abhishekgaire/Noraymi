import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal, builtInRulePacks } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M2-34: West 4's prices, and a new version that reaches new sessions only. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const req = (method: "GET" | "POST" | "PUT", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
type Prices = {
  rate: { mode: string; perPersonCents?: number };
  billing: { incrementMin: number; rounding: string };
  minGuests: { weeknight: number; friSat: number };
  firstHourMinimum: boolean;
  bands: unknown[];
  vip: { roomIds: string[]; hourlyCents: number; fromGuests: number } | null;
  damageFeeCents: number;
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  await publishRulePack(raw, {
    pack: builtInRulePacks[0]!,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const owner: Principal = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => owner],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("prices", () => {
  it("West 4: $10 a person an hour by the minute, 3 and 4 guests minimum, a first hour, no bands, VIP $250 from 20, $150 damage", async () => {
    const p = (await req("GET", "/settings/prices")).json<{ value: Prices }>().value;
    expect(p).toMatchObject({
      rate: { mode: "perPerson", perPersonCents: 1000 },
      billing: { incrementMin: 1, rounding: "up" },
      minGuests: { weeknight: 3, friSat: 4 },
      firstHourMinimum: true,
      bands: [],
      vip: { roomIds: [ids["room_vip"]], hourlyCents: 25000, fromGuests: 20 },
      damageFeeCents: 15000,
    });
  });

  it("a band with a 15-minute step saves a new version; sessions that start afterwards bill with it, and running ones keep their rate", async () => {
    const before = (await req("GET", "/settings/prices")).json<{
      value: Prices;
      version: number;
    }>();
    const band = {
      name: "Late night",
      days: [5, 6],
      fromMin: 22 * 60,
      toMin: 26 * 60,
      rate: { mode: "perPerson", perPersonCents: 1500 },
      billing: { incrementMin: 15, rounding: "up" },
    };
    const saved = await req("PUT", "/settings", {
      values: { prices: { ...before.value, bands: [band] } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = (await req("GET", "/settings/prices")).json<{ value: Prices; version: number }>();
    expect(after.version).toBe(before.version + 1);
    clock.set(Temporal.Instant.from("2026-09-25T22:50:00-04:00"));
    const walkIn = await req("POST", `/rooms/${ids["room_11"]}/sessions`, {
      party_size: 4,
      ids_checked: 4,
      minutes: 60,
    });
    expect(walkIn.statusCode, walkIn.body).toBe(201);
    const seg = await raw.query<{ hourly_cents: number; increment_min: number }>(
      "select hourly_cents, increment_min from session_segments where session_id = $1",
      [walkIn.json<{ session_id: string }>().session_id],
    );
    expect(seg.rows).toEqual([{ hourly_cents: 6000, increment_min: 15 }]);
    const room9 = await raw.query<{ hourly_cents: number; increment_min: number }>(
      "select hourly_cents, increment_min from session_segments where session_id = $1",
      [ids["sess_room9"]],
    );
    expect(room9.rows).toEqual([{ hourly_cents: 12000, increment_min: 1 }]);
  });
});
