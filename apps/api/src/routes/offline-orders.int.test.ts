import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  makeDeviceKey,
  newYorkCounty,
  newYorkCountyTaxed,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * M8-05, the offline replay tests on the demo seed (Fri Sep 25, 2026, 10:41 PM): the bar
 * computer uploads the rounds it queued in an outage. Each lands as asked to wait (held,
 * source offline) and stays off the tab until a bartender accepts it; never onto a paid check
 * or an earlier night, those go to Review after outage with the reason; the same upload twice
 * lands each round once; and a manager posts a round's offline cash on its check.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let ids: Record<string, string>;
let jager: { variant_id: string; price_cents: number };
let bar: { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
const clock = new SimulatedClock(SEED_NOW);

const person = (slug: string, role: string): Principal =>
  ({
    kind: "user",
    userId: ids[slug]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role }],
  }) as never;

const as = (slug: string, role: string) => ({
  "x-test-principal": JSON.stringify(person(slug, role)),
});

function round(
  check: string,
  tab: string,
  opts: { queuedAt?: string; cash?: string | null; qty?: number } = {},
) {
  return {
    order_id: randomUUID(),
    business_date: "2026-09-25",
    queued_at: opts.queuedAt ?? "2026-09-26T03:00:00Z",
    tab_id: tab,
    check_id: ids[check]!,
    tab_name: "Luis M.",
    staff: { membership_id: ids["maya.membership"]!, name: "Maya S." },
    lines: [
      {
        variant_id: jager.variant_id,
        name: "Jäger Bomb",
        qty: opts.qty ?? 1,
        unit_cents: jager.price_cents,
        alcohol: true,
      },
    ],
    cash_note: opts.cash ?? null,
  };
}

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
  return {
    status: res.statusCode,
    results: (res.json() as { results: { order_id: string; outcome: string; reason: string }[] })
      .results,
  };
}

const post = (path: string, body: unknown, headers: Record<string, string>) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: body as object,
  });

