import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { reconcileVenue } from "../payments/reconcile.js";
import { makePaymentHandlers } from "../payments/run.js";
import { InjectedCrash, StripeClient } from "../stripe/client.js";
import { FakeStripe, signPayload } from "../stripe/fake/index.js";
import {
  FAKE_SANDBOX_KEYS,
  FAKE_TRAINING_WEBHOOK_SECRET,
  FAKE_WEBHOOK_SECRETS,
  fakeSandboxSettings,
  fakeStripeSettings,
} from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";
import "../payments/webhooks.js";

/**
 * Practice payments only reach Stripe's sandbox (M7-04; Security and data
 * retention 15; Stripe setup 4, 6 and 7). A trainee's tap runs on a simulated
 * reader of the sandbox account and shows the live states; a practice payment
 * naming the live Bar S710 is refused; every request a practice payment makes
 * carries a sandbox key (the fake's request log is CI's); the training
 * endpoint takes only test-mode events for practice payments, and the live
 * endpoints keep their own; the reconciler's training pass adopts a practice
 * payment whose success the API never recorded; and a practice bar tab holds
 * $50 on the sandbox, grows it, and closes with a tip picked on the reader.
 */
let db: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let app: FastifyInstance;
let liveApp: FastifyInstance;
let worker: Worker;
let hookWorker: Worker;
let fake: FakeStripe;
let fakeBase = "";
let liveAccount = "";
let sandboxAccount = "";
let venueId = "";
let ids: Record<string, string> = {};
let liveBar = "";
let practiceBar = "";
let practiceDesk = "";
let stripe: StripeClient;
const logged: string[] = [];
const clock = new FrozenClock(SEED_NOW);
let n = 0;
let crashAt: string | null = null;

const v = (item: string) => ids[`menu_${item}_regular`]!;
const drain = async () => {
  for (let i = 0; i < 5; i++) while ((await worker.tick()) > 0);
};
const training = (on: boolean) =>
  owner.query("update memberships set training = $2 where id = $1", [ids["maya.membership"], on]);
const sell = async (lines: { variant_id: string; qty: number }[]) => {
  const r = await app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/quick-sales`,
    payload: { client_order_id: `practice-sale-${++n}`, lines },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ check_id: string; amount_due_cents: number }>();
};
const tap = (checkId: string, amount: number, readerId: string) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${checkId}/payments`,
    headers: { "idempotency-key": `practice-tap-${++n}` },
    payload: { method: "tap", amount_cents: amount, reader_id: readerId },
  });
const testCard = (readerId: string, declined = false) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/readers/${readerId}/test-card`,
    headers: { "idempotency-key": `test-card-${++n}` },
    payload: { declined },
  });
const state = async (paymentId: string) => {
  await app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/payments/${paymentId}/check-status`,
  });
  const r = await app.inject({ method: "GET", url: `/v1/venues/${venueId}/payments/${paymentId}` });
  return r.json<{ state: string; status: string; training: boolean }>();
};
const stripeReaderOf = async (deviceId: string) =>
  (
    await owner.query<{ s: string }>("select stripe_reader_id as s from devices where id = $1", [
      deviceId,
    ])
  ).rows[0]!.s;
