import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { addCheckLine, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M2-14: Maya's reason-only total after the seed, and across two screens. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let maya: { id: string; user_id: string };
let who: Principal;

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
  maya = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'bartender'",
      [venueId],
    )
  ).rows[0]!;
  who = {
    kind: "user",
    userId: maya.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: maya.id, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock: new SimulatedClock(SEED_NOW),
    authenticators: [async () => who],
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

const left = async () =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/reason-only` })).json() as {
    used_cents: number;
    left_cents: number;
  };

describe("the reason-only total per person", () => {
  it("after the seed loads, Maya has used $12.00 (her comp of a Jäger Bomb) and has $63 left", async () => {
    expect(await left()).toMatchObject({ used_cents: 1200, left_cents: 6300 });
  });

  it("counts her comps and voids from every screen: a bar tab and a room check", async () => {
    await withVenue(pool, { venueId }, async (c) => {
      // On Room 9's check (the board or DeskRoom) and on a bar tab (the bar POS).
      await addCheckLine(c, venueId, ids["chk_room9"]!, {
        kind: "comp",
        description: "Comp · Chamisul",
        qty: 1,
        unitCents: -1000,
        amountCents: -1000,
        taxCategory: "drink",
        businessDate: "2026-09-25",
        reason: "Wrong order",
        addedBy: maya.user_id,
      });
      await addCheckLine(c, venueId, ids["chk_t1"]!, {
        kind: "void",
        description: "Void · Corona",
        qty: 1,
        unitCents: -900,
        amountCents: -900,
        taxCategory: "drink",
        businessDate: "2026-09-25",
        reason: "Rang twice",
        addedBy: maya.user_id,
      });
    });
    // An approved comp doesn't count against her limit (approvals arrive in M2-15; written directly here).
    await raw.query(
      `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category, business_date, reason, added_by, approved_by)
         values ($1, $2, 'comp', 'Comp · bottle', 1, -9000, -9000, 'drink', '2026-09-25', 'Big mistake', $3, $4)`,
      [venueId, ids["chk_t1"], maya.user_id, ids["andy"]],
    );
    expect(await left()).toMatchObject({ used_cents: 1200 + 1000 + 900, left_cents: 7500 - 3100 });
  });

  it("staff read only their own; a manager reads anyone's", async () => {
    const diego = (
      await raw.query<{ id: string }>(
        "select id from memberships where venue_id = $1 and role = 'front_desk'",
        [venueId],
      )
    ).rows[0]!.id;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/venues/${venueId}/reason-only?membership_id=${diego}`,
        })
      ).statusCode,
    ).toBe(403);
  });
});
