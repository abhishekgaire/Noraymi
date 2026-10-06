import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { reconcileVenue } from "../payments/reconcile.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { TAB_CANCEL_HOLD_KIND } from "../tabs/pay.js";

/**
 * Paying a tab with another card or cash (M6-11; Payment flows · Paying with a different card, Bar tab
 * step 7; Money rules 12): Hana K.'s $43.55 on another card is charged first, and only then is her
 * $50.00 hold on Visa ··5120 canceled; a declined new card leaves the hold standing; Seat 6's $13.07 in
 * cash opens the bar drawer, cancels the hold and closes the tab; and an API killed between the new
 * card's success and the hold's cancel leaves the reconciler to cancel it, with nothing charged twice.
 * A split's last share paid in cash replaces the hold too (lifting M6-10's `held_card_last`).
 */

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
let stripeClient: StripeClient;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

async function stripeReader() {
  const r = await owner.query<{ s: string }>(
    "select stripe_reader_id as s from devices where id = $1",
    [readerId],
  );
  return r.rows[0]!.s;
}
async function presentCard(number: string, extra = "") {
  const res = await fetch(
    `${fakeBase}/v1/test_helpers/terminal/readers/${await stripeReader()}/present_payment_method`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "stripe-account": account,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `present-${++n}`,
      },
      body: `card_present[number]=${number}${extra}`,
    },
  );
  expect(res.status).toBe(200);
}
async function drain() {
  for (let i = 0; i < 5; i++) while ((await worker.tick()) > 0);
}
const consent = async () =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs/consent` })).json<{
    version_id: string;
    version: number;
    text: string;
    asks_party_size: boolean;
  }>();
const open = async (body: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/tabs`,
    headers: { "idempotency-key": `open-${++n}` },
    payload: { reader_id: readerId, consent_text_version: (await consent()).version_id, ...body },
  });
const checkStatus = async (o: string) =>
  (
    await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/openings/${o}/check-status`,
    })
  ).json<{
    state: string;
    payment: { id: string; state: string };
    card: { brand: string; last4: string } | null;
    tab: { id: string; check_id: string; name: string } | null;
  }>();
const intentOf = async (paymentId: string) => {
  const r = await owner.query<{ pi: string }>(
    "select stripe_pi_id as pi from payments where id = $1",
    [paymentId],
  );
  return fake.objects.get(r.rows[0]!.pi) as Record<string, unknown>;
};

const v = (item: string) => ids[`menu_${item}_regular`]!;
const send = (
  checkId: string,
  lines: { variant_id: string; qty: number }[],
  key = `round-key-${++n}`,
) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${checkId}/orders`,
    payload: { client_order_id: key, lines },
  });
/** A tab opened card first (M6-06): the guest taps, the hold is placed. */
async function openTab(name: string, number: string, extra = "") {
  const reader = fake.objects.get(await stripeReader()) as { action: unknown };
  reader.action = null;
  // The reader is heard from at the venue's clock (a test above moves it on).
  await owner.query(
    "update device_heartbeats set last_seen_at = $2, offline_since = null where device_id = $1",
    [readerId, clock.now().toString()],
  );
  const r = await open({ name });
  expect(r.statusCode, r.body).toBe(201);
  const o = r.json<{ id: string; payment: { id: string } }>();
  await presentCard(number, extra);
  await drain();
  const done = await checkStatus(o.id);
  expect(done.state).toBe("opened");
  return { ...done.tab!, paymentId: o.payment.id };
}
const payment = async (id: string) =>
  (
    await owner.query<{ authorized: number; used: number; status: string }>(
      "select authorized_cents::int as authorized, increments_used as used, status from payments where id = $1",
      [id],
    )
  ).rows[0]!;
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
  const stripe = new StripeClient(fakeStripeSettings(fakeBase), fetch, 15_000);
  stripeClient = stripe;
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
    authenticators: [
      async (request: FastifyRequest) => {
        // Maya at the bar computer, paired to the bar drawer.
        (request as unknown as { session: unknown }).session = {
          deviceId: ids["dev_bar_computer"],
        };
        return who;
      },
    ],
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

