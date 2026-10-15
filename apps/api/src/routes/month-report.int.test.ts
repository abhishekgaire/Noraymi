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
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sweepClearOut } from "../rooms/clear-out.js";
import type { Principal, SessionKind } from "../http/principal.js";

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

/**
 * The month (P-07): September 2026 holds a closed Fri Sep 4 and, once it closes, Fri Sep 25; its totals
 * equal the sum of those nights' Z reports to the cent; a night with sales but no close is named and left
 * out; the month in progress says so; room minutes are the night's billed segments; the CSV asks for the
 * passkey again, and bartenders can't see it.
 */
interface Month {
  month: string;
  in_progress: boolean;
  not_closed: string[];
  nights: (Record<string, number> & { business_date: string; z_number: number })[];
  totals: Record<string, number>;
}
interface Z {
  kind: "x" | "z";
  sales: Record<string, number>;
  tax_cents: number;
  gratuity: { total_cents: number };
  payments: Record<string, number>;
}
const FRI = "2026-09-25";
const month = async (m?: string) => {
  const r = await get(m === undefined ? "/reports/month" : `/reports/month?month=${m}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Month;
};
const zOf = async (date: string) => (await get(`/nights/${date}/report`)).json() as Z;

describe("the month", () => {
  it("leaves out a night with sales that isn't closed, and says the month is in progress", async () => {
    as("andy", "manager", "passkey", "dev_phone_andy");
    const check = (
      await owner.query<{ id: string }>(
        `insert into checks (venue_id, kind, business_date, status, number, opened_by)
         values ($1, 'bar', '2026-09-10', 'finalized', 9101, $2) returning id`,
        [venueId, ids["maya"]],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents, tax_category, business_date, added_at)
       values ($1, $2, 'item', 'Beer', 900, 900, 'drink', '2026-09-10', '2026-09-10T23:00:00-04:00')`,
      [venueId, check],
    );
    const m = await month("2026-09");
    expect(m.in_progress).toBe(true);
    expect(m.nights).toEqual([]);
    expect(m.not_closed).toContain("2026-09-10");
    expect(m.not_closed).not.toContain(FRI);
    expect(m.totals["net_cents"]).toBe(0);
    // The month before is over and had nothing; left out, it's this business date's month.
    expect(await month("2026-08")).toMatchObject({ in_progress: false, nights: [] });
    expect((await month()).month).toBe("2026-09");
  });

  it("totals its closed nights' Z reports to the cent", async () => {
    // Fri Sep 4, closed with its own Z report.
    const sep4 = {
      kind: "z",
      sales: {
        room_time_cents: 64400,
        drinks_room_checks_cents: 31601,
        drinks_bar_tabs_cents: 12345,
        food_cents: 0,
        packages_cents: 0,
        songs_cents: 0,
        damage_cents: 0,
        kept_deposits_cents: 0,
        min_spend_cents: 0,
        card_surcharge_cents: 0,
        fees_cents: 0,
        comps_cents: -1200,
        voids_cents: -650,
        discounts_cents: -333,
        refunds_cents: -100,
        net_cents: 106063,
      },
      tax_cents: 9413,
      gratuity: { total_cents: 19200 },
      payments: {
        card_present_cents: 80001,
        card_on_file_cents: 0,
        card_online_cents: 12000,
        cash_cents: 22775,
        card_tips_cents: 4100,
        cash_tips_cents: 500,
        refunds_cents: 100,
        outside_card_cents: 0,
        outside_card_tips_cents: 0,
      },
    };
    await owner.query(
      `insert into night_closes (venue_id, business_date, z_number, closed_at, closed_by, totals)
       values ($1, '2026-09-04', 900, '2026-09-05T04:40:00-04:00', $2, $3)`,
      [venueId, ids["andy"], JSON.stringify({ report: sep4 })],
    );

    // Close Fri Sep 25 for real.
    clock.set(Temporal.Instant.from("2026-09-26T04:48:00-04:00"));
    for (const sql of [
      "update room_sessions set ended_at = now() where venue_id = $1 and ended_at is null",
      "update tabs set state = 'captured' where venue_id = $1 and state in ('open', 'tipping')",
      "update waitlist_entries set status = 'left' where venue_id = $1 and status in ('waiting', 'offered')",
      "update orders set status = 'cancelled', cancel_reason = 'staff' where venue_id = $1 and status in ('ringing', 'held')",
      "update approvals set status = 'declined' where venue_id = $1 and status = 'pending'",
      "update room_states set state = 'available' where venue_id = $1 and state = 'cleaning'",
      "update order_drafts set lines = '[]' where venue_id = $1",
      "update drawer_sessions set state = 'counted', counted_cents = opening_cents, expected_cents = opening_cents, over_short_cents = 0 where venue_id = $1 and state = 'open'",
    ])
      await owner.query(sql, [venueId]);
    await owner.query(
      `update shifts set ended_at = now() where venue_id = $1 and ended_at is null
         and membership_id not in (select id from memberships where user_id = $2)`,
      [venueId, ids["andy"]],
    );
    await sweepClearOut(owner, Temporal.Instant.from("2026-09-26T04:31:00-04:00"));
    expect((await post(`/nights/${FRI}/clear-out`, {})).statusCode).toBe(200);
    const closed = await post(`/nights/${FRI}/close`, {});
    expect(closed.statusCode, closed.body).toBe(200);
    const z25 = await zOf(FRI);
    expect(z25.kind).toBe("z");

    const m = await month("2026-09");
    expect(m.in_progress).toBe(true);
    expect(m.nights.map((x) => x.business_date)).toEqual(["2026-09-04", FRI]);
    const [a, b] = m.nights as [Month["nights"][number], Month["nights"][number]];
    expect(a.z_number).toBe(900);
    // Each night is its Z report's figures.
    for (const [night, z] of [
      [a, sep4],
      [b, z25],
    ] as const) {
      for (const [k, v] of Object.entries(z.sales)) expect(night[k], k).toBe(v);
      expect(night["tax_cents"]).toBe(z.tax_cents);
      expect(night["gratuity_cents"]).toBe(z.gratuity.total_cents);
      expect(night["cash_cents"]).toBe(z.payments["cash_cents"]);
      expect(night["card_cents"]).toBe(
        z.payments["card_present_cents"]! +
          z.payments["card_on_file_cents"]! +
          z.payments["card_online_cents"]!,
      );
      expect(night["card_tips_cents"]).toBe(z.payments["card_tips_cents"]);
      expect(night["outside_card_cents"]).toBe(z.payments["outside_card_cents"]);
    }
    // The month is the sum of its nights, figure by figure.
    for (const [k, v] of Object.entries(m.totals)) expect(v, k).toBe(a[k]! + b[k]!);
    expect(m.totals["net_cents"]).toBe(sep4.sales.net_cents + z25.sales["net_cents"]!);
    expect(m.totals["tax_cents"]).toBe(9413 + z25.tax_cents);
    // Room minutes: Friday's billed room-session segments.
    const minutes = await owner.query<{ m: string }>(
      `select coalesce(sum(round(extract(epoch from (coalesce(g.ended_at, s.ended_at) - g.started_at)) / 60)), 0)::bigint::text as m
         from session_segments g join room_sessions s on s.id = g.session_id
        where s.venue_id = $1 and s.business_date = $2 and not s.training and not g.paused`,
      [venueId, FRI],
    );
    expect(b["room_minutes"]).toBe(Number(minutes.rows[0]!.m));
    expect(b["room_minutes"]).toBeGreaterThan(0);
    expect(a["room_minutes"]).toBe(0);
  });

  it("asks for the passkey again to export, refuses a bartender and a bad month", async () => {
    as("andy", "manager", "passkey", "dev_phone_andy");
    expect((await get("/reports/month?month=2026-09&format=csv")).statusCode).toBe(403);
    expect((await get("/reports/month?month=2026-13")).statusCode).toBe(400);
    as("maya", "bartender", "pin", "dev_bar_computer");
    expect((await get("/reports/month?month=2026-09")).statusCode).toBe(403);
  });
});
