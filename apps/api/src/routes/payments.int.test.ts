import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { StripeClient, type StripeFaults } from "../stripe/client.js";
import { FakeStripe, signPayload } from "../stripe/fake/index.js";
import { FAKE_WEBHOOK_SECRETS, fakeStripeSettings } from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";

let db: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let ids: Record<string, string>;
let account: string;
let worker: Worker;
let normal: Worker;
const clock = new FrozenClock(SEED_NOW);
/** Faults the next calls meet; tests set and clear them. */
const faults: { drop: RegExp | null; delay: { path: RegExp; ms: number } | null } = {
  drop: null,
  delay: null,
};
/** Open transactions seen while a Stripe call was in flight. */
const openDuringCalls: number[] = [];

const injected: StripeFaults = {
  before: async (_m, path) => {
    if (faults.delay && faults.delay.path.test(path))
      await new Promise((r) => setTimeout(r, faults.delay!.ms));
  },
  dropAnswer: (_m, path) => {
    if (faults.drop && faults.drop.test(path)) {
      faults.drop = null;
      return true;
    }
    return false;
  },
};

let n = 0;
const key = () => `test-key-${++n}`;
const tap = (checkSlug: string, amount: number, reader = "dev_bar_reader", k = key()) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${ids[checkSlug]}/payments`,
    headers: { "idempotency-key": k },
    payload: { method: "tap", amount_cents: amount, reader_id: ids[reader] },
  });
const readerOf = (slug: string) =>
  owner
    .query<{ s: string }>("select stripe_reader_id as s from devices where id = $1", [ids[slug]])
    .then((r) => r.rows[0]!.s);
const present = async (readerSlug: string, number = "4242424242424242") => {
  const r = await fetch(
    `${fake.base}/v1/test_helpers/terminal/readers/${await readerOf(readerSlug)}/present_payment_method`,
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
  expect(r.status).toBe(200);
};
const checkStatus = (paymentId: string) =>
  app.inject({ method: "POST", url: `/v1/venues/${venueId}/payments/${paymentId}/check-status` });
const due = async (slug: string) =>
  (
    await owner.query<{ due: string }>(
      "select set_config('app.venue_id', $1, false), amount_due($2) as due",
      [venueId, ids[slug]],
    )
  ).rows[0]!.due;
/** Run every due job, moving the clock on 2 seconds between rounds. */
async function tickFor(seconds: number) {
  for (let s = 0; s <= seconds; s += 2) {
    while ((await worker.tick()) > 0);
    clock.advance({ seconds: 2 });
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  workerPool = appPool(db.url);
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  fake = new FakeStripe();
  const base = await fake.start();
  const watched: typeof fetch = async (input, init) => {
    const open = await owner.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'",
    );
    openDuringCalls.push(open.rows[0]!.n);
    return fetch(input, init);
  };
  stripe = new StripeClient(fakeStripeSettings(base), watched, 2_000, injected);
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  const abhishek: Principal = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => abhishek],
  });
  await app.ready();
  for (const label of ["Bar S710", "Front desk S710"]) {
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/readers`,
      payload: { registration_code: "simulated-s710", label },
    });
    expect(r.statusCode, r.body).toBe(201);
  }
  const deps = { pool: workerPool, stripe, clock };
  worker = new Worker(workerPool, {
    pool: "critical",
    handlers: {
      ...makePaymentHandlers(deps),
      [STRIPE_EVENT_KIND]: makeStripeEventHandler(workerPool, stripe),
    },
    clock,
  });
  normal = new Worker(workerPool, {
    pool: "normal",
    handlers: { [STRIPE_EVENT_KIND]: makeStripeEventHandler(workerPool, stripe) },
    clock,
  });
});

beforeEach(() => {
  faults.drop = null;
  faults.delay = null;
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await workerPool.end();
  await owner.end();
  await db.drop();
});

