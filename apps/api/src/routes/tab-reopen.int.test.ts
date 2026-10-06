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
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { withVenue } from "@west4/db";
import { decide } from "../approvals/service.js";
import { askRefund } from "../payments/refunds.js";

/**
 * Reopen a settled tab and charge the saved card (M6-12; Payment flows · Bar tab with a growing hold,
 * step 9; API · Bar tabs `/reopen`, `/charge-saved-card`; screens Rail notes 3 and 18, N22). A tab of
 * Moët & Chandon · bottle and Large bucket · 10 beers ($250.00 plus $22.19 of tax) captured with No tip,
 * then reopened, has no hold: "Paid $272.19 · no hold", no Close to card, and nothing due. A new $9.00
 * Modelo ($9.80 with tax) goes on the card saved from the first tap, charged off-session, once the guest
 * taps Yes on the bar reader or once Andy approves; No on the reader charges nothing and the tab takes
 * drinks again. Andy's refund of a line from Closed tonight waits for Abhishek.
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
const clock = new FrozenClock(SEED_NOW);
let n = 0;
let maya: Principal;
let abhishek: Principal;
let who: Principal;

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
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  maya = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  abhishek = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  };
  who = abhishek;
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

interface TabRow {
  id: string;
  check_id: string;
  state: string;
  open: boolean;
  reopenable: boolean;
  no_hold: boolean;
  hold: unknown;
  paid_cents: number;
  rest_cents: number;
  waiting_for: string | null;
  saved_card: { brand: string; last4: string; payment_id: string | null } | null;
}
const tabRow = async (tabId: string) =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs` }))
    .json<{ tabs: TabRow[] }>()
    .tabs.find((t) => t.id === tabId)!;
const close = (tabId: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/tabs/${tabId}/close`,
    headers: { "idempotency-key": `close-${++n}` },
    payload: { reader_id: readerId, ...body },
  });
const reopen = (tabId: string) =>
  app.inject({ method: "POST", url: `/v1/venues/${venueId}/tabs/${tabId}/reopen` });
const charge = (tabId: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/tabs/${tabId}/charge-saved-card`,
    headers: { "idempotency-key": `saved-${++n}` },
    payload: body,
  });
const checkStatusOfPayment = async (paymentId: string) => {
  const r = await app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/payments/${paymentId}/check-status`,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{ state: string; reader_confirm: { state: string } | null }>();
};
async function helper(path: string, body: string) {
  const res = await fetch(
    `${fakeBase}/v1/test_helpers/terminal/readers/${await stripeReader()}/${path}`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "stripe-account": account,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `helper-${++n}`,
      },
      body,
    },
  );
  expect(res.status, await res.clone().text()).toBe(200);
}
/** The guest's Yes or No on the bar reader. */
const guestSays = (choice: "yes" | "no") =>
  helper("succeed_input_collection", `selection=${choice}`);
const tabState = async (tabId: string) =>
  (await owner.query<{ state: string }>("select state from tabs where id = $1", [tabId])).rows[0]!
    .state;
const checkStatusOf = async (checkId: string) =>
  (await owner.query<{ status: string }>("select status from checks where id = $1", [checkId]))
    .rows[0]!.status;

/** Moët & Chandon · bottle and Large bucket · 10 beers, captured with No tip, then reopened. */
async function settledAt27219(name: string, number: string, extra = "") {
  who = maya;
  const tab = await openTab(name, number, extra);
  const rung = await send(tab.check_id, [
    { variant_id: v("moet"), qty: 1 },
    { variant_id: v("bucket_l"), qty: 1 },
  ]);
  expect([201, 202], rung.body).toContain(rung.statusCode);
  await drain();
  const closed = await close(tab.id, { tip: "none" });
  expect(closed.statusCode, closed.body).toBe(200);
  await drain();
  expect(closed.json()).toMatchObject({ state: "captured", capture_cents: 27219, tip_cents: 0 });
  expect(await tabState(tab.id)).toBe("captured");
  return tab;
}
const modelo = () => [{ variant_id: v("modelo"), qty: 1 }];

