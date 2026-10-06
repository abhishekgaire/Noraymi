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

/**
 * The X and Z reports (M7-13; Money rules 9 and 16): the running X report's
 * figures agree with the night's lines to the cent, practice checks stay out,
 * the Z report is the snapshot written at the close and never changes, late
 * money shows under the next night's adjustments, and a Z report can't print
 * before the close.
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

interface Report {
  kind: "x" | "z";
  sales: Record<string, number>;
  tax_cents: number;
  gratuity: { total_cents: number; by_check: Record<string, number> };
  counts: { rooms: number; bar_tabs: number };
  closed: { z_number: number } | null;
  adjustments: { what: string; for_business_date: string; amount_cents: number }[];
}
const FRI = "2026-09-25";
const SAT = "2026-09-26";
const report = async (date: string) => {
  const r = await get(`/nights/${date}/report`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Report;
};
const sum = async (where: string) =>
  Number(
    (
      await owner.query<{ c: string }>(
        `select coalesce(sum(l.amount_cents), 0)::text as c from check_lines l join checks k on k.id = l.check_id
          where k.venue_id = $1 and not k.training and l.business_date = $2 and l.adjusts_business_date is null and ${where}`,
        [venueId, FRI],
      )
    ).rows[0]!.c,
  );

describe("the night's report", () => {
  it("runs as the X report at 10:41 PM, its figures equal to the night's lines, with practice checks left out", async () => {
    as("andy", "manager", "passkey", "dev_phone_andy");
    // A practice check (T-0012 style) with lines and a gratuity: it must not move any figure.
    const before = await report(FRI);
    const check = (
      await owner.query<{ id: string }>(
        `insert into checks (venue_id, kind, business_date, status, number, training, opened_by)
         values ($1, 'room', $2, 'open', 12, true, $3) returning id`,
        [venueId, FRI, ids["maya"]],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents, business_date, added_at)
       values ($1, $2, 'room_time', 'Room time', 4000, 4000, $3, now()), ($1, $2, 'gratuity', 'Gratuity', 800, 800, $3, now())`,
      [venueId, check, FRI],
    );
    const r = await report(FRI);
    expect(r).toEqual({
      ...before,
      generated_at: (r as unknown as { generated_at: string }).generated_at,
    });
    expect(r.kind).toBe("x");
    expect(r.gratuity.total_cents).toBe(await sum("l.kind = 'gratuity'"));
    expect(r.sales["room_time_cents"]).toBe(await sum("l.kind = 'room_time'"));
    expect(r.tax_cents).toBe(await sum("l.kind = 'tax'"));
    expect(r.gratuity.by_check).not.toHaveProperty(check);
    expect(r.counts.rooms).toBeGreaterThan(0);
    // The five open tabs and the three waiting on paper slips, counted apart from the rooms.
    expect(r.counts.bar_tabs).toBe(8);
  });

  it("prints the X report on the front-desk printer, and refuses the Z report before the close", async () => {
    const z = await post(`/nights/${FRI}/report/print`, { kind: "z" });
    expect(z.statusCode).toBe(400);
    expect(z.json().error.details.reason).toBe("not_closed");
    const x = await post(`/nights/${FRI}/report/print`, { kind: "x" });
    expect(x.statusCode, x.body).toBe(200);
    const job = await owner.query<{ kind: string; station: string; first: string }>(
      "select kind, station, payload -> 'lines' ->> 0 as first from print_jobs where kind = 'x_report'",
    );
    expect(job.rows).toEqual([
      { kind: "x_report", station: "front_desk", first: "X REPORT (RUNNING)" },
    ]);
  });

  it("switches to the Z report at the close and never changes; Saturday's slip tips show under Saturday's adjustments", async () => {
    clock.set(Temporal.Instant.from("2026-09-26T04:48:00-04:00"));
    await owner.query(
      "update room_sessions set ended_at = now() where venue_id = $1 and ended_at is null",
      [venueId],
    );
    await owner.query(
      "update tabs set state = 'captured' where venue_id = $1 and state in ('open', 'tipping')",
      [venueId],
    );
    await owner.query(
      `update shifts set ended_at = now() where venue_id = $1 and ended_at is null
         and membership_id not in (select id from memberships where user_id = $2)`,
      [venueId, ids["andy"]],
    );
    await owner.query(
      "update waitlist_entries set status = 'left' where venue_id = $1 and status in ('waiting', 'offered')",
      [venueId],
    );
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'staff' where venue_id = $1 and status in ('ringing', 'held')",
      [venueId],
    );
    await owner.query(
      "update approvals set status = 'declined' where venue_id = $1 and status = 'pending'",
      [venueId],
    );
    await owner.query(
      "update room_states set state = 'available' where venue_id = $1 and state = 'cleaning'",
      [venueId],
    );
    await owner.query("update order_drafts set lines = '[]' where venue_id = $1", [venueId]);
    await owner.query(
      "update drawer_sessions set state = 'counted', counted_cents = opening_cents, expected_cents = opening_cents, over_short_cents = 0 where venue_id = $1 and state = 'open'",
      [venueId],
    );
    await sweepClearOut(owner, Temporal.Instant.from("2026-09-26T04:31:00-04:00"));
    expect((await post(`/nights/${FRI}/clear-out`, {})).statusCode).toBe(200);
    const closed = await post(`/nights/${FRI}/close`, {});
    expect(closed.statusCode, closed.body).toBe(200);

    const z = await report(FRI);
    expect(z.kind).toBe("z");
    expect(z.closed).toMatchObject({ z_number: 1, closed_by: "Andy C." });
    // Late money for Friday posts to Saturday: Friday's Z never changes.
    await owner.query(
      `insert into tip_ledger (venue_id, business_date, adjusts_business_date, source, amount_cents)
       values ($1, $2, $3, 'card_tip', 2401)`,
      [venueId, SAT, FRI],
    );
    expect(await report(FRI)).toEqual(z);
    const sat = await report(SAT);
    expect(sat.kind).toBe("x");
    expect(sat.adjustments).toEqual([
      { what: "tip", description: "card_tip", for_business_date: FRI, amount_cents: 2401 },
    ]);
    expect((await post(`/nights/${FRI}/report/print`, { kind: "z" })).statusCode).toBe(200);
  });
});
