import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  setPermission,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal, SessionKind } from "../http/principal.js";
import { nightReport } from "../nights/report.js";
import { glanceCounts } from "./glance.js";

/**
 * Today at a glance (P-12): the numbers match the X report and the punches; staff without Reports
 * (or in a PIN session, which can't open the X report) don't see sales; bartenders and the front desk
 * are refused; the PIN screen's "N on shift" is the same count as "on the clock".
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
const FRI = "2026-09-25";

type Role = "owner" | "manager" | "bartender" | "front_desk";
let who: { slug: string; role: Role; session: SessionKind } = {
  slug: "andy",
  role: "manager",
  session: "passkey",
};
const as = (slug: string, role: Role, session: SessionKind) => {
  who = { slug, role, session };
};
const get = (path: string) => api.inject({ method: "GET", url: `/v1/venues/${venueId}${path}` });

interface Glance {
  business_date: string;
  sales_cents: number | null;
  open_checks: number;
  rooms_in_use: number;
  on_the_clock: number | null;
}
const glance = async () => {
  const r = await get("/glance");
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Glance;
};
const count = async (sql: string) =>
  Number((await owner.query<{ n: string }>(sql, [venueId])).rows[0]!.n);

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
  const memberships = Object.fromEntries(
    (
      await owner.query<{ user_id: string; id: string }>(
        "select user_id, id from memberships where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.user_id, r.id]),
  );
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest): Promise<Principal> => {
        const userId = ids[who.slug]!;
        Object.assign(request, {
          session: { assurance: who.session, membershipId: memberships[userId] },
        });
        return {
          kind: "user",
          userId,
          session: who.session,
          memberships: [{ venueId, membershipId: memberships[userId]!, role: who.role }],
        };
      },
    ],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("today at a glance", () => {
  it("matches the X report and the punches for a manager", async () => {
    as("andy", "manager", "passkey");
    const g = await glance();
    expect(g.business_date).toBe(FRI);
    const x = await get(`/nights/${FRI}/report`);
    expect(x.statusCode, x.body).toBe(200);
    const report = x.json() as { kind: string; sales: { net_cents: number } };
    expect(report.kind).toBe("x");
    expect(g.sales_cents).toBe(report.sales.net_cents);
    expect(g.sales_cents).toBeGreaterThan(0);

    const rooms = await count(
      "select count(*) as n from room_sessions where venue_id = $1 and ended_at is null and not training",
    );
    const tabs = await count(
      `select count(*) as n from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
        where t.venue_id = $1 and t.state in ('open', 'tipping') and not k.training`,
    );
    const shifts = await count(
      "select count(*) as n from shifts where venue_id = $1 and ended_at is null",
    );
    expect(rooms).toBeGreaterThan(0);
    expect(shifts).toBeGreaterThan(0);
    expect(g).toMatchObject({
      rooms_in_use: rooms,
      open_checks: rooms + tabs,
      on_the_clock: shifts,
    });
    // The board's own count of rooms in use agrees.
    const board = (await get("/board")).json() as { counts: { in_use: number } };
    expect(board.counts.in_use).toBe(rooms);
    // The PIN screen's "N on shift" is the same count.
    const tiles = (await get("/team/tiles")).json() as { on_shift: number | null };
    expect(tiles.on_shift).toBe(shifts);
  });

  it("reads the same as the API's runtime role (app_rw)", async () => {
    const asApp = await withVenue(app, { venueId, requestId: "glance-test" }, async (c) => ({
      counts: await glanceCounts(c, venueId),
      net: (await nightReport(c, venueId, FRI, clock.now())).sales.net_cents,
    }));
    as("andy", "manager", "passkey");
    const g = await glance();
    expect(asApp.counts).toEqual({
      rooms_in_use: g.rooms_in_use,
      open_checks: g.open_checks,
      on_the_clock: g.on_the_clock,
    });
    expect(asApp.net).toBe(g.sales_cents);
  });

  it("follows a clock-out", async () => {
    as("andy", "manager", "passkey");
    const before = await glance();
    const shift = (
      await owner.query<{ id: string }>(
        `select s.id from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
          where s.venue_id = $1 and s.ended_at is null and m.user_id = $2`,
        [venueId, ids["diego"]],
      )
    ).rows[0]!;
    await owner.query("update shifts set ended_at = $2 where id = $1", [
      shift.id,
      clock.now().toString(),
    ]);
    try {
      expect((await glance()).on_the_clock).toBe(before.on_the_clock! - 1);
      const tiles = (await get("/team/tiles")).json() as { on_shift: number | null };
      expect(tiles.on_shift).toBe(before.on_the_clock! - 1);
    } finally {
      await owner.query("update shifts set ended_at = null where id = $1", [shift.id]);
    }
  });

  it("leaves sales out without Reports, and in a PIN session", async () => {
    as("andy", "manager", "pin");
    const pin = await glance();
    expect(pin.sales_cents).toBeNull();
    expect(pin.rooms_in_use).toBeGreaterThan(0);

    as("andy", "manager", "passkey");
    await setPermission(owner, venueId, "manager", "reports.view", false, false, undefined);
    try {
      const g = await glance();
      expect(g.sales_cents).toBeNull();
      expect(g.open_checks).toBeGreaterThan(0);
    } finally {
      await owner.query("delete from role_permissions where venue_id = $1 and action = $2", [
        venueId,
        "reports.view",
      ]);
    }
    expect((await glance()).sales_cents).not.toBeNull();
  });

  it("refuses bartenders and the front desk", async () => {
    as("maya", "bartender", "pin");
    expect((await get("/glance")).statusCode).toBe(403);
    as("diego", "front_desk", "pin");
    expect((await get("/glance")).statusCode).toBe(403);
  });

  it("drops on the clock and N on shift while Team, time clock & tips is off", async () => {
    await owner.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'team'",
      [venueId],
    );
    try {
      as("andy", "manager", "passkey");
      expect((await glance()).on_the_clock).toBeNull();
      const tiles = (await get("/team/tiles")).json() as { on_shift: number | null };
      expect(tiles.on_shift).toBeNull();
    } finally {
      await owner.query(
        "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'team'",
        [venueId],
      );
    }
  });
});