describe("Reopen a settled tab and charge the saved card", () => {
  it("a tab captured at $272.19 and reopened shows Paid $272.19 · no hold, no Close to card, and no pay buttons", async () => {
    const tab = await settledAt27219("Kai R.", "4242424242424242");
    // Closed tonight lists it, with Reopen.
    expect(await tabRow(tab.id)).toMatchObject({ open: false, reopenable: true });
    const r = await reopen(tab.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().tab).toMatchObject({
      state: "open",
      open: true,
      no_hold: true,
      hold: null,
      paid_cents: 27219,
      rest_cents: 0,
      saved_card: { brand: "Visa", last4: "4242", payment_id: null },
    });
    // What was paid stays paid; the check takes drinks again.
    expect(await checkStatusOf(tab.check_id)).toBe("reopened");
    // No Close to card, and with $0 due nothing takes payment.
    const toCard = await close(tab.id, { tip: "reader" });
    expect(toCard.statusCode).toBe(400);
    expect(toCard.json().error.details).toMatchObject({ reason: "no_hold" });
    const nothing = await charge(tab.id, { amount_cents: 980, reader_id: readerId });
    expect(nothing.statusCode).toBe(400);
    expect(nothing.json().error.details).toMatchObject({ reason: "nothing_due" });
    // Reopened once is open: it isn't reopened again.
    expect((await reopen(tab.id)).json().error.details).toMatchObject({ reason: "tab_state" });
  });

  it("a new $9.00 Modelo goes on the saved card once the guest taps Yes on the bar reader", async () => {
    const tab = await settledAt27219("Rae S.", "4000003800000008");
    const holdPi = await intentOf(tab.paymentId);
    expect((await reopen(tab.id)).statusCode).toBe(200);
    expect((await send(tab.check_id, modelo())).statusCode).toBe(201);
    expect(await tabRow(tab.id)).toMatchObject({ rest_cents: 980, paid_cents: 27219 });
    const r = await charge(tab.id, { amount_cents: 980, reader_id: readerId });
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json<{ id: string; state: string; reader_confirm: { state: string } }>();
    expect(p).toMatchObject({ state: "waiting_guest", reader_confirm: { state: "asking" } });
    // Nothing is charged before the go-ahead; the reader asks Yes or No.
    const offSession = () =>
      fake.requests.filter((x) => x.idempotencyKey?.startsWith(`${p.id}:off_session`));
    expect(offSession()).toHaveLength(0);
    const reader = fake.objects.get(await stripeReader()) as {
      action: { collect_inputs: { inputs: { custom_text: { title: string } }[] } };
    };
    expect(reader.action.collect_inputs.inputs[0]!.custom_text.title).toBe(
      "Charge $9.80 to Visa ··0008?",
    );
    // Another payment can't take the same money meanwhile.
    expect((await charge(tab.id, { amount_cents: 980, reason: "again" })).statusCode).toBe(409);
    await guestSays("yes");
    expect(await checkStatusOfPayment(p.id)).toMatchObject({
      state: "paid",
      reader_confirm: { state: "yes" },
    });
    await drain();
    // Charged off-session on the card saved from the first tap, on the hold's Customer.
    const charged = await intentOf(p.id);
    expect(charged).toMatchObject({
      amount: 980,
      status: "succeeded",
      customer: holdPi["customer"],
      payment_method: expect.stringMatching(/^pm_/),
    });
    const generated = (
      await owner.query<{ pm: string }>(
        "select generated_card_pm as pm from payments where id = $1",
        [tab.paymentId],
      )
    ).rows[0]!.pm;
    expect(charged["payment_method"]).toBe(generated);
    const sent = offSession();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.idempotencyKey).toBe(`${p.id}:off_session:1`);
    // Paid: the tab is settled again, and its check paid.
    expect(await tabState(tab.id)).toBe("closed");
    expect(await checkStatusOf(tab.check_id)).toBe("paid");
  });

  it("No on the reader charges nothing, and the tab takes drinks again", async () => {
    const tab = await settledAt27219("Lee M.", "4111111111111111");
    expect((await reopen(tab.id)).statusCode).toBe(200);
    expect((await send(tab.check_id, modelo())).statusCode).toBe(201);
    const p = (await charge(tab.id, { amount_cents: 980, reader_id: readerId })).json<{
      id: string;
    }>();
    await guestSays("no");
    expect(await checkStatusOfPayment(p.id)).toMatchObject({
      state: "canceled",
      reader_confirm: { state: "no" },
    });
    expect(
      (await owner.query("select stripe_pi_id from payments where id = $1", [p.id])).rows[0],
    ).toEqual({ stripe_pi_id: null });
    expect(await tabState(tab.id)).toBe("open");
    expect(await checkStatusOf(tab.check_id)).toBe("reopened");
    expect((await send(tab.check_id, modelo())).statusCode).toBe(201);
    expect(await tabRow(tab.id)).toMatchObject({
      rest_cents: 1960,
      saved_card: { payment_id: null },
    });
  });

  it("with the guest gone, the charge waits for Andy and runs once he approves", async () => {
    const tab = await settledAt27219("Noor A.", "4012888888881881");
    expect((await reopen(tab.id)).statusCode).toBe(200);
    expect((await send(tab.check_id, modelo())).statusCode).toBe(201);
    const r = await charge(tab.id, {
      amount_cents: 980,
      reason: "Left without paying for the Modelo",
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: expect.stringMatching(/^Andy/) },
    });
    const paymentId = r.json().payment_id as string;
    expect((await tabRow(tab.id)).waiting_for).toMatch(/^Andy/);
    expect(
      (await owner.query("select stripe_pi_id from payments where id = $1", [paymentId])).rows[0],
    ).toEqual({ stripe_pi_id: null });
    await withVenue(workerPool, { venueId }, (c) =>
      decide(c, venueId, r.json().approval_id, {
        decision: "approve",
        userId: ids["andy"]!,
        deviceId: ids["dev_phone_andy"]!,
        at: clock.now(),
      }),
    );
    await drain();
    expect(await payment(paymentId)).toMatchObject({ status: "captured" });
    expect(
      (await owner.query("select mit_reason from payments where id = $1", [paymentId])).rows[0],
    ).toEqual({ mit_reason: "Left without paying for the Modelo" });
    expect(await tabState(tab.id)).toBe("closed");
  });

  it("a wallet tap saves no card, so Charge the saved card isn't offered", async () => {
    const tab = await settledAt27219("Sam W.", "4000056655665556", "&card_present[wallet]=true");
    expect((await reopen(tab.id)).statusCode).toBe(200);
    expect((await send(tab.check_id, modelo())).statusCode).toBe(201);
    expect(await tabRow(tab.id)).toMatchObject({ no_hold: true, saved_card: null });
    const r = await charge(tab.id, { amount_cents: 980, reader_id: readerId });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toMatchObject({ reason: "no_saved_card" });
  });

  it("Andy's refund of a line from Closed tonight waits for Abhishek", async () => {
    const tab = await settledAt27219("Tess O.", "5555555555554444");
    const bucket = (
      await owner.query<{ id: string }>(
        "select id from check_lines where check_id = $1 and description like 'Large bucket%'",
        [tab.check_id],
      )
    ).rows[0]!;
    // From Closed tonight, Andy picks the line and the payment (the refund sheet, M4-22): Abhishek decides.
    const r = await withVenue(workerPool, { venueId }, (c) =>
      askRefund(c, venueId, {
        checkId: tab.check_id,
        bookingId: null,
        lines: [{ lineId: Number(bucket.id), amountCents: 7000 }],
        parts: [{ paymentId: tab.paymentId, amountCents: 7621 }],
        reason: "Bucket came out warm",
        userId: ids["andy"]!,
        deviceId: ids["dev_phone_andy"]!,
        businessDate: "2026-09-25",
        now: clock.now(),
      }),
    );
    expect(r).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: expect.stringMatching(/^Abhishek/) },
    });
  });
});
