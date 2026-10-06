import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * Reports (M7-18): sales by night and week with 8 weeks of trends (legacy nights before go-live
 * included), occupancy by hour, bookings by week, staff actions, and the exceptions report with Maya's
 * $12.00 comp and Diego's $70.00 void and who asked and approved; payouts for the owner only; every
 * report and export answers 404 module_off with Reports & accounting off, and Night's report doesn't.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);

type Role = "owner" | "manager" | "bartender" | "front_desk";
interface Who {
  slug: string;
  role: Role;
  session: SessionKind;
  device: string;
  deviceKind: "bar_computer" | "front_desk" | "staff_phone";
}
let who: Who;
const as = (slug: string, role: Role, session: SessionKind, device: string) => {
  who = {
    slug,
    role,
    session,
    device,
    deviceKind: device.startsWith("dev_phone")
      ? "staff_phone"
      : device === "dev_bar_computer"
        ? "bar_computer"
        : "front_desk",
  };
};
const get = (path: string) => api.inject({ method: "GET", url: `/v1/venues/${venueId}${path}` });

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
  as("andy", "manager", "passkey", "dev_phone_andy");
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
        const deviceId = ids[who.device]!;
        Object.assign(request, {
          session: {
            assurance: who.session,
            membershipId: memberships[userId],
            deviceId,
          },
          signedDevice: { deviceId, venueId, kind: who.deviceKind },
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

const FRI = "2026-09-25";

describe("Reports", () => {
  it("lists the exceptions for Fri Sep 25: Maya's $12.00 comp on Luis M.'s tab and Diego's $70.00 void on Tariq A.'s, with who asked and who approved", async () => {
    as("andy", "manager", "passkey", "dev_phone_andy");
    const r = await get(`/reports/exceptions?date=${FRI}`);
    expect(r.statusCode, r.body).toBe(200);
    const rows = r.json().exceptions as Record<string, unknown>[];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "comp",
          status: "done",
          where: "Luis M.",
          asked_by: "Maya S.",
          amount_cents: 1200,
        }),
        expect.objectContaining({
          kind: "void",
          status: "pending",
          where: "Tariq A.",
          asked_by: "Diego R.",
          waiting_for: "Andy C.",
          amount_cents: 7000,
        }),
      ]),
    );
  });

  it("reports sales by night and Fri-to-Thu week with 8 weeks of trends, legacy nights included, and reviews Off while the review text is off", async () => {
    await owner.query(
      "insert into legacy_nightly_totals (venue_id, business_date, net_sales_cents) values ($1, '2026-08-07', 812345)",
      [venueId],
    );
    const r = await get(`/reports/sales?to=${FRI}`);
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json();
    expect(s.weeks).toHaveLength(8);
    expect(s.weeks[7]).toMatchObject({ start: FRI, end: "2026-10-01" });
    expect(s.weeks.find((w: { start: string }) => w.start === "2026-08-07").net_cents).toBe(812345);
    expect(s.this_week.net_cents).toBeGreaterThan(0);
    expect(s.reviews).toEqual({ review_ask_on: false });
    expect(s.by_weekday).toHaveLength(7);
  });

  it("reports occupancy by hour of the venue's rooms, bookings by week, and staff actions", async () => {
    const occ = (await get(`/reports/occupancy?date=${FRI}`)).json();
    expect(occ.rooms).toBe(14);
    expect(occ.hours).toHaveLength(24);
    expect(Math.max(...occ.hours.map((h: { in_use: number }) => h.in_use))).toBeGreaterThan(0);
    const b = (await get(`/reports/bookings?to=${FRI}`)).json();
    expect(b.weeks).toHaveLength(8);
    expect(b.weeks[7].booked_online).toBeGreaterThan(0);
    const staff = (await get(`/reports/staff-actions?date=${FRI}`)).json();
    expect(staff.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Maya S.", actions: { comp: { count: 1, cents: -1200 } } }),
      ]),
    );
  });

  it("answers payouts for the owner, 403 for Andy", async () => {
    as("andy", "manager", "passkey", "dev_phone_andy");
    expect((await get("/reports/payouts")).statusCode).toBe(403);
    as("abhishek", "owner", "passkey", "dev_phone_abhishek");
    expect((await get("/reports/payouts")).statusCode).toBe(200);
  });

  it("hides every report and export with Reports & accounting off, and Night's report stays", async () => {
    await owner.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'reports'",
      [venueId],
    );
    as("abhishek", "owner", "passkey", "dev_phone_abhishek");
    for (const path of [
      `/reports/sales?to=${FRI}`,
      `/reports/occupancy?date=${FRI}`,
      `/reports/bookings?to=${FRI}`,
      `/reports/staff-actions?date=${FRI}`,
      `/reports/exceptions?date=${FRI}`,
      "/reports/payouts",
      `/reports/tax-quarter?date=${FRI}`,
      `/exports/accounting?date=${FRI}`,
      `/exports/payroll?from=${FRI}&to=${FRI}`,
    ]) {
      const r = await get(path);
      expect([r.statusCode, r.json().error?.code], path).toEqual([404, "module_off"]);
    }
    expect((await get(`/nights/${FRI}/report`)).statusCode).toBe(200);
  });
});