const freeReader = async (deviceId: string) => {
  (fake.objects.get(await stripeReaderOf(deviceId)) as { action: unknown }).action = null;
};
const piOf = async (paymentId: string) => {
  const r = await owner.query<{ pi: string }>(
    "select stripe_pi_id as pi from payments where id = $1",
    [paymentId],
  );
  return fake.objects.get(r.rows[0]!.pi) as Record<string, unknown>;
};
/** Every request the fake saw for this payment: its idempotency keys name it, or it's on its PaymentIntent. */
const requestsOf = async (paymentId: string) => {
  const pi = String((await piOf(paymentId))["id"]);
  return fake.requests.filter(
    (r) => (r.idempotencyKey ?? "").includes(paymentId) || r.path.includes(pi),
  );
};
const post = (target: FastifyInstance, endpoint: string, body: unknown, secret: string) => {
  const payload = JSON.stringify(body);
  return target.inject({
    method: "POST",
    url: `/v1/hooks/stripe/${endpoint}`,
    headers: {
      "content-type": "application/json",
      "stripe-signature": signPayload(payload, secret),
    },
    payload,
  });
};

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
  // The sandbox carries the chaos test's crash; the live client carries no faults at all.
  const sandbox = new StripeClient(fakeSandboxSettings(fakeBase), fetch, 15_000, {
    step: (name) => {
      if (crashAt === name) {
        crashAt = null;
        throw new InjectedCrash(name);
      }
    },
  });
  stripe = new StripeClient(fakeStripeSettings(fakeBase)).withSandbox(sandbox);
  const accountOf = (client: StripeClient, k: string) =>
    client
      .call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
        account: null,
        platform: true,
        idempotencyKey: k,
        params: { display_name: "West 4 Boho Karaoke" },
      })
      .then((a) => a.id);
  liveAccount = await accountOf(stripe, "acct-live");
  sandboxAccount = await accountOf(stripe.forTraining(true), "acct-sandbox");
  await owner.query(
    "update organizations set stripe_account_id = $1, stripe_training_account_id = $2",
    [liveAccount, sandboxAccount],
  );
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
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({
    config,
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => who],
    logger: { level: "warn", stream: { write: (line: string) => void logged.push(line) } },
  });
  await app.ready();
  // Production's live endpoints: livemode on, so a test-mode event there is refused.
  liveApp = buildApp({
    config,
    clock,
    stripe: new StripeClient({ ...fakeStripeSettings(fakeBase), livemode: true }).withSandbox(
      sandbox,
    ),
    moduleCacheMs: 0,
    authenticators: [async () => who],
    logger: { level: "warn", stream: { write: (line: string) => void logged.push(line) } },
  });
  await liveApp.ready();
  const register = async (label: string, practice: boolean) => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/readers`,
      payload: { registration_code: "simulated-s710", label, ...(practice ? { practice } : {}) },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string; practice: boolean }>();
  };
  liveBar = (await register("Bar S710", false)).id;
  const pBar = await register("Bar S710", true);
  expect(pBar.practice).toBe(true);
  practiceBar = pBar.id;
  practiceDesk = (await register("Front desk S710", true)).id;
  who = maya;
  worker = new Worker(workerPool, {
    pool: "critical",
    handlers: makePaymentHandlers({ pool: workerPool, stripe, clock }),
    clock,
  });
  hookWorker = new Worker(workerPool, {
    pool: "normal",
    handlers: { [STRIPE_EVENT_KIND]: makeStripeEventHandler(workerPool, stripe) },
    clock,
  });
});

afterAll(async () => {
  await training(false);
  await app.close();
  await liveApp.close();
  await fake.stop();
  await workerPool.end();
  await owner.end();
  await db.drop();
});

describe("training mode's readers (Stripe setup 4)", () => {
  it("the practice readers live on the sandbox account's own Location, and only a screen in training sees them", async () => {
    const devices = await owner.query<{ id: string; sandbox: boolean; s: string }>(
      "select id, sandbox, stripe_reader_id as s from devices where kind = 'reader' and stripe_reader_id is not null",
    );
    for (const d of devices.rows) {
      const reader = fake.objects.get(d.s)!;
      expect(reader["_account"]).toBe(d.sandbox ? sandboxAccount : liveAccount);
    }
    const sandboxLocation = await owner.query<{ l: string }>(
      "select stripe_training_location_id as l from venues where id = $1",
      [venueId],
    );
    expect(fake.objects.get(await stripeReaderOf(practiceBar))!["location"]).toBe(
      sandboxLocation.rows[0]!.l,
    );
    const list = async () =>
      (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/readers` }))
        .json<{ readers: { id: string; label: string; practice: boolean }[] }>()
        .readers.map((r) => r.id)
        .sort();
    const live = await list();
    expect(live).toContain(liveBar);
    expect(live).not.toContain(practiceBar);
    expect(live).not.toContain(practiceDesk);
    await training(true);
    expect(await list()).toEqual([practiceBar, practiceDesk].sort());
    await training(false);
  });
});

