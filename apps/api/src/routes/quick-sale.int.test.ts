import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/** Quick sale (M6-05): a walk-up sale's own check, the reader's tip choices, cash, and a declined tap. */
let db: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let app: FastifyInstance;
let worker: Worker;
let fake: FakeStripe;
let account = "";
let fakeBase = "";
let venueId = "";
let ids: Record<string, string> = {};
let readerId = "";
const clock = new FrozenClock(SEED_NOW);
let n = 0;
const sell = (lines: { variant_id: string; qty: number }[]) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/quick-sales`,
    payload: { client_order_id: `quick-test-${++n}`, lines },
  });
const v = (item: string) => ids[`menu_${item}_regular`]!;
const readerAction = async () => {
  const r = await owner.query<{ s: string }>(
    "select stripe_reader_id as s from devices where id = $1",
    [readerId],
  );
  return (
    fake.objects.get(r.rows[0]!.s) as {
      action?: { process_payment_intent?: { process_config?: unknown } };
    }
  ).action?.process_payment_intent?.process_config;
};
async function presentCard(number: string) {
  const r = await owner.query<{ s: string }>(
    "select stripe_reader_id as s from devices where id = $1",
    [readerId],
  );
  const res = await fetch(
    `${fakeBase}/v1/test_helpers/terminal/readers/${r.rows[0]!.s}/present_payment_method`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "stripe-account": account,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `present-${++n}`,
      },
      body: `card_present[number]=${number}`,
    },
  );
  expect(res.status).toBe(200);
}
async function drain() {
  for (let i = 0; i < 5; i++) while ((await worker.tick()) > 0);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  workerPool = appPool(db.url);
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
  fake = new FakeStripe();
  fakeBase = await fake.start();
  const stripe = new StripeClient(fakeStripeSettings(fakeBase));
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  const maya: Principal = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  const abhishek: Principal = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  };
  let who: Principal = abhishek;
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await app.ready();
  const reg = await app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/readers`,
    payload: { registration_code: "simulated-s710", label: "Bar S710" },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  readerId = reg.json().reader?.id ?? reg.json().id;
  who = maya;
  worker = new Worker(workerPool, {
    pool: "critical",
    handlers: makePaymentHandlers({ pool: workerPool, stripe, clock }),
    clock,
  });
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await workerPool.end();
  await owner.end();
  await db.drop();
});

describe("Quick sale", () => {
  it("a $9.00 Modelo is its own quick check, finalized, with $1, $2 and $3 on the reader", async () => {
    const r = await sell([{ variant_id: v("modelo"), qty: 1 }]);
    expect(r.statusCode, r.body).toBe(201);
    const sale = r.json();
    expect(sale).toMatchObject({
      drinks_before_tax_cents: 900,
      tip_choices: { kind: "fixed", choices_cents: [100, 200, 300] },
      amount_due_cents: 980,
    });
    const k = await owner.query("select kind, status from checks where id = $1", [sale.check_id]);
    expect(k.rows[0]).toEqual({ kind: "quick", status: "finalized" });
  });

  it("$30.00 of drinks offers $5.40, $6.00 and $6.60, and the reader is told the drinks before tax", async () => {
    const sale = (
      await sell([
        { variant_id: v("modelo"), qty: 2 },
        { variant_id: v("jager"), qty: 1 },
      ])
    ).json();
    expect(sale.tip_choices).toEqual({ kind: "percent", choices_cents: [540, 600, 660] });
    const tap = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${sale.check_id}/payments`,
      headers: { "idempotency-key": `quick-tap-${n}` },
      payload: { method: "tap", amount_cents: sale.amount_due_cents, reader_id: readerId },
    });
    expect(tap.statusCode, tap.body).toBe(201);
    await drain();
    expect(await readerAction()).toEqual({ tipping: { amount_eligible: "3000" } }); // form-encoded, as Stripe gets it
    await presentCard("4242424242424242");
    await drain();
  });

  it("a walk-up Bud Light in cash: paid, and logged to Maya", async () => {
    const sale = (await sell([{ variant_id: v("bud"), qty: 1 }])).json();
    const cash = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${sale.check_id}/payments`,
      headers: { "idempotency-key": `quick-cash-${n}` },
      payload: { method: "cash", amount_cents: sale.amount_due_cents, tendered_cents: 1000 },
    });
    expect(cash.statusCode, cash.body).toBe(201);
    expect(cash.json().logged_to.name).toMatch(/^Maya/);
    const k = await owner.query("select status from checks where id = $1", [sale.check_id]);
    expect(k.rows[0].status).toBe("paid");
  });

  it("a retried Pay answers the same sale, and an empty round is refused", async () => {
    const body = { client_order_id: "quick-retry-1", lines: [{ variant_id: v("bud"), qty: 1 }] };
    const a = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/quick-sales`,
      payload: body,
    });
    const b = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/quick-sales`,
      payload: body,
    });
    expect(b.json().check_id).toBe(a.json().check_id);
    expect((await sell([])).json().error.details).toEqual({ reason: "empty" });
  });

  it("a declined tap leaves the sale to pay in cash; Back to the sale voids it, keeps its number and returns the drinks", async () => {
    const sale = (await sell([{ variant_id: v("bud"), qty: 2 }])).json();
    const number = (await owner.query("select number from checks where id = $1", [sale.check_id]))
      .rows[0].number;
    const tap = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${sale.check_id}/payments`,
      headers: { "idempotency-key": `quick-decline-${n}` },
      payload: { method: "tap", amount_cents: sale.amount_due_cents, reader_id: readerId },
    });
    expect(tap.statusCode, tap.body).toBe(201);
    await drain();
    await presentCard("4000000000000002");
    await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${tap.json().id}/check-status`,
    });
    await drain();
    const payment = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/payments/${tap.json().id}`,
    });
    expect(payment.json().state).toBe("declined");
    const back = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/quick-sales/${sale.check_id}/void`,
    });
    expect(back.statusCode, back.body).toBe(200);
    const k = await owner.query("select status, number from checks where id = $1", [sale.check_id]);
    expect(k.rows[0]).toEqual({ status: "void", number });
    const draft = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/drafts/quick` })
    ).json();
    expect(draft.lines).toEqual([{ variant_id: v("bud"), qty: 2, option_ids: [] }]);
  });
});