describe("a tap on a reader", () => {
  it("writes first, calls Stripe outside any transaction, and records Paid", async () => {
    const r = await tap("chk_room9", 5000);
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json();
    expect(p).toMatchObject({
      status: "pending",
      state: "waiting",
      attempt: { no: 1, state: "started" },
    });
    const calls = fake.requests.filter((x) => x.idempotencyKey?.startsWith(p.id));
    expect(
      calls.map((x) => [x.path.replace(/\/[a-z]+_fake_[0-9a-f]+/g, "/:id"), x.idempotencyKey]),
    ).toEqual([
      ["/v1/payment_intents", `${p.id}:create`],
      ["/v1/terminal/readers/:id/process_payment_intent", `${p.id}:process:1`],
    ]);
    // A room check carries the gratuity: the reader skips its tip screen.
    const reader = fake.objects.get(await readerOf("dev_bar_reader"))!;
    expect(reader["action"]).toMatchObject({
      process_payment_intent: { process_config: { skip_tipping: "true" } },
    });
    await present("dev_bar_reader");
    const paid = await checkStatus(p.id);
    expect(paid.json()).toMatchObject({
      status: "captured",
      state: "paid",
      amount_cents: 5000,
      card_last4: "4242",
    });
    expect(await due("chk_room9")).toBe("10800");
    const events = await owner.query(
      "select from_status, to_status, source from payment_events where payment_id = $1 order by id",
      [p.id],
    );
    expect(events.rows).toEqual([
      { from_status: null, to_status: "pending", source: "api" },
      { from_status: "pending", to_status: "captured", source: "api" },
    ]);
    expect(openDuringCalls.length).toBeGreaterThan(0);
  });

  it("a declined card leaves one PaymentIntent; the next tap is attempt 2 with key <payment_id>:process:2", async () => {
    const p = (await tap("chk_room9", 1000)).json();
    await present("dev_bar_reader", "4000000000000002");
    const declined = (await checkStatus(p.id)).json();
    expect(declined).toMatchObject({
      state: "declined",
      attempt: { no: 1, state: "failed", decline_code: "generic_decline" },
    });
    const again = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${p.id}/tap`,
      headers: { "idempotency-key": key() },
      payload: { reader_id: ids["dev_bar_reader"] },
    });
    expect(again.json()).toMatchObject({ state: "waiting", attempt: { no: 2, state: "started" } });
    expect(fake.requests.at(-1)?.idempotencyKey).toBe(`${p.id}:process:2`);
    expect(
      fake.list(
        "payment_intent",
        account,
        (x) => (x["metadata"] as { payment_id?: string }).payment_id === p.id,
      ),
    ).toHaveLength(1);
    await present("dev_bar_reader");
    expect((await checkStatus(p.id)).json()).toMatchObject({ state: "paid" });
  });

  it("an answer dropped after Stripe did it is unknown; no second payment can start; polling records Paid", async () => {
    faults.drop = /process_payment_intent/;
    const r = await tap("chk_room9", 2000);
    expect(r.statusCode).toBe(202);
    expect(r.json().error).toMatchObject({
      code: "payment_unknown",
      message: "Checking with Stripe · don't retry",
    });
    const p = r.json().error.details.payment;
    expect(p.attempt.state).toBe("unknown");
    const second = await tap("chk_room9", 1000, "dev_front_reader");
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("in_progress");
    // Stripe did put it on the reader; the guest taps.
    await present("dev_bar_reader");
    await tickFor(10);
    const after = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/payments/${p.id}`,
    });
    expect(after.json()).toMatchObject({ state: "paid", attempt: { state: "succeeded" } });
  });

  it("an unknown attempt nobody answers is canceled after 2 minutes, and its allocation released", async () => {
    const before = await due("chk_room9");
    faults.drop = /process_payment_intent/;
    const p = (await tap("chk_room9", 1500)).json().error.details.payment;
    await tickFor(110);
    expect(
      (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/payments/${p.id}` })).json()
        .state,
    ).toBe("unknown");
    await tickFor(20);
    const after = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/payments/${p.id}` })
    ).json();
    expect(after).toMatchObject({
      status: "canceled",
      state: "canceled",
      attempt: { state: "canceled" },
    });
    expect(await due("chk_room9")).toBe(before);
  });

  it("a cancel that finds the payment went through records the success", async () => {
    const p = (await tap("chk_room9", 500)).json();
    await present("dev_bar_reader");
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${p.id}/cancel`,
      headers: { "idempotency-key": key() },
    });
    expect(r.json()).toMatchObject({ status: "captured", state: "paid" });
  });

  it("answers 503 reader_offline for an offline reader, and the other reader takes the next tap", async () => {
    await fetch(`${fake.base}/fake/readers/${await readerOf("dev_bar_reader")}/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "status=offline",
    });
    const r = await tap("chk_room9", 700);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("reader_offline");
    const p = r.json().error.details.payment;
    const front = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${p.id}/tap`,
      headers: { "idempotency-key": key() },
      payload: { reader_id: ids["dev_front_reader"] },
    });
    expect(front.json()).toMatchObject({ state: "waiting", attempt: { no: 2 } });
    await present("dev_front_reader");
    expect((await checkStatus(p.id)).json().state).toBe("paid");
    await fetch(`${fake.base}/fake/readers/${await readerOf("dev_bar_reader")}/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "status=online",
    });
  });

  it("replays the same key and body, refuses the key with another body (422), and answers 409 while the first runs", async () => {
    const k = key();
    const first = await tap("chk_room9", 300, "dev_bar_reader", k);
    const again = await tap("chk_room9", 300, "dev_bar_reader", k);
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.json().id).toBe(first.json().id);
    const other = await tap("chk_room9", 301, "dev_bar_reader", k);
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe("key_reused");
    await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${first.json().id}/cancel`,
      headers: { "idempotency-key": key() },
    });

    faults.delay = { path: /process_payment_intent/, ms: 600 };
    const k2 = key();
    const [a, b] = await Promise.all([
      tap("chk_room9", 400, "dev_bar_reader", k2),
      new Promise((r) => setTimeout(r, 150)).then(() =>
        tap("chk_room9", 400, "dev_bar_reader", k2),
      ),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((b.statusCode === 409 ? b : a).json().error.code).toBe("in_progress");
    const done = a.statusCode === 201 ? a : b;
    await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${done.json().id}/cancel`,
      headers: { "idempotency-key": key() },
    });
  });

  it("never has a database transaction open while a Stripe call is in flight", () => {
    expect(openDuringCalls.length).toBeGreaterThan(10);
    expect(openDuringCalls.every((x) => x === 0)).toBe(true);
  });
});

