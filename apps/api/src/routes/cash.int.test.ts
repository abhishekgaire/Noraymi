import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  expectedInDrawer,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  recordCapture,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { DRAWER_MARKUP, drawerKickEpos, drawerKickEscPos } from "../print/ticket.js";

let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: { principal: Principal; deviceId: string | null };
const clock = new FrozenClock(SEED_NOW);
let n = 0;
const person = (slug: string, role: "manager" | "front_desk"): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: "pin",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role }],
});
const post = (path: string, payload?: unknown) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `cash-${++n}` },
    ...(payload ? { payload } : {}),
  });
const present = async (checkSlug: string) => {
  const r = await post(`/checks/${ids[checkSlug]}/present`);
  expect(r.statusCode, r.body).toBe(200);
  return (
    await api.inject({ method: "GET", url: `/v1/venues/${venueId}/checks/${ids[checkSlug]}` })
  ).json().amount_due_cents as number;
};

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
  who = { principal: person("diego", "front_desk"), deviceId: ids["dev_front_computer"]! };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest) => {
        // The screen the person signed in at: the front-desk computer, or a phone with no drawer.
        (request as unknown as { session: unknown }).session = who.deviceId
          ? { deviceId: who.deviceId }
          : undefined;
        return who.principal;
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

describe("cash", () => {
  it("Diego takes Room 9's $498.60 with $500.00 at the front desk: $1.40 change, the front-desk drawer opens, and the log names him", async () => {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    expect(await present("chk_room9")).toBe(49860);
    const r = await post(`/checks/${ids["chk_room9"]}/payments`, {
      method: "cash",
      amount_cents: 49860,
      tendered_cents: 50000,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      method: "cash",
      status: "captured",
      amount_cents: 49860,
      change_cents: 140,
      logged_to: { name: "Diego", drawer: "Front-desk drawer" },
      check_status: "paid",
    });
    const kick = await owner.query(
      "select kind, device_id, station from print_jobs where kind = 'drawer' and payload->>'payment_id' = $1",
      [r.json().id],
    );
    expect(kick.rows).toEqual([
      { kind: "drawer", device_id: ids["dev_front_printer"], station: "front_desk" },
    ]);
    const move = await owner.query(
      "select kind, amount_cents::int as amount, taken_by, device_id from drawer_moves where payment_id = $1",
      [r.json().id],
    );
    expect(move.rows).toEqual([
      { kind: "sale", amount: 49860, taken_by: ids["diego"], device_id: ids["dev_front_computer"] },
    ]);
  });

  it("Room 5's $51.55 with the next $20: $8.45 change; fixed to $100.00 it's $48.45, and the payment and the drawer's cash stay", async () => {
    // o2 (4 × Bud Light) still rings in Room 5: the guest cancels it first.
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o2"]],
    );
    expect(await present("chk_room5")).toBe(5155);
    const r = await post(`/checks/${ids["chk_room5"]}/payments`, {
      method: "cash",
      amount_cents: 5155,
      tendered_cents: 6000,
    });
    expect(r.json().change_cents).toBe(845);
    const session = (
      await owner.query("select id from drawer_sessions where drawer_id = $1", [
        ids["drawer_front"],
      ])
    ).rows[0].id;
    const expected = await withVenue(app, { venueId }, (c) =>
      expectedInDrawer(c, venueId, session),
    );
    const fixed = await post(`/payments/${r.json().id}/change`, { tendered_cents: 10000 });
    expect(fixed.json()).toMatchObject({ change_cents: 4845 });
    const row = (
      await owner.query(
        "select amount_cents::int as amount, tendered_cents::int as tendered, change_cents::int as change from payments where id = $1",
        [r.json().id],
      )
    ).rows[0];
    expect(row).toEqual({ amount: 5155, tendered: 6000, change: 845 });
    const detail = (
      await owner.query(
        "select detail from payment_events where payment_id = $1 and detail is not null",
        [r.json().id],
      )
    ).rows[0].detail;
    expect(detail).toMatchObject({ fixed: "change", tendered_cents: 10000, change_cents: 4845 });
    expect(await withVenue(app, { venueId }, (c) => expectedInDrawer(c, venueId, session))).toBe(
      expected,
    );
  });

  it("can't be changed after insert, even through the definer functions", async () => {
    const cash = (
      await owner.query<{ id: string }>("select id from payments where method = 'cash' limit 1")
    ).rows[0]!.id;
    await expect(
      withVenue(app, { venueId }, (c) =>
        recordCapture(c, cash, { amountCents: 1, tipCents: 0, surchargeCents: 0 }),
      ),
    ).rejects.toThrow(/no card payment/);
    await expect(
      withVenue(app, { venueId }, (c) =>
        c.query("update payments set tendered_cents = 1 where id = $1", [cash]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("cash Andy takes on his phone goes into his staff bank and opens no drawer; a $5.00 cash tip is the payment's tip", async () => {
    who = { principal: person("andy", "manager"), deviceId: null };
    expect(await present("chk_room3")).toBeGreaterThan(0);
    const due = (
      await api.inject({ method: "GET", url: `/v1/venues/${venueId}/checks/${ids["chk_room3"]}` })
    ).json().amount_due_cents;
    const r = await post(`/checks/${ids["chk_room3"]}/payments`, {
      method: "cash",
      amount_cents: due,
      tendered_cents: due + 500,
      tip_cents: 500,
    });
    expect(r.json()).toMatchObject({
      tip_cents: 500,
      change_cents: 0,
      logged_to: { name: "Andy", drawer: null },
    });
    const bank = (
      await owner.query("select cash_cents::int as cash from staff_banks where user_id = $1", [
        ids["andy"],
      ])
    ).rows[0];
    expect(bank.cash).toBe(due + 500);
    const kicks = await owner.query(
      "select 1 from print_jobs where kind = 'drawer' and payload->>'payment_id' = $1",
      [r.json().id],
    );
    expect(kicks.rowCount).toBe(0);
  });

  it("refuses less than what's owed", async () => {
    const r = await post(`/checks/${ids["chk_t1"]}/payments`, {
      method: "cash",
      amount_cents: 3000,
      tendered_cents: 2000,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toMatchObject({ reason: "short" });
  });

  it("renders the kick for each kind of printer", () => {
    expect([...drawerKickEscPos()]).toEqual([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect(drawerKickEpos("job-1")).toContain('<pulse drawer="drawer_1" time="pulse_100"/>');
    expect(DRAWER_MARKUP).toBe("[drawer]\n");
  });

  it("opens a drawer's session by hand only when none is open", async () => {
    const r = await post(`/drawers/${ids["drawer_bar"]}/open`);
    expect(r.json()).toMatchObject({ opened: false });
    const list = await api.inject({ method: "GET", url: `/v1/venues/${venueId}/drawers` });
    expect(list.json().drawers).toEqual([
      expect.objectContaining({ name: "Bar drawer", open: true, opening_cents: 30000 }),
      expect.objectContaining({ name: "Front-desk drawer", open: true, opening_cents: 30000 }),
    ]);
  });
});
