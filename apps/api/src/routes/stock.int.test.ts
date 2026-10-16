import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  generateSigningKey,
  holdStockOuts,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  makeDeviceKey,
  newYorkCounty,
  newYorkCountyTaxed,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * P-16 · Inventory on the demo seed (Fri Sep 25, 2026, 10:41 PM): off by default and refused while
 * off; Receive, Count and Adjust (with a reason); a sale takes the count down once, a void not made
 * puts it back and a made one doesn't; a replayed offline round counts once, at Accept; at zero the
 * item 86's itself and comes back with the count, and a closed night keeps it out; the low level
 * pushes the managers; Reports → Stock adds it up by date; every move is audited.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let jager: { item_id: string; variant_id: string; price_cents: number };
let bar: { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
const clock = new SimulatedClock(SEED_NOW);

const person = (slug: string, role: string): Principal =>
  ({
    kind: "user",
    userId: ids[slug]!,
    session: role === "manager" || role === "owner" ? "passkey" : "pin",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role }],
  }) as never;
const as = (slug: string, role: string) => ({
  "x-test-principal": JSON.stringify(person(slug, role)),
});
const andy = () => as("andy", "manager");

const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown, who = andy()) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: { ...who, ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const onHand = async () =>
  (
    await owner.query<{ on_hand: number }>(
      "select on_hand from stock_levels where venue_id = $1 and item_id = $2",
      [venueId, jager.item_id],
    )
  ).rows[0]?.on_hand;
const outTonight = async () =>
  (
    await owner.query<{ out: boolean }>(
      "select coalesce(out_until > $2::timestamptz, false) as out from menu_items where id = $1",
      [jager.item_id, SEED_NOW.toString()],
    )
  ).rows[0]!.out;
const sell = (qty: number) =>
  call("POST", `/checks/${ids["chk_room9"]}/orders`, {
    lines: [{ variant_id: jager.variant_id, qty }],
  });
const lastSale = async () =>
  Number(
    (
      await owner.query<{ id: string }>(
        "select id from check_lines where check_id = $1 and kind = 'item' order by id desc limit 1",
        [ids["chk_room9"]],
      )
    ).rows[0]!.id,
  );
const setting = (key: string, value: object) =>
  owner.query(
    `insert into venue_settings (venue_id, key, version, value, starts_on, saved_at, saved_by)
     select $1, $2, coalesce(max(version), 0) + 1, $3, '2026-09-01', now(), $4
       from venue_settings where venue_id = $1 and key = $2`,
    [venueId, key, JSON.stringify(value), ids["andy"]],
  );
const moduleState = (state: "on" | "off") =>
  owner.query(
    `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'inventory', true, $2)
     on conflict (venue_id, module_id) do update set state = $2, allowed = true`,
    [venueId, state],
  );

async function replay(orders: unknown[]) {
  const path = `/v1/venues/${venueId}/offline-orders/replay`;
  const payload = JSON.stringify({ orders });
  const headers = await signDeviceRequest({
    deviceId: bar.id,
    privateKey: bar.key.privateKey,
    method: "POST",
    path,
    body: payload,
  });
  const res = await api.inject({
    method: "POST",
    url: path,
    headers: { ...headers, "content-type": "application/json" },
    payload,
  });
  expect(res.statusCode).toBe(200);
}

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
  jager = (
    await owner.query<{ item_id: string; variant_id: string; price_cents: number }>(
      `select i.id as item_id, v.id as variant_id, v.price_cents from menu_variants v
         join menu_items i on i.id = v.item_id
        where i.venue_id = $1 and i.name = 'Jäger Bomb' limit 1`,
      [venueId],
    )
  ).rows[0]!;
  const k = await makeDeviceKey();
  bar = {
    id: (
      await owner.query<{ id: string }>(
        "insert into devices (venue_id, kind, name, public_key) values ($1, 'bar_computer', 'Bar test', $2) returning id",
        [venueId, JSON.stringify(k.publicJwk)],
      )
    ).rows[0]!.id,
    key: k,
  };
  // Voids run at once here: approvals are the venue's setting and not what this tests.
  await setting("approvals", { mode: "none" });
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request) => {
        const raw = request.headers["x-test-principal"];
        return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
      },
    ],
  });
  await api.ready();
});
afterAll(async () => {
  await api?.close();
  await app?.end();
  await owner?.end();
  await db?.drop();
});

