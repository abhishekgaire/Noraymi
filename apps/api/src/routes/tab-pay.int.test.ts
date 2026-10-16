import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
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
import { barTabs } from "./nights.js";

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
    // A card payment never opens a drawer (M9-07: only cash and a no-sale do at the till).
    const kicks = await owner.query(
      "select 1 from print_jobs where kind = 'drawer' and payload->>'payment_id' = any($1::text[])",
      [[newId, tab.paymentId]],
    );
    expect(kicks.rowCount).toBe(0);
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

describe("a named tab without a card (P-03)", () => {
  const openCardless = (name: string) =>
    app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs`,
      headers: { "idempotency-key": `cardless-${++n}` },
      payload: { card: "none", name },
    });
  /** "Open a tab without a card": a new version of the tab settings with `cardRequired` set. */
  const cardRequired = (on: boolean) =>
    owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_at)
       select venue_id, key, version + 1, value || jsonb_build_object('cardRequired', $2::boolean),
              starts_on, saved_at
         from venue_settings where venue_id = $1 and key = 'tabs' order by version desc limit 1`,
      [venueId, on],
    );

  it("with the setting on (West 4's), a tab without a card is refused on the server", async () => {
    const r = await openCardless("Dana");
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(JSON.stringify(r.json())).toContain("card_required");
    const made = await owner.query("select 1 from tabs where venue_id = $1 and name = 'Dana'", [
      venueId,
    ]);
    expect(made.rows).toHaveLength(0);
    await cardRequired(true);
    expect((await openCardless("Dana")).statusCode).toBe(400);
    expect((await consent()) as unknown).toMatchObject({ card_required: true });
  });

  it("with it off, a named tab opens with no reader or hold, takes a round and closes in cash", async () => {
    await cardRequired(false);
    expect((await consent()) as unknown).toMatchObject({ card_required: false });
    const before = fake.requests.length;
    const r = await openCardless("Dana");
    expect(r.statusCode, r.body).toBe(201);
    const opened = r.json<{ tab: { id: string; check_id: string; name: string } }>().tab;
    expect(opened.name).toBe("Dana");
    // No reader and no hold: Stripe hears nothing.
    expect(fake.requests.length).toBe(before);
    const row = await owner.query<{ payment_id: string | null; hold_cents: number }>(
      "select payment_id, hold_cents from tabs where id = $1",
      [opened.id],
    );
    expect(row.rows[0]).toEqual({ payment_id: null, hold_cents: 0 });
    expect(await tabRow(opened.id)).toMatchObject({ state: "open", hold: null });
    const listed = (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs` }))
      .json<{ tabs: { id: string; cardless: boolean; no_hold: boolean; card: unknown }[] }>()
      .tabs.find((t) => t.id === opened.id);
    expect(listed).toMatchObject({ cardless: true, no_hold: true, card: null });

    const round = await send(opened.check_id, [{ variant_id: v("titos"), qty: 1 }]);
    expect(round.statusCode, round.body).toBe(201);
    // Close the night lists it first, with nothing to charge on it.
    const night = await withVenue(owner, { venueId, requestId: "p03-night" }, (c) =>
      barTabs(c, venueId, clock.now()),
    );
    expect(night.tabs[0]).toMatchObject({ id: opened.id, cardless: true, chargeable: false });
    expect(night.remaining.map((t) => t.id)).not.toContain(opened.id);
    // Close to the card isn't there: it has no hold.
    const toCard = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/${opened.id}/close`,
      headers: { "idempotency-key": `close-${++n}` },
      payload: { tip: "none", reader_id: readerId },
    });
    expect(toCard.statusCode).toBe(400);
    expect(toCard.body).toContain("no_hold");

    const rest = (await tabRow(opened.id)).rest_cents;
    expect(rest).toBeGreaterThan(0);
    const paid = await pay(opened.id, { method: "cash", amount_cents: rest, tendered_cents: 2000 });
    expect(paid.statusCode, paid.body).toBe(201);
    expect(paid.json()).toMatchObject({
      change_cents: 2000 - rest,
      check_status: "paid",
      tab_state: "closed",
    });
    expect(await tabRow(opened.id)).toMatchObject({ state: "closed" });
    expect(fake.requests.length).toBe(before);
  });

  it("still needs a name", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs`,
      headers: { "idempotency-key": `cardless-${++n}` },
      payload: { card: "none", name: "  " },
    });
    expect(r.statusCode).toBe(400);
    await cardRequired(true);
  });
});

describe("card holds on tabs as a switch, and the card behind the bar on a tab (U-23; D134)", () => {
  /** A new version of the tab settings with `fields` merged in. */
  const tabSettings = (fields: Record<string, unknown>) =>
    owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_at)
       select venue_id, key, version + 1, value || $2::jsonb, starts_on, saved_at
         from venue_settings where venue_id = $1 and key = 'tabs' order by version desc limit 1`,
      [venueId, JSON.stringify(fields)],
    );
  const behindBar = (state: "on" | "off") =>
    owner.query(
      `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'card_behind_bar', true, $2)
       on conflict (venue_id, module_id) do update set state = $2`,
      [venueId, state],
    );
  const openNamed = (name: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs`,
      headers: { "idempotency-key": `u23-${++n}` },
      payload: { card: "none", name, ...extra },
    });
  const listed = async (tabId: string) =>
    (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs` }))
      .json<{ tabs: { id: string; held_card: unknown }[] }>()
      .tabs.find((t) => t.id === tabId)!;
  const heldOnNight = async () => {
    const night = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/nights/2026-09-25`,
    });
    expect(night.statusCode, night.body).toBe(200);
    return night
      .json<{ checks: { id: string; count: number; names: string[] }[] }>()
      .checks.find((c) => c.id === "held_cards")!;
  };

  it("on (West 4's, absent): New tab offers the hold as before", async () => {
    expect((await consent()) as unknown).toMatchObject({ card_holds: true, card_required: true });
  });

  it("off: a tab with a hold is refused on the server, and every tab opens by name", async () => {
    await tabSettings({ cardHolds: false, cardRequired: true });
    expect((await consent()) as unknown).toMatchObject({ card_holds: false, card_required: false });
    const before = fake.requests.length;
    const r = await open({ name: "Held" });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.body).toContain("card_holds_off");
    const openings = await owner.query("select 1 from tab_openings where name = 'Held'");
    expect(openings.rows).toHaveLength(0);
    expect(fake.requests.length).toBe(before);
    const named = await openNamed("Rosa");
    expect(named.statusCode, named.body).toBe(201);
  });

  it("a tab kept on the card behind the bar shows it, asks for Returned, and Close the night lists it until then", async () => {
    await behindBar("on");
    expect((await consent()) as unknown).toMatchObject({ card_behind_bar: true });
    // Never the full number, and no digit in the name.
    for (const held_card of [
      { last4: "4242424242424242" },
      { name: "4242 4242", last4: "4242" },
      { name: "M. Torres", last4: "42" },
      { name: "M. Torres", number: "4242424242424242" },
    ])
      expect((await openNamed("Nope", { held_card })).statusCode).toBe(400);
    const r = await openNamed("Marisol", { held_card: { name: "M. Torres", last4: "4242" } });
    expect(r.statusCode, r.body).toBe(201);
    const tab = r.json<{ tab: { id: string; check_id: string } }>().tab;
    expect(await listed(tab.id)).toMatchObject({
      held_card: { name: "M. Torres", last4: "4242", returned: false },
    });
    // Both optional: a tab can keep a card with nothing typed.
    const bare = await openNamed("Seat 4", { held_card: {} });
    expect(bare.statusCode, bare.body).toBe(201);
    const bareTab = bare.json<{ tab: { id: string; check_id: string } }>().tab;
    expect(await listed(bareTab.id)).toMatchObject({
      held_card: { name: null, last4: null, returned: false },
    });

    const night = await heldOnNight();
    expect(night.names).toContain("Marisol · M. TORRES ···· 4242");
    expect(night.names).toContain("Seat 4");

    // Paid in cash, then Give the card back: Returned, and the night no longer lists it.
    await send(tab.check_id, [{ variant_id: v("titos"), qty: 1 }]);
    const rest = (await tabRow(tab.id)).rest_cents;
    const paid = await pay(tab.id, { method: "cash", amount_cents: rest, tendered_cents: rest });
    expect(paid.statusCode, paid.body).toBe(201);
    const back = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${tab.check_id}/held-card/returned`,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ held_card: { returned: true } });
    expect((await heldOnNight()).names).not.toContain("Marisol · M. TORRES ···· 4242");
    // Nothing was charged to it: the card's name and last 4 are all that's kept, never in the audit log.
    const audit = await owner.query<{ row: string }>(
      "select row_to_json(a)::text as row from audit_log a where target like 'check_held_cards%'",
    );
    for (const a of audit.rows) expect(a.row).not.toContain("Torres");
  });

  it("a tab moved into a room carries its card to the room's check, and Undo brings it back", async () => {
    const r = await openNamed("Iris", { held_card: { name: "I. Park", last4: "1881" } });
    expect(r.statusCode, r.body).toBe(201);
    const tab = r.json<{ tab: { id: string; check_id: string } }>().tab;
    await send(tab.check_id, [{ variant_id: v("titos"), qty: 1 }]);
    const moved = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/${tab.id}/move-to-room`,
      headers: { "idempotency-key": `u23-move-${++n}` },
      payload: { session_id: ids["sess_room5"] },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const roomCheck = moved.json<{ room_check_id: string }>().room_check_id;
    const where = async () =>
      (
        await owner.query<{ check_id: string }>(
          "select check_id from check_held_cards where tab_id = $1",
          [tab.id],
        )
      ).rows[0]!.check_id;
    expect(await where()).toBe(roomCheck);
    expect((await heldOnNight()).names.some((x) => x.includes("I. PARK ···· 1881"))).toBe(true);
    const undo = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/${tab.id}/undo-move`,
      headers: { "idempotency-key": `u23-undo-${++n}` },
    });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(await where()).toBe(tab.check_id);
  });

  it("with Keep the card behind the bar off, a tab can't keep one (refused on the server)", async () => {
    await owner.query(
      "update check_held_cards set returned_at = now(), returned_by = taken_by where returned_at is null",
    );
    await behindBar("off");
    const r = await openNamed("Off", { held_card: { name: "A. B", last4: "1234" } });
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json()).toMatchObject({ error: { code: "module_off" } });
    expect((await consent()) as unknown).toMatchObject({ card_behind_bar: false });
    await behindBar("on");
    await tabSettings({ cardHolds: true });
  });
});