const linesOn = async (check: string) =>
  Number(
    (
      await owner.query<{ n: string }>(
        "select count(*) as n from check_lines where check_id = $1 and kind = 'item' and description like 'Jäger%'",
        [ids[check]],
      )
    ).rows[0]!.n,
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
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
    await owner.query<{ variant_id: string; price_cents: number }>(
      `select v.id as variant_id, v.price_cents from menu_variants v join menu_items i on i.id = v.item_id
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
  fake = new FakeStripe();
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
    stripe: new StripeClient(fakeStripeSettings(await fake.start())),
  });
  await api.ready();
});
afterAll(async () => {
  await api?.close();
  await fake?.stop();
  await owner?.end();
  await db?.drop();
});

describe("replaying the bar computer's queue", () => {
  const luis = () => ids["tab_t2"]!;

  it("lands three queued rounds as asked to wait, off the tab, and counts them on the banner", async () => {
    const before = await linesOn("chk_t2");
    const three = [round("chk_t2", luis()), round("chk_t2", luis()), round("chk_t2", luis())];
    const r = await replay(three);
    expect(r.status).toBe(200);
    expect(r.results.map((x) => x.outcome)).toEqual(["held", "held", "held"]);
    const orders = await owner.query<{ status: string; source: string; held_at: string | null }>(
      "select status, source, held_at from orders where client_order_id = any($1::text[])",
      [three.map((o) => o.order_id)],
    );
    expect(orders.rows).toHaveLength(3);
    for (const o of orders.rows) expect(o).toMatchObject({ status: "held", source: "offline" });
    expect(await linesOn("chk_t2")).toBe(before);
    const conn = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/connection`,
      headers: as("maya", "bartender"),
    });
    expect(conn.json()).toMatchObject({ replayed_waiting: 3 });
    // Clear them for the tests that follow: a bartender cancels each.
    const rows = await owner.query<{ id: string }>(
      "select id from orders where client_order_id = any($1::text[])",
      [three.map((o) => o.order_id)],
    );
    for (const o of rows.rows)
      expect(
        (await post(`/orders/${o.id}/cancel`, { for: "staff" }, as("maya", "bartender")))
          .statusCode,
      ).toBe(200);
  });

  it("uploading the same queue twice lands each order once", async () => {
    const two = [round("chk_t2", luis()), round("chk_t2", luis())];
    const first = await replay(two);
    const second = await replay(two);
    expect(second.results).toEqual(first.results);
    const n = await owner.query<{ n: string }>(
      "select count(*) as n from orders where client_order_id = any($1::text[])",
      [two.map((o) => o.order_id)],
    );
    expect(Number(n.rows[0]!.n)).toBe(2);
    const rec = await owner.query<{ n: string }>(
      "select count(*) as n from offline_replays where client_order_id = any($1::text[])",
      [two.map((o) => o.order_id)],
    );
    expect(Number(rec.rows[0]!.n)).toBe(2);
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'staff' where client_order_id = any($1::text[])",
      [two.map((o) => o.order_id)],
    );
  });

  it("a round rung online on Diego's phone and also queued is charged once", async () => {
    const before = await linesOn("chk_t2");
    const online = await post(
      `/checks/${ids["chk_t2"]}/orders`,
      { lines: [{ variant_id: jager.variant_id, qty: 1 }] },
      as("diego", "front_desk"),
    );
    expect(online.statusCode).toBe(201);
    expect(await linesOn("chk_t2")).toBe(before + 1);
    const copy = round("chk_t2", luis());
    expect((await replay([copy])).results[0]!.outcome).toBe("held");
    expect(await linesOn("chk_t2")).toBe(before + 1);
    const held = await owner.query<{ id: string }>(
      "select id from orders where client_order_id = $1",
      [copy.order_id],
    );
    const cancel = await post(
      `/orders/${held.rows[0]!.id}/cancel`,
      { for: "staff" },
      as("maya", "bartender"),
    );
    expect(cancel.statusCode).toBe(200);
    expect(await linesOn("chk_t2")).toBe(before + 1);
  });

  it("accepting a replayed round is the sale: its lines join the tab", async () => {
    const before = await linesOn("chk_t2");
    const r = round("chk_t2", luis());
    await replay([r]);
    const held = await owner.query<{ id: string }>(
      "select id from orders where client_order_id = $1",
      [r.order_id],
    );
    const accept = await post(`/orders/${held.rows[0]!.id}/accept`, {}, as("maya", "bartender"));
    expect(accept.statusCode).toBe(200);
    expect(await linesOn("chk_t2")).toBe(before + 1);
  });

  it("a round for Room 9 whose check was paid in the meantime goes to Review after outage", async () => {
    await owner.query("update checks set status = 'paid' where id = $1", [ids["chk_room9"]]);
    const before = await linesOn("chk_room9");
    const r = round("chk_room9", ids["chk_room9"]!);
    const answer = await replay([r]);
    expect(answer.results[0]).toMatchObject({ outcome: "failed", reason: "check_paid" });
    expect(await linesOn("chk_room9")).toBe(before);
    const order = await owner.query("select 1 from orders where client_order_id = $1", [
      r.order_id,
    ]);
    expect(order.rowCount).toBe(0);
    await owner.query("update checks set status = 'open' where id = $1", [ids["chk_room9"]]);
  });

  it("a round queued Fri Sep 25 and replayed after 6:00 AM Sat goes to Review after outage", async () => {
    const r = round("chk_t2", luis(), {
      queuedAt: "2026-09-26T03:30:00Z",
      cash: "$12 cash · Maya",
    });
    clock.set(Temporal.Instant.from("2026-09-26T10:05:00Z"));
    try {
      expect((await replay([r])).results[0]).toMatchObject({
        outcome: "failed",
        reason: "earlier_night",
      });
    } finally {
      clock.set(SEED_NOW);
    }
    const review = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/offline-orders?business_date=2026-09-25`,
      headers: as("andy", "manager"),
    });
    expect(review.statusCode).toBe(200);
    const body = review.json() as {
      orders: { order_id: string; outcome: string; reason: string | null; cash_note: string }[];
      unmatched: unknown[];
    };
    // Failed replays first, each with its reason.
    const firstHeld = body.orders.findIndex((o) => o.outcome === "held");
    const lastFailed = body.orders.map((o) => o.outcome).lastIndexOf("failed");
    expect(lastFailed).toBeLessThan(firstHeld);
    expect(body.orders.find((o) => o.order_id === r.order_id)).toMatchObject({
      reason: "earlier_night",
      cash_note: "$12 cash · Maya",
    });
    expect(Array.isArray(body.unmatched)).toBe(true);
    // A bartender doesn't see the review list.
    const bartender = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/offline-orders`,
      headers: as("maya", "bartender"),
    });
    expect(bartender.statusCode).toBe(403);
  });

  it("a manager posts a round's offline cash on its check, once", async () => {
    const r = round("chk_t2", luis(), { cash: "$13 cash · Maya" });
    await replay([r]);
    const held = await owner.query<{ id: string }>(
      "select id from orders where client_order_id = $1",
      [r.order_id],
    );
    await post(`/orders/${held.rows[0]!.id}/accept`, {}, as("maya", "bartender"));
    const replayId = (
      await owner.query<{ id: string }>(
        "select id from offline_replays where client_order_id = $1",
        [r.order_id],
      )
    ).rows[0]!.id;
    const posted = await post(
      `/offline-orders/${replayId}/cash`,
      { amount_cents: 1300 },
      as("andy", "manager"),
    );
    expect(posted.statusCode).toBe(201);
    const pay = await owner.query<{ method: string; amount_cents: string }>(
      "select method, amount_cents from payments where id = $1",
      [(posted.json() as { payment_id: string }).payment_id],
    );
    expect(pay.rows[0]).toMatchObject({ method: "cash" });
    expect(Number(pay.rows[0]!.amount_cents)).toBe(1300);
    const again = await post(
      `/offline-orders/${replayId}/cash`,
      { amount_cents: 1300 },
      as("andy", "manager"),
    );
    expect(again.statusCode).toBe(409);
    const notManager = await post(
      `/offline-orders/${replayId}/cash`,
      { amount_cents: 100 },
      as("maya", "bartender"),
    );
    expect(notManager.statusCode).toBe(403);
  });

  it("only a desktop computer replays, and a person can't", async () => {
    const res = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/offline-orders/replay`,
      headers: { ...as("maya", "bartender"), "content-type": "application/json" },
      payload: { orders: [round("chk_t2", luis())] },
    });
    expect(res.statusCode).toBe(403);
  });
});
