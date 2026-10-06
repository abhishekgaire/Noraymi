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
 * The sales-tax quarter (M7-17): Sep–Nov 2026 holds Fri Sep 25 with 8.875% on room time, drinks and
 * damage fees; its tax equals its nights' tax lines; the after-midnight sales of its last night (business
 * date Mon Nov 30) show on their own line; exporting asks for the passkey again.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

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
const post = (path: string, payload?: unknown) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `drawer-${++n}` },
    ...(payload ? { payload } : {}),
  });
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

interface Quarter {
  quarter: { label: string; start: string; end: string };
  rows: { category: string; rate: string; taxable_base_cents: number; tax_cents: number }[];
  tax_cents: number;
  not_taxed: { gratuity_cents: number };
  after_midnight: { business_date: string; tax_cents: number };
}

describe("the sales-tax quarter", () => {
  it("holds Fri Sep 25 in Sep–Nov 2026 with 8.875% on room time, drinks and damage fees, equal to its tax lines", async () => {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    // A $150.00 damage fee on Room 9, then the check presented: its tax lines are written.
    await owner.query(
      `insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents, tax_category, business_date, added_at)
       values ($1, $2, 'damage', 'Damage fee', 15000, 15000, 'damage', '2026-09-25', now())`,
      [venueId, ids["chk_room9"]],
    );
    as("andy", "manager", "passkey", "dev_phone_andy");
    expect((await post(`/checks/${ids["chk_room9"]}/present`)).statusCode).toBe(200);
    const r = await get("/reports/tax-quarter?date=2026-09-25");
    expect(r.statusCode, r.body).toBe(200);
    const q = r.json() as Quarter;
    expect(q.quarter).toEqual({ label: "2026-Q3", start: "2026-09-01", end: "2026-11-30" });
    expect(q.rows.map((x) => [x.category, Number(x.rate)])).toEqual([
      ["damage", 0.08875],
      ["drink", 0.08875],
      ["room_time", 0.08875],
    ]);
    const lines = await owner.query<{ tax: string }>(
      `select coalesce(sum(l.amount_cents), 0)::text as tax from check_lines l join checks k on k.id = l.check_id
        where not k.training and l.kind = 'tax' and l.business_date between '2026-09-01' and '2026-11-30'`,
    );
    expect(q.tax_cents).toBe(Number(lines.rows[0]!.tax));
    // Room 9's gratuity, untaxed; a damage fee is never in the gratuity's base.
    expect(q.not_taxed.gratuity_cents).toBe(9600);
  });

  it("shows the sales from midnight to 6:00 AM on Tue Dec 1 (business date Mon Nov 30) on their own line", async () => {
    const check = (
      await owner.query<{ id: string }>(
        `insert into checks (venue_id, kind, business_date, status, number, opened_by)
         values ($1, 'bar', '2026-11-30', 'finalized', 9001, $2) returning id`,
        [venueId, ids["maya"]],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents, tax_category,
         jurisdiction_code, tax_rate, taxable_base_cents, business_date, added_at)
       values ($1, $2, 'tax', 'Sales tax', 178, 178, 'drink', null, 0.08875, 2000, '2026-11-30', '2026-11-30T23:30:00-05:00'),
              ($1, $2, 'tax', 'Sales tax', 266, 266, 'drink', null, 0.08875, 3000, '2026-11-30', '2026-12-01T01:15:00-05:00')`,
      [venueId, check],
    );
    const q = (await get("/reports/tax-quarter?date=2026-11-30")).json() as Quarter;
    expect(q.after_midnight).toEqual({
      business_date: "2026-11-30",
      taxable_base_cents: 3000,
      tax_cents: 266,
    });
    // The CSV export asks for the passkey again.
    expect((await get("/reports/tax-quarter?date=2026-11-30&format=csv")).statusCode).toBe(403);
  });
});
