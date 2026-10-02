import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { InjectedCrash, StripeClient, type StripeFaults } from "../stripe/client.js";
import { FakeStripe, fakeId } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { reconcileVenue } from "./reconcile.js";

/**
 * The payment chaos suite (M4-12; Testing and operations · Payment chaos
 * tests): one fault per action, with no webhooks at all, and every payment
 * must end paid, failed or canceled after the reconciler's next run.
 * Assertions read the fake Stripe's own PaymentIntents and charges, not only
 * our rows. Off-session charges (M4-17), captures (M6) and refunds (M4-21)
 * join it with their tickets.
 */
let db: TestDatabase;
let owner: pg.Pool;
let workers: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let ids: Record<string, string>;
let account: string;
const clock = new FrozenClock(SEED_NOW);
const faults: { crashAt: string | null; drop: RegExp | null } = { crashAt: null, drop: null };
const injected: StripeFaults = {
  step: (name) => {
    if (faults.crashAt === name) {
      faults.crashAt = null;
      throw new InjectedCrash(name);
    }
  },
  dropAnswer: (_m, path) => {
    if (faults.drop?.test(path)) {
      faults.drop = null;
      return true;
    }
    return false;
  },
};
let n = 0;
const tap = (checkSlug: string, amount: number, reader = "dev_front_reader") =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${ids[checkSlug]}/payments`,
    headers: { "idempotency-key": `chaos-${++n}` },
    payload: { method: "tap", amount_cents: amount, reader_id: ids[reader] },
  });
const readerOf = async (slug: string) =>
  (
    await owner.query<{ s: string }>("select stripe_reader_id as s from devices where id = $1", [
      ids[slug],
    ])
  ).rows[0]!.s;
const presentCard = async (slug: string) => {
  const r = await fetch(
    `${fake.base}/v1/test_helpers/terminal/readers/${await readerOf(slug)}/present_payment_method`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "stripe-account": account,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `chaos-present-${++n}`,
      },
      body: "",
    },
  );
  expect(r.status).toBe(200);
};
const lastPayment = async () =>
  (
    await owner.query<{ id: string; status: string; pi: string | null }>(
      "select id, status, stripe_pi_id as pi from payments where method = 'card_present' order by created_at desc limit 1",
    )
  ).rows[0]!;
const intentsFor = (paymentId: string) =>
  fake.list(
    "payment_intent",
    account,
    (x) => (x["metadata"] as { payment_id?: string }).payment_id === paymentId,
  );
const chargesFor = (piId: string) =>
  [...fake.objects.values()].filter(
    (o) => o["object"] === "charge" && o["payment_intent"] === piId,
  );
const reconcileLater = async () => {
  clock.advance({ minutes: 3 });
  return reconcileVenue({ pool: workers, stripe, clock }, venueId);
};
const due = async (slug: string) =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/checks/${ids[slug]}` })).json()
    .amount_due_cents;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  workers = appPool(db.url);
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
  stripe = new StripeClient(fakeStripeSettings(await fake.start()), fetch, 2_000, injected);
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "chaos-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => andy],
  });
  await app.ready();
  for (const label of ["Bar S710", "Front desk S710"])
    await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/readers`,
      payload: { registration_code: "simulated-s710", label },
    });
});

beforeEach(async () => {
  faults.crashAt = null;
  faults.drop = null;
  await owner.query(
    "update device_heartbeats set last_seen_at = $1, offline_since = null where device_id in (select id from devices where kind = 'reader')",
    [new Date(clock.now().epochMilliseconds)],
  );
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await workers.end();
  await owner.end();
  await db.drop();
});

describe("payment chaos", () => {
  it("API killed between Stripe's success and our record of Room 9's $498.60: the reconciler records Paid, $0.00 due, one charge", async () => {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/venues/${venueId}/checks/${ids["chk_room9"]}/present`,
        })
      ).statusCode,
    ).toBe(200);
    expect(await due("chk_room9")).toBe(49860);
    faults.crashAt = "after-process";
    const r = await tap("chk_room9", 49860);
    expect(r.statusCode).toBe(500);
    await presentCard("dev_front_reader");
    const p = await lastPayment();
    expect(p.status).toBe("pending");
    const done = await reconcileLater();
    expect(done.resolved).toContain(p.id);
    expect((await lastPayment()).status).toBe("captured");
    expect(await due("chk_room9")).toBe(0);
    expect(chargesFor(p.pi!)).toHaveLength(1);
    expect(intentsFor(p.id)).toHaveLength(1);
  });

  it("killed after the PaymentIntent was made but before its id was stored: found again by its key and canceled; no second one", async () => {
    faults.crashAt = "after-create-intent";
    expect((await tap("chk_t1", 3000)).statusCode).toBe(500);
    const p = await lastPayment();
    expect(p.pi).toBeNull();
    expect(intentsFor(p.id)).toHaveLength(1);
    const done = await reconcileLater();
    expect(done.recovered).toContain(p.id);
    const after = await lastPayment();
    expect(after).toMatchObject({ status: "canceled", pi: intentsFor(p.id)[0]!["id"] });
    expect(intentsFor(p.id)).toHaveLength(1);
    expect(intentsFor(p.id)[0]!["status"]).toBe("canceled");
    expect(await due("chk_t1")).toBe(3000);
  });

  it("…or adopted when it went through", async () => {
    faults.crashAt = "after-create-intent";
    expect((await tap("chk_t2", 5800)).statusCode).toBe(500);
    const p = await lastPayment();
    const pi = intentsFor(p.id)[0]!;
    // It went through at Stripe (as if the reader had taken it before the crash).
    const charge = fake.put({
      id: fakeId("ch"),
      object: "charge",
      _account: account,
      amount: 5800,
      payment_intent: pi["id"],
      payment_method_details: { card_present: { brand: "visa", last4: "4242" } },
    });
    Object.assign(pi, { status: "succeeded", amount_received: 5800, latest_charge: charge["id"] });
    await reconcileLater();
    expect(await lastPayment()).toMatchObject({ status: "captured", pi: pi["id"] });
    expect(await due("chk_t2")).toBe(0);
    expect(intentsFor(p.id)).toHaveLength(1);
  });

  it("a payment made straight in Stripe's Dashboard lands as unmatched and never on a check", async () => {
    const charge = fake.put({
      id: fakeId("ch"),
      object: "charge",
      _account: account,
      amount: 2500,
      payment_method_details: {
        card_present: { brand: "mastercard", last4: "4444", funding: "debit" },
      },
    });
    const pi = fake.put({
      id: fakeId("pi"),
      object: "payment_intent",
      _account: account,
      amount: 2500,
      amount_received: 2500,
      status: "succeeded",
      latest_charge: charge["id"],
      metadata: {},
    });
    const done = await reconcileLater();
    expect(done.unmatched).toHaveLength(1);
    const row = (
      await owner.query(
        "select method, status, amount_cents::int as amount, card_last4, (select count(*)::int from payment_allocations a where a.payment_id = p.id) as allocations from payments p where stripe_pi_id = $1",
        [pi["id"]],
      )
    ).rows[0];
    expect(row).toEqual({
      method: "external",
      status: "captured",
      amount: 2500,
      card_last4: "4444",
      allocations: 0,
    });
    const events = await owner.query(
      "select source from payment_events where payment_id = (select id from payments where stripe_pi_id = $1)",
      [pi["id"]],
    );
    expect(events.rows).toEqual([{ source: "reconciler" }]);
    // A second run records it once.
    expect((await reconcileLater()).unmatched).toHaveLength(0);
  });

  it("a reader dropping mid-payment, with no webhooks, ends canceled and frees the amount", async () => {
    const r = await tap("chk_t4", 4000);
    expect(r.json().state).toBe("waiting");
    await fetch(`${fake.base}/fake/readers/${await readerOf("dev_front_reader")}/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "status=offline",
    });
    await reconcileLater();
    expect((await lastPayment()).status).toBe("canceled");
    expect(await due("chk_t4")).toBe(4000);
    await fetch(`${fake.base}/fake/readers/${await readerOf("dev_front_reader")}/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "status=online",
    });
  });

  it("a timeout leaves no attempt unknown after the reconciler's next run", async () => {
    faults.drop = /process_payment_intent/;
    const r = await tap("chk_t3", 1200);
    expect(r.statusCode).toBe(202);
    await reconcileLater();
    const left = await owner.query<{ n: number }>(
      "select count(*)::int as n from payment_attempts where state in ('started', 'unknown')",
    );
    expect(left.rows[0]!.n).toBe(0);
    expect((await lastPayment()).status).toBe("canceled");
  });
});
