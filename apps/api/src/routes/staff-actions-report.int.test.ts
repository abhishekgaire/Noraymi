import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { LOCAL_DEV_AUTH_KEY as KEY, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal, SessionKind } from "../http/principal.js";
import { staffActionRows } from "../nights/staff-actions.js";

/**
 * Reports → Staff actions (P-09): per person, over a range of dates, the count
 * and dollars of voids, comps, discounts, refunds, no-sales, paid-outs,
 * over/short and punch edits, each with its rows and who approved it. The
 * dollars are checked against the audit log's own rows, and the route is the
 * owners' and managers' only.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const users: Record<string, string> = {};
const clock = new FrozenClock(SEED_NOW);
const FRI = "2026-09-25";

type Role = "owner" | "manager" | "bartender" | "front_desk";
let who: { slug: string; role: Role; session: SessionKind; device: string };
const as = (slug: string, role: Role, session: SessionKind, device: string) => {
  who = { slug, role, session, device };
};
const get = (path: string) => api.inject({ method: "GET", url: `/v1/venues/${venueId}${path}` });

interface Entry {
  kind: string;
  at: string;
  business_date: string;
  where: string | null;
  what: string | null;
  why: string | null;
  amount_cents: number;
  approved_by: string | null;
}
interface Person {
  user_id: string;
  name: string;
  actions: Record<string, { count: number; cents: number }>;
  entries: Entry[];
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  for (const r of (
    await owner.query<{ id: string; name: string }>(
      `select u.id, u.name from users u join memberships m on m.user_id = u.id where m.venue_id = $1`,
      [venueId],
    )
  ).rows)
    users[r.name] = r.id;
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
          session: { assurance: who.session, membershipId: memberships[userId], deviceId },
          signedDevice: {
            deviceId,
            venueId,
            kind: who.device.startsWith("dev_phone") ? "staff_phone" : "bar_computer",
          },
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

  // The night's staff actions beyond the seed's one comp (Maya's $12.00), each written as the app writes it.
  const maya = users["Maya S."]!;
  const andy = users["Andy C."]!;
  const diego = users["Diego R."]!;
  const abhishek = ids["abhishek"]!;
  const checks = (
    await owner.query<{ id: string }>(
      `select k.id from checks k where k.venue_id = $1 and k.business_date = $2 and not k.training
        order by k.number limit 2`,
      [venueId, FRI],
    )
  ).rows;
  const [roomCheck, otherCheck] = [checks[0]!.id, checks[1]!.id];
  // A void Andy approved, and a meal voided with one part (K-12): one action at the whole amount.
  await owner.query(
    `insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents, reason,
                              added_by, approved_by, business_date, added_at)
     values ($1, $2, 'void', 'Coke', -350, -350, 'Wrong drink', $3, $4, $5, '2026-09-26T01:10:00Z')`,
    [venueId, roomCheck, diego, andy, FRI],
  );
  const meal = await owner.query<{ id: string }>(
    `insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents, reason,
                              added_by, business_date, added_at)
     values ($1, $2, 'void', 'Classic Cheese', -1400, -1400, 'Sent twice', $3, $4, '2026-09-26T01:20:00Z')
     returning id`,
    [venueId, roomCheck, diego, FRI],
  );
  await owner.query(
    `insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents, reason,
                              added_by, business_date, added_at, part_of_id)
     values ($1, $2, 'void', 'French Fries', -600, -600, 'Sent twice', $3, $4, '2026-09-26T01:20:00Z', $5)`,
    [venueId, roomCheck, diego, FRI, meal.rows[0]!.id],
  );
  // A 10% discount Maya gave (P-02) and its line; and one she took off again, which isn't counted.
  await owner.query(
    `insert into check_discounts (venue_id, check_id, business_date, mode, amount_cents, reason, counted_cents,
                                  added_by, added_at, removed_by, removed_at)
     values ($1, $2, $3, 'amount', 500, 'Wrong check', 500, $4, '2026-09-26T00:30:00Z', $4, '2026-09-26T00:31:00Z')`,
    [venueId, otherCheck, FRI, maya],
  );
  await owner.query(
    `insert into check_discounts (venue_id, check_id, business_date, mode, pct, reason, counted_cents,
                                  added_by, approved_by, added_at)
     values ($1, $2, $3, 'pct', 10, 'Regulars', 1580, $4, $5, '2026-09-26T00:40:00Z')`,
    [venueId, otherCheck, FRI, maya, andy],
  );
  await owner.query(
    `insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents,
                              added_by, business_date, added_at)
     values ($1, $2, 'discount', 'Discount 10%', -1580, -1580, $3, $4, '2026-09-26T00:40:00Z')`,
    [venueId, otherCheck, maya, FRI],
  );
  // A refund of a deposit Diego asked for and Abhishek approved.
  const deposit = (
    await owner.query<{ id: string; booking_id: string }>(
      `select id, booking_id from payments where venue_id = $1 and booking_id is not null
          and not training order by created_at, id limit 1`,
      [venueId],
    )
  ).rows[0]!;
  await owner.query(
    `insert into refunds (venue_id, payment_id, booking_id, amount_cents, reason, status, n, requested_by,
                          approved_by, business_date, requested_at)
     values ($1, $2, $3, 2000, 'Left early', 'succeeded', 1, $4, $5, $6, '2026-09-26T01:30:00Z')`,
    [venueId, deposit.id, deposit.booking_id, diego, abhishek, FRI],
  );
  // At the bar drawer: Maya's no-sale, Diego's paid-out Andy approved; Andy counts another drawer $2.50 short.
  const sessions = (
    await owner.query<{ id: string }>(
      `select id from drawer_sessions where venue_id = $1 and business_date = $2 order by opened_at, id`,
      [venueId, FRI],
    )
  ).rows;
  await owner.query(
    `insert into drawer_moves (venue_id, drawer_session_id, kind, amount_cents, taken_by, reason, at)
     values ($1, $2, 'no_sale', 0, $3, 'Change for a $20', '2026-09-26T01:40:00Z')`,
    [venueId, sessions[0]!.id, maya],
  );
  await owner.query(
    `insert into drawer_moves (venue_id, drawer_session_id, kind, amount_cents, taken_by, reason, approved_by, at)
     values ($1, $2, 'paid_out', -1500, $3, 'Ice', $4, '2026-09-26T01:45:00Z')`,
    [venueId, sessions[0]!.id, diego, andy],
  );
  await owner.query(
    `update drawer_sessions set state = 'counted', counted_by = $2, counted_at = '2026-09-26T02:00:00Z',
            counted_cents = 19750, expected_cents = 20000, over_short_cents = -250, approved_by = $3,
            note = 'Short a quarter roll'
      where venue_id = $1 and id = $4`,
    [venueId, andy, abhishek, sessions[1]!.id],
  );
  // Andy fixes Maya's clock-in.
  await owner.query(
    `update time_punches p set edited_by = $2, reason = 'Forgot to clock in', at = p.at - interval '15 minutes'
       from memberships m where m.venue_id = p.venue_id and m.id = p.membership_id
        and p.venue_id = $1 and m.user_id = $3 and p.kind = 'clock_in'`,
    [venueId, andy, maya],
  );
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

const person = (people: Person[], name: string) => people.find((p) => p.name === name)!;

describe("Reports → Staff actions (P-09)", () => {
  it("counts and totals each person's actions, each listed with who approved it", async () => {
    as("andy", "manager", "passkey", "dev_phone_andy");
    const r = await get(`/reports/staff-actions?from=${FRI}&to=${FRI}`);
    expect(r.statusCode).toBe(200);
    const body = r.json<{ from: string; to: string; people: Person[] }>();
    expect([body.from, body.to]).toEqual([FRI, FRI]);
    const maya = person(body.people, "Maya S.");
    expect(maya.actions).toEqual({
      comp: { count: 1, cents: -1200 },
      discount: { count: 1, cents: -1580 },
      no_sale: { count: 1, cents: 0 },
    });
    expect(maya.entries.find((e) => e.kind === "discount")).toMatchObject({
      what: "10%",
      why: "Regulars",
      approved_by: "Andy C.",
    });
    const diego = person(body.people, "Diego R.");
    expect(diego.actions).toEqual({
      void: { count: 2, cents: -2350 },
      refund: { count: 1, cents: 2000 },
      paid_out: { count: 1, cents: -1500 },
    });
    expect(diego.entries.filter((e) => e.kind === "void").map((e) => e.approved_by)).toEqual([
      "Andy C.",
      null,
    ]);
    expect(diego.entries.find((e) => e.kind === "refund")!.approved_by).toBe("Abhishek G.");
    const andy = person(body.people, "Andy C.");
    expect(andy.actions).toEqual({
      over_short: { count: 1, cents: -250 },
      punch_edit: { count: 1, cents: 0 },
      cut_off: { count: 1, cents: 0 },
    });
    expect(andy.entries.find((e) => e.kind === "punch_edit")).toMatchObject({
      where: "clock_in",
      what: "Maya S.",
      why: "Forgot to clock in",
      business_date: FRI,
    });
    expect(andy.entries.find((e) => e.kind === "over_short")!.approved_by).toBe("Abhishek G.");
  });

  it("matches the audit log's rows to the cent, person by person", async () => {
    as("abhishek", "owner", "passkey", "dev_phone_abhishek");
    const people = (await get(`/reports/staff-actions?date=${FRI}`)).json<{ people: Person[] }>()
      .people;
    // What the audit log recorded as each row was written (inserts, and the drawer count's update).
    const audit = await owner.query<{ who: string; kind: string; cents: string }>(
      `with rows as (
         select a.target, a.at, a.id, a.new_values v, split_part(a.target, '/', 1) as tbl
           from audit_log a where a.venue_id = $1
            and split_part(a.target, '/', 1) in ('check_lines', 'check_discounts', 'refunds', 'drawer_moves', 'drawer_sessions')),
       latest as (select distinct on (target) * from rows order by target, id desc)
       select v->>'added_by' as who, v->>'kind' as kind,
              (sum((v->>'amount_cents')::bigint) + coalesce(sum((select sum((p.v->>'amount_cents')::bigint)
                 from latest p where p.tbl = 'check_lines' and p.v->>'part_of_id' = split_part(l.target, '/', 2))), 0))::text as cents
         from latest l where tbl = 'check_lines' and v->>'kind' in ('comp', 'void') and v->>'part_of_id' is null
          and v->>'business_date' = $2 group by 1, 2
       union all
       select v->>'added_by', 'discount', sum((select sum((p.v->>'amount_cents')::bigint) from latest p
                 where p.tbl = 'check_lines' and p.v->>'kind' = 'discount' and p.v->>'check_id' = d.v->>'check_id'))::text
         from latest d where tbl = 'check_discounts' and v->>'removed_at' is null and v->>'business_date' = $2 group by 1
       union all
       select v->>'requested_by', 'refund', sum((v->>'amount_cents')::bigint)::text
         from latest where tbl = 'refunds' and v->>'business_date' = $2 group by 1
       union all
       select v->>'taken_by', v->>'kind', sum((v->>'amount_cents')::bigint)::text
         from latest where tbl = 'drawer_moves' and v->>'kind' in ('no_sale', 'paid_out') group by 1, 2
       union all
       select v->>'counted_by', 'over_short', sum((v->>'over_short_cents')::bigint)::text
         from latest where tbl = 'drawer_sessions' and v->>'counted_by' is not null
          and (v->>'over_short_cents')::bigint <> 0 group by 1`,
      [venueId, FRI],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(7);
    for (const a of audit.rows) {
      const p = people.find((x) => x.user_id === a.who)!;
      expect({ who: p.name, kind: a.kind, cents: p.actions[a.kind]!.cents }).toEqual({
        who: p.name,
        kind: a.kind,
        cents: Number(a.cents),
      });
    }
    // And each person's dollars are the sum of the rows they open.
    for (const p of people)
      for (const [kind, a] of Object.entries(p.actions))
        expect(
          p.entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amount_cents, 0),
        ).toBe(a.cents);
  });

  it("reads the same as the API's own role (app_rw), behind the venue wall", async () => {
    const rows = await withVenue(app, { venueId }, (c) => staffActionRows(c, venueId, FRI, FRI));
    expect(rows.length).toBe(10);
  });

  it("takes a range, and refuses a backwards or too-long one", async () => {
    as("andy", "manager", "passkey", "dev_phone_andy");
    const before = (await get("/reports/staff-actions?from=2026-09-01&to=2026-09-24")).json<{
      people: Person[];
    }>();
    expect(before.people).toEqual([]);
    const week = (await get("/reports/staff-actions?from=2026-09-19&to=2026-09-25")).json<{
      people: Person[];
    }>();
    expect(person(week.people, "Maya S.").actions.comp).toEqual({ count: 1, cents: -1200 });
    expect((await get("/reports/staff-actions?from=2026-09-25&to=2026-09-24")).statusCode).toBe(
      400,
    );
    expect((await get("/reports/staff-actions?from=2026-01-01&to=2026-09-25")).statusCode).toBe(
      400,
    );
    expect((await get("/reports/staff-actions?from=2026-9-1")).statusCode).toBe(400);
  });

  it("refuses staff without the permission", async () => {
    as("maya", "bartender", "pin", "dev_bar_computer");
    expect((await get(`/reports/staff-actions?date=${FRI}`)).statusCode).toBe(403);
  });
});
