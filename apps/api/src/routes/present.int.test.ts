import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  allocate,
  generateSigningKey,
  insertPayment,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { settleCheck } from "../rooms/present.js";

let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal;
const clock = new FrozenClock(SEED_NOW);
const night = "2026-09-25";
const person = (slug: string, role: "manager" | "front_desk"): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: "passkey",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role }],
});
const post = (path: string, payload?: unknown) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    ...(payload ? { payload } : {}),
  });
const room9 = () => ids["chk_room9"]!;
const pay = (checkId: string, cents: number) =>
  withVenue(app, { venueId }, async (c) => {
    const p = await insertPayment(c, venueId, {
      method: "cash",
      status: "captured",
      businessDate: night,
      amountCents: cents,
    });
    await allocate(c, venueId, { paymentId: p, checkId, amountCents: cents, state: "captured" });
    return settleCheck(c, venueId, checkId, clock.now());
  });

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
  who = person("andy", "manager");
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
  // Marcus's $120.00 deposit, allocated to the check (check-in does this from M4-09).
  await withVenue(app, { venueId }, async (c) => {
    const p = await insertPayment(c, venueId, {
      method: "card_online",
      status: "captured",
      businessDate: night,
      amountCents: 12000,
      bookingId: ids["bk_marcus"]!,
    });
    await allocate(c, venueId, {
      paymentId: p,
      checkId: room9(),
      amountCents: 12000,
      state: "captured",
      followsLines: true,
    });
  });
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("presenting Room 9's check", () => {
  it("is refused with 409 orders_open while o1 rings, and the same while it's asked to wait", async () => {
    const r = await post(`/checks/${room9()}/present`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "orders_open",
      details: {
        orders: [{ order_id: ids["order_o1"], status: "ringing", items: "2 × Margarita · Peach" }],
      },
    });
    await owner.query("update orders set status = 'held' where id = $1", [ids["order_o1"]]);
    expect((await post(`/checks/${room9()}/present`)).json().error.details.orders[0].status).toBe(
      "held",
    );
  });

  it("finalizes #1042 at $618.60 once o1 is cancelled, locks ordering and tells the room", async () => {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    const r = await post(`/checks/${room9()}/present`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: "finalized", revision: 1, total_cents: 61860 });
    const session = (
      await owner.query("select ordering_locked, room_id from room_sessions where id = $1", [
        ids["sess_room9"],
      ])
    ).rows[0];
    expect(session.ordering_locked).toBe(true);
    // The request's transaction commits as the reply goes out, so the rows can land a moment later.
    await expect
      .poll(
        async () =>
          (
            await owner.query(
              "select type, room_id from venue_events where entity_id in ($1, $2) and type in ('check.updated', 'session.updated') and room_id is not null",
              [room9(), ids["sess_room9"]],
            )
          ).rows,
      )
      .toEqual(
        expect.arrayContaining([
          { type: "check.updated", room_id: session.room_id },
          { type: "session.updated", room_id: session.room_id },
        ]),
      );
    const staffOrder = await post(`/checks/${room9()}/orders`, {
      lines: [{ variant_id: ids["menu_redbull_regular"], qty: 1, option_ids: [] }],
    });
    expect(staffOrder.json().error.code).toBe("ordering_closed");
  });

  it("can't be reopened by the front desk; Andy reopens it, the margaritas are ordered again, and revision 2 is $652.11 with $532.11 left", async () => {
    who = person("diego", "front_desk");
    expect((await post(`/checks/${room9()}/reopen`)).statusCode).toBe(403);
    who = person("andy", "manager");
    expect((await post(`/checks/${room9()}/reopen`)).json()).toMatchObject({ status: "reopened" });
    expect(
      (
        await owner.query("select ordering_locked from room_sessions where id = $1", [
          ids["sess_room9"],
        ])
      ).rows[0].ordering_locked,
    ).toBe(false);
    const item = (
      await owner.query("select variant_id, options from order_items where order_id = $1", [
        ids["order_o1"],
      ])
    ).rows[0];
    const peach = (await owner.query("select id from menu_options where name = 'Peach' limit 1"))
      .rows[0].id;
    const again = await post(`/checks/${room9()}/orders`, {
      lines: [{ variant_id: item.variant_id, qty: 2, option_ids: [peach] }],
    });
    expect(again.statusCode, again.body).toBe(201);
    const r = await post(`/checks/${room9()}/present`);
    expect(r.json()).toMatchObject({ revision: 2, total_cents: 65211 });
    const due = await withVenue(
      app,
      { venueId },
      async (c) => (await c.query("select amount_due($1) as d", [room9()])).rows[0].d,
    );
    expect(Number(due)).toBe(53211);
  });

  it("paid in full sends Room 9 to cleaning, unless an order on the room still rings (named)", async () => {
    await owner.query("update orders set status = 'ringing', cancel_reason = null where id = $1", [
      ids["order_o1"],
    ]);
    const held = await pay(room9(), 53211);
    expect(held).toMatchObject({
      status: "paid",
      due_cents: 0,
      room: {
        released: false,
        blocked_by: [{ order_id: ids["order_o1"], items: "2 × Margarita · Peach" }],
      },
    });
    const check = (await owner.query("select status, paid_at from checks where id = $1", [room9()]))
      .rows[0];
    expect(check.status).toBe("paid");
    expect(check.paid_at).not.toBeNull();
    expect(
      (await owner.query("select ended_at from room_sessions where id = $1", [ids["sess_room9"]]))
        .rows[0].ended_at,
    ).toBeNull();
  });

  it("an order accepted after the check is paid opens a new check, and the room waits for it to be paid", async () => {
    const r = await post(`/orders/${ids["order_o1"]}/accept`);
    expect(r.statusCode, r.body).toBe(200);
    const fresh = (
      await owner.query<{ check_id: string; number: string; status: string }>(
        "select o.check_id, k.number, k.status from orders o join checks k on k.id = o.check_id where o.id = $1",
        [ids["order_o1"]],
      )
    ).rows[0]!;
    expect(fresh.check_id).not.toBe(room9());
    expect(fresh.status).toBe("open");
    const lines = await owner.query("select amount_cents from check_lines where check_id = $1", [
      fresh.check_id,
    ]);
    expect(lines.rows.map((l) => Number(l.amount_cents))).toEqual([2600]);
    // Paying the new check releases the room.
    await owner.query("update checks set status = 'finalized' where id = $1", [fresh.check_id]);
    const done = await pay(fresh.check_id, 2600);
    expect(done).toMatchObject({ status: "paid", room: { released: true } });
    const room = (
      await owner.query(
        "select state from room_states where room_id = (select room_id from room_sessions where id = $1)",
        [ids["sess_room9"]],
      )
    ).rows[0];
    expect(room?.state).toBe("cleaning");
  });
});