describe("inventory", () => {
  it("is off by default, and the server refuses it while off", async () => {
    const off = await call("GET", "/stock");
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe("module_off");
    expect(
      (await call("PUT", `/stock/${jager.item_id}`, { counting: true })).json().error.code,
    ).toBe("module_off");
    await moduleState("on");
  });

  it("starts counting an item; Receive, Count and Adjust move it, Adjust only with a reason", async () => {
    const start = await call("PUT", `/stock/${jager.item_id}`, { counting: true, low_at: 2 });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ on_hand: 0, low_at: 2, counting: true });
    expect(
      (await call("POST", `/stock/${jager.item_id}/count`, { on_hand: 6 })).json().on_hand,
    ).toBe(6);
    expect((await call("POST", `/stock/${jager.item_id}/receive`, { qty: 4 })).json().on_hand).toBe(
      10,
    );
    expect((await call("POST", `/stock/${jager.item_id}/receive`, { qty: 0 })).statusCode).toBe(
      400,
    );
    expect((await call("POST", `/stock/${jager.item_id}/adjust`, { delta: -1 })).statusCode).toBe(
      400,
    );
    const adj = await call("POST", `/stock/${jager.item_id}/adjust`, {
      delta: -1,
      reason: "Dropped a bottle",
    });
    expect(adj.json().on_hand).toBe(9);
    // A bartender can't, and an item of no venue's is not found.
    expect(
      (await call("POST", `/stock/${jager.item_id}/receive`, { qty: 1 }, as("maya", "bartender")))
        .statusCode,
    ).toBe(403);
    expect((await call("POST", `/stock/${randomUUID()}/receive`, { qty: 1 })).statusCode).toBe(404);
  });

  it("a sale takes it down once; a void not made puts it back, a made one doesn't", async () => {
    expect((await sell(2)).statusCode).toBe(201);
    expect(await onHand()).toBe(7);
    const line = await lastSale();
    const notMade = await call("POST", `/checks/${ids["chk_room9"]}/lines/${line}/void`, {
      reason: "Rang the wrong one",
      made: false,
      qty: 1,
    });
    expect(notMade.statusCode).toBeLessThan(300);
    expect(await onHand()).toBe(8);
    const made = await call("POST", `/checks/${ids["chk_room9"]}/lines/${line}/void`, {
      reason: "Spilled",
      made: true,
      qty: 1,
    });
    expect(made.statusCode).toBeLessThan(300);
    expect(await onHand()).toBe(8);
  });

  it("nothing moves while the module is off", async () => {
    await moduleState("off");
    expect((await sell(1)).statusCode).toBe(201);
    expect(await onHand()).toBe(8);
    await moduleState("on");
  });

  it("a replayed offline round counts once, when it's accepted", async () => {
    const round = {
      order_id: randomUUID(),
      business_date: "2026-09-25",
      queued_at: "2026-09-26T02:30:00Z",
      tab_id: ids["tab_t2"],
      check_id: ids["chk_t2"],
      tab_name: "Luis M.",
      staff: { membership_id: ids["maya.membership"]!, name: "Maya S." },
      lines: [
        {
          variant_id: jager.variant_id,
          name: "Jäger Bomb",
          qty: 1,
          unit_cents: jager.price_cents,
          alcohol: true,
        },
      ],
      cash_note: null,
    };
    await replay([round]);
    await replay([round]);
    expect(await onHand()).toBe(8);
    const held = await owner.query<{ id: string }>(
      "select id from orders where client_order_id = $1",
      [round.order_id],
    );
    expect(held.rowCount).toBe(1);
    const accept = await call(
      "POST",
      `/orders/${held.rows[0]!.id}/accept`,
      {},
      as("maya", "bartender"),
    );
    expect(accept.statusCode).toBe(200);
    expect(await onHand()).toBe(7);
  });

  it("at zero the item 86's itself, the low level pushes, and receiving brings it back", async () => {
    await call("POST", `/stock/${jager.item_id}/count`, { on_hand: 3 });
    expect((await sell(1)).statusCode).toBe(201);
    const pushes = await owner.query<{ n: string }>(
      "select count(*) as n from jobs where venue_id = $1 and kind = 'push.send' and dedupe_key like 'low-stock:%'",
      [venueId],
    );
    expect(Number(pushes.rows[0]!.n)).toBe(2);
    expect(await outTonight()).toBe(false);
    expect((await sell(2)).statusCode).toBe(201);
    expect(await onHand()).toBe(0);
    expect(await outTonight()).toBe(true);
    expect((await call("GET", "/stock")).json().levels[0]).toMatchObject({
      on_hand: 0,
      low: true,
      out_tonight: true,
      auto_out: true,
    });
    // A night closed with it at zero keeps it out through the next one (till Sun 6:00 AM).
    await owner.query("update menu_items set out_until = null where id = $1", [jager.item_id]);
    await withVenue(app, { venueId }, (c) => holdStockOuts(c, venueId, "2026-09-25"));
    const until = await owner.query<{ until: Date }>(
      "select out_until as until from menu_items where id = $1",
      [jager.item_id],
    );
    expect(until.rows[0]!.until.toISOString()).toBe("2026-09-27T10:00:00.000Z");
    expect(
      (await call("POST", `/stock/${jager.item_id}/receive`, { qty: 12 })).json(),
    ).toMatchObject({ on_hand: 12, out_tonight: false, auto_out: false });
  });

  it("with 86 at zero turned off, a sale to zero leaves it on sale", async () => {
    await setting("inventory", { autoEightySix: false });
    await call("POST", `/stock/${jager.item_id}/count`, { on_hand: 1 });
    expect((await sell(1)).statusCode).toBe(201);
    expect(await onHand()).toBe(0);
    expect(await outTonight()).toBe(false);
    await setting("inventory", { autoEightySix: true });
  });

  it("Reports → Stock adds up on hand, used, received and adjusted by date; every move is audited", async () => {
    const r = await call("GET", "/stock/report?from=2026-09-25&to=2026-09-25");
    expect(r.statusCode).toBe(200);
    // Used: 2 − 1 (void not made) + 1 (replayed) + 1 + 2 + 1 = 6. Received 4 + 12. Adjusted:
    // counts 0→6, 7→3, 12→1, and −1 with a reason.
    expect(r.json().levels[0]).toMatchObject({
      item: "Jäger Bomb",
      on_hand: 0,
      used: 6,
      received: 16,
      adjusted: 6 - 4 - 11 - 1,
    });
    expect((await call("GET", "/stock/report?from=2026-09-26&to=2026-09-25")).statusCode).toBe(400);
    const audit = await owner.query<{ n: string }>(
      "select count(*) as n from audit_log where venue_id = $1 and action like 'stock_moves.%'",
      [venueId],
    );
    expect(Number(audit.rows[0]!.n)).toBeGreaterThanOrEqual(10);
  });

  it("stops counting an item: sales no longer move it", async () => {
    expect(
      (await call("PUT", `/stock/${jager.item_id}`, { counting: false })).json().counting,
    ).toBe(false);
    expect((await sell(1)).statusCode).toBe(201);
    expect(await onHand()).toBe(0);
  });
});