const pay = (tabId: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/tabs/${tabId}/pay`,
    headers: { "idempotency-key": `pay-${++n}` },
    payload: body,
  });
const tabRow = async (tabId: string) =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs` }))
    .json<{
      tabs: {
        id: string;
        state: string;
        rest_cents: number;
        hold: unknown;
        split: { shares: { id: string; amount_cents: number; state: string }[] } | null;
      }[];
    }>()
    .tabs.find((t) => t.id === tabId)!;
const checkStatusOf = async (checkId: string) =>
  (await owner.query<{ status: string }>("select status from checks where id = $1", [checkId]))
    .rows[0]!.status;
/** The order Stripe heard things in: each request's path. */
const heard = () => fake.requests.map((r) => `${r.method} ${r.path}`);
/** A card that can't grow (M6-07): the round fits under its cap, so the hold stays $50.00. */
const NOGROW = "&card_present[incremental]=false";
/** The screen reads Stripe now (as TapPayment does every 2 s), then the jobs written run. */
async function settle(paymentId: string) {
  await drain();
  const r = await app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/payments/${paymentId}/check-status`,
  });
  expect(r.statusCode, r.body).toBe(200);
  await drain();
  return r.json<{ state: string }>();
}
const hanaRound = () => [
  { variant_id: v("chamisul"), qty: 1 },
  { variant_id: v("sj_peach"), qty: 1 },
];

describe("Pay a tab with another card or cash (Payment flows · Paying with a different card)", () => {
  it("Hana K. pays $43.55 with another card: charged first, then her $50.00 hold on Visa ··5120 is canceled and the tab closes", async () => {
    const tab = await openTab("Hana K.", "4000000000005120", NOGROW);
    expect((await send(tab.check_id, hanaRound())).statusCode).toBe(201);
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized", authorized: 5000 });
    const row = await tabRow(tab.id);
    expect(row.rest_cents).toBe(4355);

    const r = await pay(tab.id, { method: "tap", amount_cents: 4355, reader_id: readerId });
    expect(r.statusCode, r.body).toBe(201);
    const newId = r.json<{ id: string; state: string }>().id;
    // While the new card is being taken the hold stands, and the tab takes no more drinks.
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
    expect((await send(tab.check_id, hanaRound())).statusCode).not.toBe(201);
    await presentCard("4242424242424242");
    expect(await settle(newId)).toMatchObject({ state: "paid" });

    const fresh = await intentOf(newId);
    expect(fresh).toMatchObject({ status: "succeeded", amount_received: 4355 });
    const old = await intentOf(tab.paymentId);
    expect(old["status"]).toBe("canceled");
    expect(old["amount_received"] ?? 0).toBe(0);
    // Stripe heard the new card's charge before the old hold's cancel.
    const log = heard();
    const oldPi = String(old["id"]);
    const cancelAt = log.indexOf(`POST /v1/payment_intents/${oldPi}/cancel`);
    expect(cancelAt).toBeGreaterThan(-1);
    expect(log.filter((l) => l === `POST /v1/payment_intents/${oldPi}/cancel`)).toHaveLength(1);
    expect(log.slice(0, cancelAt).some((l) => l.includes("process_payment_intent"))).toBe(true);
    expect(await payment(tab.paymentId)).toMatchObject({ status: "canceled" });
    expect(await payment(newId)).toMatchObject({ status: "captured" });
    expect(await tabRow(tab.id)).toMatchObject({ state: "closed" });
    expect(await checkStatusOf(tab.check_id)).toBe("paid");
    // The new card took over what the hold guaranteed: its captured allocation is all that stands.
    const allocations = await owner.query<{ payment_id: string; state: string; amount: number }>(
      "select payment_id, state, amount_cents::int as amount from payment_allocations where check_id = $1 and state <> 'released'",
      [tab.check_id],
    );
    expect(allocations.rows).toEqual([{ payment_id: newId, state: "captured", amount: 4355 }]);
  });

  it("a declined new card leaves the $50.00 hold in place, and the tab takes drinks again once it's canceled", async () => {
    const tab = await openTab("Hana K.", "4000000000005121", NOGROW);
    expect((await send(tab.check_id, hanaRound())).statusCode).toBe(201);
    const r = await pay(tab.id, { method: "tap", amount_cents: 4355, reader_id: readerId });
    expect(r.statusCode, r.body).toBe(201);
    const newId = r.json<{ id: string }>().id;
    await presentCard("4000000000000002");
    await settle(newId);
    const st = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${newId}/check-status`,
    });
    expect(st.json()).toMatchObject({ state: "declined" });
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized", authorized: 5000 });
    expect((await intentOf(tab.paymentId))["status"]).toBe("requires_capture");
    expect(await tabRow(tab.id)).toMatchObject({ state: "open" });
    expect(
      await owner.query("select 1 from jobs where kind = $1 and payload->>'payment_id' = $2", [
        TAB_CANCEL_HOLD_KIND,
        tab.paymentId,
      ]),
    ).toMatchObject({ rowCount: 0 });
    // Cancel: nothing charged, the hold still stands, and the tab takes drinks again.
    const cancel = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${newId}/cancel`,
      headers: { "idempotency-key": `cancel-${++n}` },
    });
    expect(cancel.statusCode, cancel.body).toBeLessThan(300);
    expect(await checkStatusOf(tab.check_id)).toBe("reopened");
    expect((await send(tab.check_id, [{ variant_id: v("chamisul"), qty: 1 }])).statusCode).toBe(
      201,
    );
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
  });

  it("Seat 6 pays $13.07 in cash: the bar drawer opens, the hold is canceled, and the tab closes", async () => {
    const tab = await openTab("Seat 6 · blue jacket", "378282246317712");
    expect((await send(tab.check_id, [{ variant_id: v("titos"), qty: 1 }])).statusCode).toBe(201);
    // A declined new card first: paying in cash sets it aside, and nothing is charged on it.
    const tap = await pay(tab.id, { method: "tap", amount_cents: 1307, reader_id: readerId });
    expect(tap.statusCode, tap.body).toBe(201);
    await presentCard("4000000000000002");
    expect(await settle(tap.json<{ id: string }>().id)).toMatchObject({ state: "declined" });
    const r = await pay(tab.id, { method: "cash", amount_cents: 1307, tendered_cents: 2000 });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      change_cents: 693,
      logged_to: { name: "Maya", drawer: "Bar drawer" },
      check_status: "paid",
      tab_state: "closed",
    });
    expect(await payment(tap.json<{ id: string }>().id)).toMatchObject({ status: "canceled" });
    const kick = await owner.query(
      "select station from print_jobs where kind = 'drawer' and payload->>'payment_id' = $1",
      [r.json<{ id: string }>().id],
    );
    expect(kick.rows).toEqual([{ station: "bar" }]);
    expect(await payment(tab.paymentId)).toMatchObject({ status: "canceled" });
    expect((await intentOf(tab.paymentId))["status"]).toBe("canceled");
    expect(await tabRow(tab.id)).toMatchObject({ state: "closed" });
    // The job written with the cash finds the hold already canceled: Stripe hears nothing more.
    const before = heard().length;
    await drain();
    expect(
      heard()
        .slice(before)
        .filter((l) => l.endsWith("/cancel")),
    ).toEqual([]);
  });

  it("a split's last share paid in cash replaces the hold (M6-10's held_card_last lifted)", async () => {
    const tab = await openTab("Jess P.", "4000000000004418");
    expect(
      (
        await send(tab.check_id, [
          { variant_id: v("modelo"), qty: 2 },
          { variant_id: v("jager"), qty: 1 },
        ])
      ).statusCode,
    ).toBe(201);
    const s = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/${tab.id}/split`,
      payload: { shares: 2 },
    });
    expect(s.statusCode, s.body).toBe(201);
    // Paying the whole tab another way while it's split is refused: the shares pay one by one.
    const whole = await pay(tab.id, { method: "cash", amount_cents: 3266, tendered_cents: 4000 });
    expect(whole.json().error.details.reason).toBe("split_open");
    for (const share of (await tabRow(tab.id)).split!.shares) {
      const r = await app.inject({
        method: "POST",
        url: `/v1/venues/${venueId}/checks/${tab.check_id}/payments`,
        headers: { "idempotency-key": `cash-${++n}` },
        payload: {
          method: "cash",
          amount_cents: share.amount_cents,
          tendered_cents: 2000,
          share_id: share.id,
        },
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    await drain();
    expect(await payment(tab.paymentId)).toMatchObject({ status: "canceled" });
    expect(await tabRow(tab.id)).toMatchObject({ state: "closed" });
    expect(await checkStatusOf(tab.check_id)).toBe("paid");
  });

  it("killed after the new card succeeds and before the hold is canceled: the reconciler cancels it, and nothing is charged twice", async () => {
    const tab = await openTab("Luis M.", "5555555555554444", NOGROW);
    expect((await send(tab.check_id, hanaRound())).statusCode).toBe(201);
    const r = await pay(tab.id, { method: "tap", amount_cents: 4355, reader_id: readerId });
    expect(r.statusCode, r.body).toBe(201);
    const newId = r.json<{ id: string }>().id;
    await presentCard("4242424242424242");
    // The screen reads Stripe: the new card's success is recorded, with the hold's cancel written as a job.
    const read = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${newId}/check-status`,
    });
    expect(read.json()).toMatchObject({ state: "paid" });
    // The process dies on the cancel: every other job runs.
    const handlers = makePaymentHandlers({ pool: workerPool, stripe: stripeClient, clock });
    const dying = new Worker(workerPool, {
      pool: "critical",
      handlers: {
        ...handlers,
        [TAB_CANCEL_HOLD_KIND]: async () => {
          throw new Error("killed");
        },
      },
      clock,
    });
    for (let i = 0; i < 5; i++) while ((await dying.tick()) > 0);
    expect(await payment(newId)).toMatchObject({ status: "captured" });
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
    expect((await intentOf(tab.paymentId))["status"]).toBe("requires_capture");
    expect(await tabRow(tab.id)).toMatchObject({ state: "closed" });

    const done = await reconcileVenue({ pool: workerPool, stripe: stripeClient, clock }, venueId);
    expect(done.resolved).toContain(tab.paymentId);
    expect(await payment(tab.paymentId)).toMatchObject({ status: "canceled" });
    const old = await intentOf(tab.paymentId);
    expect(old["status"]).toBe("canceled");
    expect(old["amount_received"] ?? 0).toBe(0);
    expect(await intentOf(newId)).toMatchObject({ status: "succeeded", amount_received: 4355 });
    // The job comes back after its backoff and finds nothing to do; the reconciler too.
    await owner.query("update jobs set run_at = now() - interval '1 minute' where kind = $1", [
      TAB_CANCEL_HOLD_KIND,
    ]);
    await drain();
    await reconcileVenue({ pool: workerPool, stripe: stripeClient, clock }, venueId);
    expect(
      heard().filter((l) => l === `POST /v1/payment_intents/${String(old["id"])}/cancel`),
    ).toHaveLength(1);
    // One charge each: the new card's $43.55, nothing on the hold.
    expect(await payment(newId)).toMatchObject({ status: "captured" });
  });
});