describe("a trainee's tap runs on a simulated reader and shows the live states", () => {
  it("Waiting for a tap, then [Tap a test card]: paid on the sandbox, every request with a sandbox key", async () => {
    await training(true);
    const sale = await sell([{ variant_id: v("bud"), qty: 2 }]);
    const r = await tap(sale.check_id, sale.amount_due_cents, practiceDesk);
    expect(r.statusCode, r.body).toBe(201);
    const paymentId = r.json<{ id: string }>().id;
    expect(r.json()).toMatchObject({ training: true, state: "waiting" });
    await drain();
    expect(await state(paymentId)).toMatchObject({ state: "waiting", training: true });
    const card = await testCard(practiceDesk);
    expect(card.statusCode, card.body).toBe(200);
    expect(await state(paymentId)).toMatchObject({ state: "paid", status: "captured" });
    const pi = await piOf(paymentId);
    expect(pi["_account"]).toBe(sandboxAccount);
    // CI's request log: no call with a live key, or to the live account, for any practice payment.
    const sent = await requestsOf(paymentId);
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.every((x) => x.sandbox && x.account === sandboxAccount && !x.livePrefix)).toBe(
      true,
    );
    expect(fake.requests.filter((x) => x.account === sandboxAccount).every((x) => x.sandbox)).toBe(
      true,
    );
    expect(fake.requests.some((x) => x.livePrefix)).toBe(false);
  });

  it("Declined · try another card or cash, when the trainee taps the declined test card", async () => {
    await freeReader(practiceDesk);
    const sale = await sell([{ variant_id: v("bud"), qty: 1 }]);
    const r = await tap(sale.check_id, sale.amount_due_cents, practiceDesk);
    expect(r.statusCode, r.body).toBe(201);
    await drain();
    expect((await testCard(practiceDesk, true)).statusCode).toBe(200);
    expect(await state(r.json<{ id: string }>().id)).toMatchObject({ state: "declined" });
  });

  it("Checking with Stripe · don't retry, when the sandbox's answer is lost", async () => {
    await freeReader(practiceDesk);
    const sale = await sell([{ variant_id: v("bud"), qty: 1 }]);
    fake.dropNext.push({ method: "POST", path: /process_payment_intent$/, afterHandling: true });
    const r = await tap(sale.check_id, sale.amount_due_cents, practiceDesk);
    // The tap's own run lost the answer: 202 payment_unknown, never a retry.
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().error.message).toBe("Checking with Stripe · don't retry");
    await drain();
    const row = await owner.query<{ state: string }>(
      "select state from payment_attempts where payment_id = $1 order by attempt_no desc limit 1",
      [r.json().error.details.payment.id],
    );
    expect(row.rows[0]!.state).toBe("unknown");
    const view = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/payments/${r.json().error.details.payment.id}`,
    });
    expect(view.json()).toMatchObject({ state: "unknown", training: true });
  });

  it("a practice payment naming the live Bar S710 is refused, and nothing reaches Stripe", async () => {
    await freeReader(practiceDesk);
    const sale = await sell([{ variant_id: v("bud"), qty: 1 }]);
    const before = fake.requests.length;
    const r = await tap(sale.check_id, sale.amount_due_cents, liveBar);
    expect(r.statusCode, r.body).toBe(404);
    // A trainee can't send a test card to a live reader either.
    expect((await testCard(liveBar)).statusCode).toBe(404);
    expect(fake.requests.length).toBe(before);
    // …and a live payment can't use a simulated reader of the sandbox.
    await training(false);
    const live = await sell([{ variant_id: v("bud"), qty: 1 }]);
    expect((await tap(live.check_id, live.amount_due_cents, practiceBar)).statusCode).toBe(404);
    expect((await testCard(practiceBar)).json().error.details.reason).toBe("training");
    expect(fake.requests.length).toBe(before);
    await training(true);
  });
});

describe("the training webhook endpoint (Stripe setup 6)", () => {
  it("a test-mode event at a live endpoint, or a live event at the training endpoint, is refused and logged", async () => {
    logged.length = 0;
    const body = {
      id: `evt_test_${++n}`,
      object: "event",
      type: "payment_intent.succeeded",
      account: liveAccount,
      livemode: false,
      created: 0,
      data: { object: { id: "pi_x" } },
    };
    const atLive = await post(liveApp, "connect", body, FAKE_WEBHOOK_SECRETS.connect);
    expect(atLive.statusCode).toBe(400);
    expect(atLive.json().error.message).toMatch(/test-mode event on a live endpoint/);
    const liveEvent = { ...body, id: `evt_live_${++n}`, account: sandboxAccount, livemode: true };
    const atTraining = await post(app, "training", liveEvent, FAKE_TRAINING_WEBHOOK_SECRET);
    expect(atTraining.statusCode).toBe(400);
    expect(atTraining.json().error.message).toMatch(/live event at the training endpoint/);
    // A live endpoint's secret never opens the training endpoint.
    const wrong = await post(
      app,
      "training",
      { ...body, id: `evt_w_${++n}` },
      FAKE_WEBHOOK_SECRETS.connect,
    );
    expect(wrong.statusCode).toBe(400);
    expect(logged.join("\n")).toMatch(/refused: a test-mode event on a live endpoint/);
    expect(logged.join("\n")).toMatch(/refused: a live event at the training endpoint/);
    const stored = await owner.query("select 1 from webhook_events where event_id = any($1)", [
      [body.id, liveEvent.id],
    ]);
    expect(stored.rowCount).toBe(0);
  });

  it("the sandbox's events land only at the training endpoint, and only on practice payments", async () => {
    await freeReader(practiceDesk);
    const sale = await sell([{ variant_id: v("bud"), qty: 1 }]);
    const r = await tap(sale.check_id, sale.amount_due_cents, practiceDesk);
    const paymentId = r.json<{ id: string }>().id;
    await drain();
    const from = fake.events.length;
    expect((await testCard(practiceDesk)).statusCode).toBe(200);
    const made = fake.events.slice(from);
    // The fake sends the sandbox's events to the training endpoint, as Stripe's sandbox would.
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((e) => e.endpoint === "training" && e.event.account === sandboxAccount)).toBe(
      true,
    );
    const succeeded = made.find((e) => e.event.type === "payment_intent.succeeded")!;
    // At a live endpoint the sandbox account names no venue: stored, never applied.
    const atConnect = await post(app, "connect", succeeded.event, FAKE_WEBHOOK_SECRETS.connect);
    expect(atConnect.statusCode).toBe(200);
    const row = await owner.query<{ venue_id: string | null }>(
      "select venue_id from webhook_events where event_id = $1",
      [succeeded.event.id],
    );
    expect(row.rows[0]!.venue_id).toBeNull();
    let status = await owner.query<{ status: string }>(
      "select status from payments where id = $1",
      [paymentId],
    );
    expect(status.rows[0]!.status).toBe("pending");
    // A live account's id at the training endpoint names no venue either.
    const liveAtTraining = {
      ...succeeded.event,
      id: `${succeeded.event.id}_l`,
      account: liveAccount,
    };
    expect(
      (await post(app, "training", liveAtTraining, FAKE_TRAINING_WEBHOOK_SECRET)).statusCode,
    ).toBe(200);
    const none = await owner.query<{ venue_id: string | null }>(
      "select venue_id from webhook_events where event_id = $1",
      [liveAtTraining.id],
    );
    expect(none.rows[0]!.venue_id).toBeNull();
    // At the training endpoint it is applied (a copy with its own id; the first was stored once).
    const copy = { ...succeeded.event, id: `${succeeded.event.id}_t` };
    const atTraining = await post(app, "training", copy, FAKE_TRAINING_WEBHOOK_SECRET);
    expect(atTraining.statusCode).toBe(200);
    while ((await hookWorker.tick()) > 0);
    status = await owner.query<{ status: string }>("select status from payments where id = $1", [
      paymentId,
    ]);
    expect(status.rows[0]!.status).toBe("captured");
  });

  it("a training event about a live payment changes nothing", async () => {
    await training(false);
    const sale = await sell([{ variant_id: v("bud"), qty: 1 }]);
    const r = await tap(sale.check_id, sale.amount_due_cents, liveBar);
    expect(r.statusCode, r.body).toBe(201);
    const paymentId = r.json<{ id: string }>().id;
    await drain();
    const pi = String((await piOf(paymentId))["id"]);
    // A forged sandbox event naming the live payment's PaymentIntent, on the sandbox account.
    const forged = {
      id: `evt_forged_${++n}`,
      object: "event",
      type: "payment_intent.canceled",
      account: sandboxAccount,
      livemode: false,
      created: 0,
      data: { object: { id: pi } },
    };
    expect((await post(app, "training", forged, FAKE_TRAINING_WEBHOOK_SECRET)).statusCode).toBe(
      200,
    );
    const before = fake.requests.length;
    while ((await hookWorker.tick()) > 0);
    // Not applied: the live payment wasn't read again, and still waits on the live reader.
    expect(fake.requests.length).toBe(before);
    const status = await owner.query<{ status: string }>(
      "select status from payments where id = $1",
      [paymentId],
    );
    expect(status.rows[0]!.status).toBe("pending");
    const cancel = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${paymentId}/cancel`,
      headers: { "idempotency-key": `cancel-${++n}` },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    await training(true);
  });
});

