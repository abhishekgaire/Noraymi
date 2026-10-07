import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  recordRouterReading,
  withVenue,
} from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
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
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { outageEvidence, outageReport } from "./outage-drill.js";

/**
 * M8-07, the four outage drills rehearsed on the demo seed (Fri Sep 25, 2026) with the
 * simulated router, the bar computer's signed replay and the fake Stripe, ending in the drill
 * report: drill 1 puts the venue on backup internet, drills 3 and 4 queue rounds that replay as
 * asked to wait (one onto a paid check goes to Review after outage, one twice lands once), and
 * drill 4's break-glass Tap to Pay payments sit in Unmatched payments until a manager matches
 * them. The report's findings name every loose end and clear once each is decided.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let ids: Record<string, string>;
let jager: { variant_id: string; price_cents: number };
let bar: { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
let router: string;
const clock = new SimulatedClock(SEED_NOW);
const DATE = "2026-09-25";

const manager = () => ({
  "x-test-principal": JSON.stringify({
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  } as Principal),
});
const bartender = () => ({
  "x-test-principal": JSON.stringify({
    kind: "user",
    userId: ids["maya"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  } as Principal),
});

const round = (check: string, tab: string, id = randomUUID()) => ({
  order_id: id,
  business_date: DATE,
  queued_at: "2026-09-26T03:00:00Z",
  tab_id: tab,
  check_id: ids[check]!,
  tab_name: "Drill tab",
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
});

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
  return (res.json() as { results: { order_id: string; outcome: string; reason?: string }[] })
    .results;
}

const post = (path: string, body: unknown, headers: Record<string, string>) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: body as object,
  });

const evidence = () =>
  withVenue(owner, { venueId, requestId: "test:outage" }, (c) => outageEvidence(c, venueId, DATE));

/** A break-glass Tap to Pay payment, as the reconciler records one from Stripe (recordUnmatched). */
const tapToPay = async (last4: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into payments (venue_id, method, status, stripe_pi_id, amount_cents, card_brand, card_last4, business_date)
       values ($1, 'external', 'captured', $2, 100, 'visa', $3, $4) returning id`,
      [venueId, `pi_drill_${randomUUID().slice(0, 8)}`, last4, DATE],
    )
  ).rows[0]!.id;

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
        "insert into devices (venue_id, kind, name, public_key) values ($1, 'bar_computer', 'Bar drill', $2) returning id",
        [venueId, JSON.stringify(k.publicJwk)],
      )
    ).rows[0]!.id,
    key: k,
  };
  router = (
    await owner.query<{ id: string }>(
      "insert into devices (venue_id, kind, name) values ($1, 'router', 'Drill router') returning id",
      [venueId],
    )
  ).rows[0]!.id;
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

describe("the four outage drills, rehearsed against the simulated devices", () => {
  const tab = () => ids["tab_t2"]!;
  let held: string[] = [];
  let glass: string[] = [];

  it("drill 1: the line drops and the router moves onto LTE, and the report shows the switch", async () => {
    const now = new Date(SEED_NOW.epochMilliseconds);
    for (const onBackupNow of [true, false])
      await withVenue(owner, { venueId, requestId: "test:router" }, (c) =>
        recordRouterReading(
          c,
          venueId,
          router,
          { cellularBackup: true, onBackupNow, source: "maker_api" },
          now,
        ),
      );
    // Events are stamped by the database's clock; place them on the seed's night.
    await owner.query("update venue_events set at = $2 where venue_id = $1 and entity_id = $3", [
      venueId,
      now,
      router,
    ]);
    const e = await evidence();
    expect(e.events.filter((v) => v.type === "venue.backup_internet")).toHaveLength(2);
    expect(e.events[0]!.device).toBe("Drill router");
  });

  it("drills 3 and 4: queued rounds replay as asked to wait, the same queue twice lands once, a paid check goes to Review after outage", async () => {
    const a = round("chk_t2", tab());
    const b = round("chk_t2", tab());
    const first = await replay([a, b]);
    expect(first.map((r) => r.outcome)).toEqual(["held", "held"]);
    const again = await replay([a, b]);
    expect(again.map((r) => r.outcome)).toEqual(["held", "held"]);
    await owner.query("update checks set status = 'paid' where id = $1", [ids["chk_room9"]]);
    const paid = await replay([round("chk_room9", ids["chk_room9"]!)]);
    expect(paid[0]).toMatchObject({ outcome: "failed", reason: "check_paid" });
    await owner.query("update checks set status = 'open' where id = $1", [ids["chk_room9"]]);
    held = (
      await owner.query<{ id: string }>(
        "select id from orders where client_order_id = any($1::text[]) order by client_order_id",
        [[a.order_id, b.order_id]],
      )
    ).rows.map((r) => r.id);
    expect(held).toHaveLength(2);
    const e = await evidence();
    expect(e.replays).toMatchObject({ queued: 3, held: 2, failed: 1, orders: { held: 2 } });
    expect(e.replays.failedReasons).toEqual({ check_paid: 1 });
    expect(e.findings.filter((f) => f.includes("Confirm replayed orders"))).toHaveLength(2);
    expect(e.findings.some((f) => f.includes("charged twice"))).toBe(false);
  });

  it("drill 4: a break-glass tap on each manager's phone waits in Unmatched payments", async () => {
    glass = [await tapToPay("4242"), await tapToPay("1881")];
    const e = await evidence();
    expect(e.breakGlass.map((g) => g.matchedTo)).toEqual([null, null]);
    expect(e.findings.filter((f) => f.includes("Unmatched payments"))).toHaveLength(2);
    const list = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/offline-orders?business_date=${DATE}`,
      headers: manager(),
    });
    expect((list.json() as { unmatched: { id: string }[] }).unmatched.map((u) => u.id)).toEqual(
      expect.arrayContaining(glass),
    );
  });

  it("after the drills: a bartender decides each replayed round, a manager matches each tap, and the report has no findings", async () => {
    expect((await post(`/orders/${held[0]}/accept`, {}, bartender())).statusCode).toBe(200);
    expect(
      (await post(`/orders/${held[1]}/cancel`, { for: "staff" }, bartender())).statusCode,
    ).toBe(200);
    for (const p of glass) {
      const m = await post(`/payments/${p}/match`, { check_id: ids["chk_t2"] }, manager());
      expect(m.statusCode).toBe(200);
    }
    const e = await evidence();
    expect(e.findings).toEqual([]);
    expect(e.replays.orders).toEqual({ accepted: 1, cancelled: 1 });
    expect(e.breakGlass.every((g) => g.matchedTo?.startsWith("check #"))).toBe(true);
    const report = outageReport("west4karaoke", e);
    for (const heading of ["Drill 1", "Drill 2", "Drill 3", "Drill 4", "Open Stripe question"])
      expect(report).toContain(heading);
    expect(report).toContain("**Findings:** none.");
  });
});
