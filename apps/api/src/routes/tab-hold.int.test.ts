import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { reconcileVenue } from "../payments/reconcile.js";
import { StripeClient, StripeError, StripeUnknownResult } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { decide } from "../approvals/service.js";

/**
 * Growing a bar tab's hold (M6-07; Payment flows · Bar tab with a growing hold, steps 3 and 4): Luis M.'s
 * $50.00 hold grows to $80.00 as his rounds are sent; a declined raise on Jess P.'s tab keeps her $50.00
 * hold and sends her next round to Andy; a raise that times out is checked with Stripe and ends in one
 * known state; a card that can't grow is capped; a tab passing $600.00 shows on Andy's phone.
 */
let fault: "decline" | "drop" | "lost" | null = null;
let db: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let app: FastifyInstance;
let worker: Worker;
let fake: FakeStripe;
let stripeClient: StripeClient;
let account = "";
let fakeBase = "";
let venueId = "";
let ids: Record<string, string> = {};
let readerId = "";
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
interface Listed {
  id: string;
  check_id: string;
  name: string;
  hold_cents: number;
  waiting_for: string | null;
  totals: { total_cents: number };
  hold: {
    cents: number;
    left_cents: number;
    can_grow: boolean;
    declined: boolean;
    checking: boolean;
    increments_used: number;
  } | null;
}
const listed = async (tabId: string) =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs` }))
    .json<{ tabs: Listed[] }>()
    .tabs.find((t) => t.id === tabId)!;
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
const increments = async (id: string) =>
  (
    await owner.query<{
      idem_key: string;
      state: string;
      amount_cents: string;
      decline_code: string | null;
    }>(
      "select idem_key, state, amount_cents, decline_code from payment_attempts where payment_id = $1 and action = 'increment' order by attempt_no",
      [id],
    )
  ).rows;

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
  const stripe = new StripeClient(fakeStripeSettings(fakeBase), fetch, 15_000, {
    // The fault-injection client (M4-05): a declined raise, or a raise whose answer never came back.
    before: (method, path) => {
      if (path.endsWith("/increment_authorization") && fault === "decline") {
        fault = null;
        throw new StripeError(
          402,
          "card_error",
          "card_declined",
          "Your card was declined.",
          "generic_decline",
        );
      }
      if (path.endsWith("/increment_authorization") && fault === "lost") {
        fault = null;
        throw new StripeUnknownResult("injected: the raise never reached Stripe");
      }
    },
    dropAnswer: (method, path) => {
      if (path.endsWith("/increment_authorization") && fault === "drop") {
        fault = null;
        return true;
      }
      return false;
    },
  });
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  stripeClient = stripe;
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

describe("the hold grows as rounds are sent (step 3)", () => {
  it("Luis M.: $50.00 → $80.00 with one raise, keyed with its target", async () => {
    const tab = await openTab("Luis M.", "5555555555552281");
    const first = await send(tab.check_id, [{ variant_id: v("bucket_s"), qty: 1 }]);
    expect(first.statusCode, first.body).toBe(201);
    expect(await payment(tab.paymentId)).toEqual({
      authorized: 8000,
      used: 1,
      status: "authorized",
    });
    const inc = await increments(tab.paymentId);
    expect(inc).toEqual([expect.objectContaining({ state: "succeeded", amount_cents: "8000" })]);
    expect(inc[0]!.idem_key).toMatch(new RegExp(`^${tab.paymentId}:increment:\\d+:8000$`));
    const pi = await intentOf(tab.paymentId);
    expect(pi).toMatchObject({ amount: 8000, amount_capturable: 8000, status: "requires_capture" });

    const second = await send(tab.check_id, [{ variant_id: v("s_drop"), qty: 2 }]);
    expect(second.statusCode, second.body).toBe(201);
    const l = await listed(tab.id);
    expect(l.totals.total_cents).toBe(6315);
    expect(l.hold_cents).toBe(8000);
    // $63.15 plus $14.50 reserved: $2.35 left before the next raise.
    expect(l.hold).toMatchObject({ cents: 8000, left_cents: 235, can_grow: true, declined: false });
    expect((await payment(tab.paymentId)).used).toBe(1);
  });
});

describe("a declined raise (step 4)", () => {
  it("Jess P.: 'Hold raise declined', her $50.00 hold stands, and her round waits for Andy", async () => {
    const tab = await openTab("Jess P.", "4000000000004417");
    const round = [
      { variant_id: v("modelo"), qty: 2 },
      { variant_id: v("jager"), qty: 1 },
    ];
    expect((await send(tab.check_id, round)).statusCode).toBe(201);
    fault = "decline";
    const r = await send(tab.check_id, round, "jess-second");
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: "Andy C." },
    });
    expect(await payment(tab.paymentId)).toEqual({
      authorized: 5000,
      used: 1,
      status: "authorized",
    });
    expect((await increments(tab.paymentId))[0]).toMatchObject({
      state: "failed",
      decline_code: "card_declined",
    });
    const l = await listed(tab.id);
    expect(l.totals.total_cents).toBe(3266);
    expect(l.hold).toMatchObject({ cents: 5000, declined: true });
    expect(l.waiting_for).toBe("Andy C.");
    // The same send again answers the same request; no second raise is asked of Stripe.
    const again = await send(tab.check_id, round, "jess-second");
    expect(again.json().approval_id).toBe(r.json().approval_id);
    // Even a round that fits the old hold waits for a manager now.
    const small = await send(tab.check_id, [{ variant_id: v("modelo"), qty: 1 }]);
    expect(small.statusCode).toBe(202);
    expect((await payment(tab.paymentId)).used).toBe(1);

    // Andy OKs it on his own phone: the round goes on her tab.
    await withVenue(workerPool, { venueId }, (c) =>
      decide(c, venueId, r.json().approval_id, {
        decision: "approve",
        userId: ids["andy"]!,
        deviceId: ids["dev_phone_andy"]!,
        at: clock.now(),
      }),
    );
    expect((await listed(tab.id)).totals.total_cents).toBe(6533);
  });
});

describe("a raise that times out (Payment flows · unknown results)", () => {
  it("shows Checking with Stripe, then ends known: the raise went through, nothing sent twice", async () => {
    const tab = await openTab("Ben T.", "4242424242424242");
    fault = "drop";
    const bucket = [{ variant_id: v("bucket_s"), qty: 1 }];
    const r = await send(tab.check_id, bucket, "ben-round-1");
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().error).toMatchObject({
      code: "payment_unknown",
      message: "Checking with Stripe · don't retry",
    });
    expect((await listed(tab.id)).hold).toMatchObject({ checking: true, cents: 5000 });
    // Sending again while it's unclear asks nothing more of Stripe.
    expect((await send(tab.check_id, bucket, "ben-round-2")).statusCode).toBe(202);
    expect(await increments(tab.paymentId)).toHaveLength(1);
    clock.advance({ seconds: 3 });
    await drain();
    expect(await payment(tab.paymentId)).toEqual({
      authorized: 8000,
      used: 1,
      status: "authorized",
    });
    expect((await increments(tab.paymentId))[0]!.state).toBe("succeeded");
    expect((await intentOf(tab.paymentId))["_increments"]).toBe(1);
    // Now the round goes on, with no second raise.
    expect((await send(tab.check_id, bucket, "ben-round-3")).statusCode).toBe(201);
    expect(await increments(tab.paymentId)).toHaveLength(1);
  });

  it("a raise that never reached Stripe ends as not raised, and the hold is never canceled", async () => {
    const tab = await openTab("Sofia R.", "4000056655665556");
    fault = "lost";
    const r = await send(tab.check_id, [{ variant_id: v("bucket_s"), qty: 1 }], "sofia-round-1");
    expect(r.statusCode).toBe(202);
    clock.advance({ minutes: 3 });
    await drain();
    await reconcileVenue({ pool: workerPool, stripe: stripeClient, clock }, venueId);
    expect((await increments(tab.paymentId))[0]).toMatchObject({
      state: "canceled",
      decline_code: "not_raised",
    });
    expect(await payment(tab.paymentId)).toEqual({
      authorized: 5000,
      used: 1,
      status: "authorized",
    });
    expect((await intentOf(tab.paymentId))["status"]).toBe("requires_capture");
    // The next send asks for a new raise, with a new key.
    expect(
      (await send(tab.check_id, [{ variant_id: v("bucket_s"), qty: 1 }], "sofia-round-2"))
        .statusCode,
    ).toBe(201);
    expect(await payment(tab.paymentId)).toMatchObject({ authorized: 8000, used: 2 });
  });
});

describe("the fake's next-raise helper the end-to-end tests use (M6-28)", () => {
  const nextRaise = async (paymentId: string, outcome: string) =>
    fetch(
      `${fakeBase}/v1/test_helpers/fake/payment_intents/${String((await intentOf(paymentId))["id"])}/next_increment`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer rk_test_fake_payments",
          "stripe-account": account,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `outcome=${outcome}`,
      },
    );

  it("decline: Stripe answers card_declined once, the hold stands, and the round waits for Andy", async () => {
    const tab = await openTab("Seat 7", "4012888888881881");
    expect((await nextRaise(tab.paymentId, "sideways")).status).toBe(400);
    expect((await nextRaise(tab.paymentId, "decline")).ok).toBe(true);
    const r = await send(tab.check_id, [{ variant_id: v("bucket_s"), qty: 1 }]);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: "Andy C." },
    });
    expect((await increments(tab.paymentId))[0]).toMatchObject({
      state: "failed",
      decline_code: "card_declined",
    });
    expect(await payment(tab.paymentId)).toMatchObject({ authorized: 5000, status: "authorized" });
    expect((await intentOf(tab.paymentId))["amount"]).toBe(5000);
  });

  it("drop: Stripe raises it but the answer never arrives, so it reads Checking with Stripe until the worker reads it back", async () => {
    const tab = await openTab("Seat 8", "2223003122003222");
    expect((await nextRaise(tab.paymentId, "drop")).ok).toBe(true);
    const r = await send(tab.check_id, [{ variant_id: v("bucket_s"), qty: 1 }], "kira-round-1");
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().error).toMatchObject({ code: "payment_unknown" });
    expect((await intentOf(tab.paymentId))["amount"]).toBe(8000);
    clock.advance({ seconds: 3 });
    await drain();
    expect(await payment(tab.paymentId)).toMatchObject({ authorized: 8000, status: "authorized" });
    expect((await increments(tab.paymentId))[0]!.state).toBe("succeeded");
  });
});

describe("a card that can't grow (step 2)", () => {
  it("is capped at the hold plus the overcapture allowance, less the tip reserve", async () => {
    const tab = await openTab("Seat 6", "4111111111111111", "&card_present[incremental]=false");
    const pay = await owner.query("select incremental_supported from payments where id = $1", [
      tab.paymentId,
    ]);
    expect(pay.rows[0]).toEqual({ incremental_supported: false });
    // 6 × Modelo: $54.00 + $4.79 tax + $13.50 reserved = $72.29 of a $100.00 cap.
    expect((await send(tab.check_id, [{ variant_id: v("modelo"), qty: 6 }])).statusCode).toBe(201);
    const l = await listed(tab.id);
    expect(l.hold).toMatchObject({ cents: 5000, can_grow: false, left_cents: 2771 });
    const over = await send(tab.check_id, [{ variant_id: v("bucket_s"), qty: 1 }]);
    expect(over.statusCode).toBe(400);
    expect(over.json().error.details).toEqual({ reason: "hold_cap", left_cents: 2771 });
    expect(await increments(tab.paymentId)).toHaveLength(0);
  });
});

describe("the $600.00 flag (Settings · tabs.flagOverCents)", () => {
  it("a tab passing $600.00 shows once on Andy's phone", async () => {
    const tab = await openTab("Tariq A.", "378282246310005");
    const r = await send(tab.check_id, [{ variant_id: v("moet"), qty: 4 }]);
    expect(r.statusCode, r.body).toBe(201);
    await send(tab.check_id, [{ variant_id: v("modelo"), qty: 1 }]);
    const pushes = await owner.query<{
      payload: { audience: unknown; message: { key: string; params: unknown } };
    }>("select payload from jobs where kind = 'push.send' and dedupe_key = $1", [
      `tab-over:${tab.id}`,
    ]);
    expect(pushes.rows).toHaveLength(1);
    expect(pushes.rows[0]!.payload).toMatchObject({
      audience: { kind: "person", user_id: ids["andy"] },
      message: { key: "tabs.push.over", params: { name: "Tariq A.", limit: "$600.00" } },
    });
  });
});
