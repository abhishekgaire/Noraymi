import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  decryptSecret,
  generateSigningKey,
  loadDemoSeed,
  nightKey,
  publishRulePack,
  setModuleState,
  withOrgScope,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal, builtInRulePacks } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M2-12 acceptance on the demo seed. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let wrappingKey: Buffer;
let ownerUser = "";
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string) => Temporal.Instant.from(`2026-09-25T${hhmm}:00-04:00`);
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const sessions = async () =>
  (
    (await req("GET", "/sessions")).json() as {
      sessions: { id: string; room_name: string; ids_checked: number; party_size: number }[];
    }
  ).sessions;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
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
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'front_desk'",
      [venueId],
    )
  ).rows[0]!;
  ownerUser = (
    await raw.query<{ user_id: string }>(
      "select user_id from memberships where venue_id = $1 and role = 'owner'",
      [venueId],
    )
  ).rows[0]!.user_id;
  const diego: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: m.id, role: "front_desk" }],
  };
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  wrappingKey = config.auth.secretKey;
  app = buildApp({ config, clock, authenticators: [async () => diego], moduleCacheMs: 0 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("ID checks", () => {
  it("Room 1 reads ID 3 of 4 and Room 5 ID 4 of 4", async () => {
    const list = await sessions();
    expect(list.find((s) => s.room_name === "Room 1")).toMatchObject({
      ids_checked: 3,
      party_size: 4,
    });
    expect(list.find((s) => s.room_name === "Room 5")).toMatchObject({
      ids_checked: 4,
      party_size: 4,
    });
  });

  it("checking in Sam O.'s 3 guests with all 3 IDs checked writes three visual rows", async () => {
    clock.set(at("22:44"));
    const r = await req("POST", `/bookings/${ids["bk_sam"]}/check-in`, {
      party_size: 3,
      ids_checked: 3,
    });
    expect(r.statusCode, r.body).toBe(201);
    const session = (r.json() as { session_id: string }).session_id;
    const rows = await raw.query<{
      method: string;
      checked_by: string;
      scanned_fields: string | null;
    }>("select method, checked_by, scanned_fields from id_checks where session_id = $1", [session]);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((x) => x.method === "visual" && x.scanned_fields === null)).toBe(true);
  });

  it("a scan keeps only the four fields, sealed with West 4's key for Fri Sep 25, deleted after Fri Oct 2", async () => {
    const r = await req("POST", `/sessions/${ids["sess_room1"]}/id-checks`, {
      method: "scan",
      fields: {
        name: "Dana Kim",
        dateOfBirth: "1996-02-11",
        idNumber: "987654321",
        expiration: "2029-02-11",
        address: "1 Main St",
        eyes: "BRO",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ method: "scan", delete_after: "2026-10-02", ids_checked: 4 });
    const row = (
      await raw.query<{ scanned_fields: string; key_id: string; delete_after: string }>(
        "select scanned_fields, key_id, delete_after::text from id_checks where session_id = $1 and method = 'scan'",
        [ids["sess_room1"]],
      )
    ).rows[0]!;
    // Sealed: AES-GCM's three base64url parts (iv, tag, body), not the words. Short words could turn up in
    // random base64 by chance, so the check is on the shape and on the long ID number.
    expect(row.scanned_fields.split(".")).toHaveLength(3);
    expect(row.scanned_fields).not.toContain("987654321");
    expect(row.scanned_fields).not.toContain("dateOfBirth");
    const key = await withVenue(pool, { venueId }, (c) =>
      nightKey(c, venueId, "2026-09-25", wrappingKey),
    );
    expect(key.id).toBe(row.key_id);
    expect(JSON.parse(decryptSecret(key.key, row.scanned_fields))).toEqual({
      name: "Dana Kim",
      dateOfBirth: "1996-02-11",
      idNumber: "987654321",
      expiration: "2029-02-11",
    });
    expect(
      (
        await req("POST", `/sessions/${ids["sess_room1"]}/id-checks`, {
          method: "scan",
          fields: { name: "x" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("an org-scope read of id_checks returns nothing", async () => {
    const seen = await withOrgScope(
      pool,
      { userId: ownerUser },
      async (c) => (await c.query("select id from id_checks")).rowCount,
    );
    expect(seen).toBe(0);
    const keys = await withOrgScope(
      pool,
      { userId: ownerUser },
      async (c) => (await c.query("select id from id_scan_keys")).rowCount,
    );
    expect(keys).toBe(0);
  });

  it("with Safety & ID records off, scanning is refused and Room 5 still reads ID 4 of 4", async () => {
    await withVenue(pool, { venueId }, (c) =>
      setModuleState(c, venueId, "safety", "off", undefined),
    );
    const r = await req("POST", `/sessions/${ids["sess_room5"]}/id-checks`, {
      method: "scan",
      fields: { name: "A B", dateOfBirth: "1990-01-01", idNumber: "1", expiration: "2030-01-01" },
    });
    expect(r.statusCode).toBe(404);
    expect((await sessions()).find((s) => s.room_name === "Room 5")).toMatchObject({
      ids_checked: 4,
      party_size: 4,
    });
    expect(
      (await req("POST", `/sessions/${ids["sess_room7"]}/id-checks`, { method: "visual" }))
        .statusCode,
    ).toBe(201);
    await withVenue(pool, { venueId }, (c) =>
      setModuleState(c, venueId, "safety", "on", undefined),
    );
  });
});
