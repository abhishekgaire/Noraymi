import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker } from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe, signPayload } from "../stripe/fake/index.js";
import { FAKE_WEBHOOK_SECRETS, fakeStripeSettings } from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";

let db: TestDatabase;
let v: TwoVenues;
let owner: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let accountA: string;
let accountC: string;
let venueC: string;
const clock = new FrozenClock(SEED_NOW);

const event = (over: Record<string, unknown> = {}) => ({
  id: `evt_${Math.random().toString(36).slice(2)}`,
  object: "event",
  type: "account.updated",
  livemode: false,
  created: 1,
  data: { object: { id: accountA, object: "account" } },
  account: accountA,
  ...over,
});
const post = (
  endpoint: string,
  body: unknown,
  secret = FAKE_WEBHOOK_SECRETS.connect,
  sig?: string,
) => {
  const payload = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: `/v1/hooks/stripe/${endpoint}`,
    headers: {
      "content-type": "application/json",
      "stripe-signature": sig ?? signPayload(payload, secret),
    },
    payload,
  });
};
const count = async (sql: string, params: unknown[] = []) =>
  (await owner.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url });
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  const make = async (name: string) =>
    (
      await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
        account: null,
        platform: true,
        idempotencyKey: `acct-${name}`,
        params: { display_name: name },
      })
    ).id;
  accountA = await make("A");
  accountC = await make("C");
  await owner.query("update organizations set stripe_account_id = $1 where id = $2", [
    accountA,
    v.orgId,
  ]);
  const org = (
    await owner.query<{ id: string }>(
      "insert into organizations (legal_name, stripe_account_id) values ('C LLC', $1) returning id",
      [accountC],
    )
  ).rows[0]!.id;
  venueC = (
    await owner.query<{ id: string }>(
      "insert into venues (org_id, name, slug) values ($1, 'Venue C', 'venue-c') returning id",
      [org],
    )
  ).rows[0]!.id;
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await owner.end();
  await db.drop();
});

describe("Stripe's webhooks", () => {
  it("refuse a bad signature, or one made with another endpoint's secret, before any read or write", async () => {
    const before = await count("webhook_events");
    expect(
      (await post("connect", event(), FAKE_WEBHOOK_SECRETS.connect, "t=1,v1=00")).statusCode,
    ).toBe(400);
    expect((await post("connect", event(), FAKE_WEBHOOK_SECRETS.readers)).statusCode).toBe(400);
    expect(
      (
        await post(
          "readers",
          event({ type: "terminal.reader.action_succeeded" }),
          FAKE_WEBHOOK_SECRETS.connect,
        )
      ).statusCode,
    ).toBe(400);
    const stale = JSON.stringify(event());
    const old = signPayload(
      stale,
      FAKE_WEBHOOK_SECRETS.connect,
      Math.floor(Date.now() / 1000) - 600,
    );
    expect(
      (await post("connect", JSON.parse(stale), FAKE_WEBHOOK_SECRETS.connect, old)).statusCode,
    ).toBe(400);
    expect(await count("webhook_events")).toBe(before);
  });

  it("refuse a live event outside production", async () => {
    const before = await count("webhook_events");
    const r = await post("connect", event({ livemode: true }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/live event outside production/);
    expect(await count("webhook_events")).toBe(before);
  });

  it("store an event once and queue one job, however often it's delivered; Stripe has its 200 before the job runs", async () => {
    const e = event();
    for (let i = 0; i < 3; i++) expect((await post("connect", e)).statusCode).toBe(200);
    expect(await count("webhook_events where event_id = $1", [e.id])).toBe(1);
    expect(
      await count("jobs where kind = $1 and dedupe_key = $2 and status = 'queued'", [
        STRIPE_EVENT_KIND,
        `${STRIPE_EVENT_KIND}:${e.id}`,
      ]),
    ).toBe(1);
    const row = (
      await owner.query(
        "select venue_id, endpoint, account, processed_at from webhook_events where event_id = $1",
        [e.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      venue_id: v.venueA,
      endpoint: "connect",
      account: accountA,
      processed_at: null,
    });
  });

  it("route reader events to the critical pool and venue payments to the normal one", async () => {
    const r = event({ type: "terminal.reader.action_succeeded" });
    expect((await post("readers", r, FAKE_WEBHOOK_SECRETS.readers)).statusCode).toBe(200);
    const pool = (
      await owner.query("select pool from jobs where dedupe_key = $1", [
        `${STRIPE_EVENT_KIND}:${r.id}`,
      ])
    ).rows[0];
    expect(pool).toEqual({ pool: "critical" });
  });

  it("apply account.updated once: the account is read again from Stripe into Admin → Payments", async () => {
    await fetch(`${fake.base}/fake/onboarding/${accountA}`);
    const e = event();
    await post("connect", e);
    const worker = new Worker(owner, {
      pool: "normal",
      handlers: { [STRIPE_EVENT_KIND]: makeStripeEventHandler(owner, stripe) },
      clock,
    });
    while ((await worker.tick()) > 0);
    const row = (
      await owner.query(
        "select status, config from integrations where venue_id = $1 and kind = 'stripe'",
        [v.venueA],
      )
    ).rows[0];
    expect(row).toMatchObject({ status: "connected", config: { card_payments: "active" } });
    expect(
      (await owner.query("select processed_at from webhook_events where event_id = $1", [e.id]))
        .rows[0].processed_at,
    ).not.toBeNull();
    // A repeat after it was applied queues nothing more.
    await post("connect", e);
    expect(await count("jobs where dedupe_key = $1", [`${STRIPE_EVENT_KIND}:${e.id}`])).toBe(1);
  });

  it("an event from another venue's account never reads or writes West 4's rows", async () => {
    const e = event({ account: accountC, data: { object: { id: accountC } } });
    await post("connect", e);
    const row = (
      await owner.query("select venue_id from webhook_events where event_id = $1", [e.id])
    ).rows[0];
    expect(row).toEqual({ venue_id: venueC });
    const job = (
      await owner.query("select venue_id from jobs where dedupe_key = $1", [
        `${STRIPE_EVENT_KIND}:${e.id}`,
      ])
    ).rows[0];
    expect(job).toEqual({ venue_id: venueC });
  });

  it("keep our own account's billing events, unprocessed, for M8", async () => {
    const e = event({ type: "invoice.paid", account: undefined, data: { object: { id: "in_1" } } });
    delete (e as { account?: string }).account;
    expect((await post("platform", e, FAKE_WEBHOOK_SECRETS.platform)).statusCode).toBe(200);
    const row = (
      await owner.query("select venue_id, processed_at from webhook_events where event_id = $1", [
        e.id,
      ])
    ).rows[0];
    expect(row).toEqual({ venue_id: null, processed_at: null });
    expect(await count("jobs where dedupe_key = $1", [`${STRIPE_EVENT_KIND}:${e.id}`])).toBe(0);
  });
});