describe("chaos: the API killed between the sandbox's success and our commit", () => {
  it("the reconciler's training pass reads the sandbox and records Paid once", async () => {
    await freeReader(practiceDesk);
    const sale = await sell([{ variant_id: v("bud"), qty: 1 }]);
    crashAt = "after-process";
    const r = await tap(sale.check_id, sale.amount_due_cents, practiceDesk);
    // The API dies in the tap's own run, after the sandbox took the PaymentIntent onto the reader.
    expect(r.statusCode).toBe(500);
    const paymentId = (
      await owner.query<{ id: string }>(
        "select payment_id as id from payment_allocations where check_id = $1",
        [sale.check_id],
      )
    ).rows[0]!.id;
    await drain().catch(() => undefined);
    // The card is tapped and Stripe's sandbox takes it; our side never heard.
    expect((await testCard(practiceDesk)).statusCode).toBe(200);
    expect((await piOf(paymentId))["status"]).toBe("succeeded");
    clock.advance({ minutes: 3 });
    const done = await reconcileVenue({ pool: workerPool, stripe, clock }, venueId);
    expect(done.resolved).toContain(paymentId);
    expect(done.unmatched).toEqual([]);
    const row = await owner.query<{ status: string; training: boolean }>(
      "select status, training from payments where id = $1",
      [paymentId],
    );
    expect(row.rows[0]).toEqual({ status: "captured", training: true });
    const sent = await requestsOf(paymentId);
    expect(sent.every((x) => x.sandbox && x.account === sandboxAccount)).toBe(true);
    // The live pass never looked at the sandbox account.
    expect(fake.requests.filter((x) => x.account === sandboxAccount && !x.sandbox)).toEqual([]);
  });
});