describe("payment webhooks", () => {
  const deliverAll = async (from: number) => {
    for (const e of fake.events.slice(from)) {
      const payload = JSON.stringify(e.event);
      await app.inject({
        method: "POST",
        url: `/v1/hooks/stripe/${e.endpoint}`,
        headers: {
          "content-type": "application/json",
          "stripe-signature": signPayload(payload, FAKE_WEBHOOK_SECRETS[e.endpoint]),
        },
        payload,
      });
    }
    while ((await worker.tick()) + (await normal.tick()) > 0);
  };

  it("record Paid from the events, by the PaymentIntent's id even when its metadata names another payment", async () => {
    const other = (await tap("chk_room9", 100)).json();
    await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${other.id}/cancel`,
      headers: { "idempotency-key": key() },
    });
    const p = (await tap("chk_room9", 600)).json();
    const pi = fake.list(
      "payment_intent",
      account,
      (x) => (x["metadata"] as { payment_id?: string }).payment_id === p.id,
    )[0]!;
    pi["metadata"] = { payment_id: other.id }; // edited in the owner's Dashboard
    const from = fake.events.length;
    await present("dev_bar_reader");
    await deliverAll(from);
    const after = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/payments/${p.id}` })
    ).json();
    expect(after).toMatchObject({ status: "captured", state: "paid" });
    expect(
      (
        await app.inject({ method: "GET", url: `/v1/venues/${venueId}/payments/${other.id}` })
      ).json().status,
    ).toBe("canceled");
    const sources = await owner.query(
      "select source from payment_events where payment_id = $1 and to_status = 'captured'",
      [p.id],
    );
    expect(sources.rows).toEqual([{ source: "webhook" }]);
  });

  it("a repeated or late event changes nothing: succeeded twice, then canceled after succeeded", async () => {
    const p = (await tap("chk_room9", 800)).json();
    const from = fake.events.length;
    await present("dev_bar_reader");
    await deliverAll(from);
    const succeeded = fake.events
      .slice(from)
      .find((e) => e.event.type === "payment_intent.succeeded")!;
    const late = {
      endpoint: "connect" as const,
      event: { ...succeeded.event, id: "evt_late_cancel", type: "payment_intent.canceled" },
      delivered: false,
    };
    fake.events.push({ ...succeeded, event: { ...succeeded.event, id: "evt_dup_like" } }, late);
    await deliverAll(fake.events.length - 2);
    const events = await owner.query(
      "select to_status from payment_events where payment_id = $1 order by id",
      [p.id],
    );
    expect(events.rows.map((r) => r.to_status)).toEqual(["pending", "captured"]);
  });
});