describe("a practice bar tab (Payment flows · How every card payment runs)", () => {
  it("opens a $50.00 hold on the sandbox, grows it as rounds are sent, and closes with a tip picked on the simulated reader", async () => {
    await freeReader(practiceBar);
    const consent = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs/consent` })
    ).json<{ version_id: string }>();
    const opened = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs`,
      headers: { "idempotency-key": `practice-tab-${++n}` },
      payload: {
        reader_id: practiceBar,
        consent_text_version: consent.version_id,
        name: "Trainee",
      },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const o = opened.json<{ id: string; payment: { id: string; training: boolean } }>();
    expect(o.payment.training).toBe(true);
    await drain();
    expect((await testCard(practiceBar)).statusCode).toBe(200);
    await drain();
    const status = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/openings/${o.id}/check-status`,
    });
    const tab = status.json<{ state: string; tab: { id: string; check_id: string } }>();
    expect(tab.state).toBe("opened");
    let pi = await piOf(o.payment.id);
    expect(pi).toMatchObject({
      _account: sandboxAccount,
      amount: 5000,
      status: "requires_capture",
    });
    const check = await owner.query<{ training: boolean; number: string }>(
      "select training, number::text from checks where id = $1",
      [tab.tab.check_id],
    );
    expect(check.rows[0]!.training).toBe(true);

    // A bucket of beer is more than the $50.00 hold: the hold grows on the sandbox.
    const round = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${tab.tab.check_id}/orders`,
      payload: {
        client_order_id: `practice-round-${++n}`,
        lines: [{ variant_id: v("bucket_s"), qty: 1 }],
      },
    });
    expect(round.statusCode, round.body).toBe(201);
    pi = await piOf(o.payment.id);
    expect(Number(pi["amount"])).toBeGreaterThan(5000);

    const close = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/${tab.tab.id}/close`,
      headers: { "idempotency-key": `practice-close-${++n}` },
      payload: { reader_id: practiceBar, tip: "reader" },
    });
    expect(close.statusCode, close.body).toBe(200);
    expect(close.json()).toMatchObject({ state: "asking" });
    // The guest picks 20% on the simulated reader (Stripe's test helper, with the sandbox's key).
    const picked = await fetch(
      `${fakeBase}/v1/test_helpers/terminal/readers/${await stripeReaderOf(practiceBar)}/succeed_input_collection`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${FAKE_SANDBOX_KEYS.payments}`,
          "stripe-account": sandboxAccount,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": `pick-${++n}`,
        },
        body: "selection=tip_1",
      },
    );
    expect(picked.status).toBe(200);
    const done = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/${tab.tab.id}/close/check-status`,
    });
    expect(done.json()).toMatchObject({ state: "captured", payment: { status: "captured" } });
    expect(done.json().tip_cents).toBeGreaterThan(0);
    pi = await piOf(o.payment.id);
    expect(pi).toMatchObject({ _account: sandboxAccount, status: "succeeded" });
    expect(Number(pi["amount_received"])).toBe(done.json().capture_cents);
    const sent = await requestsOf(o.payment.id);
    expect(sent.every((x) => x.sandbox && x.account === sandboxAccount && !x.livePrefix)).toBe(
      true,
    );
  });
});
