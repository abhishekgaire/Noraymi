import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { presentCheck } from "../rooms/present.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * The live drill's flag (M4-30): during its hour our copy of Stripe's answer is dropped on purpose,
 * the tap reads "Checking with Stripe · don't retry", reading Stripe settles it with one charge, and
 * past the flag's end taps answer as usual.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let account: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

const readerOf = async () =>
  (
    await owner.query<{ s: string }>("select stripe_reader_id as s from devices where id = $1", [
      ids["dev_front_reader"],
    ])
  ).rows[0]!.s;
const tap = (amount: number) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${ids["chk_room9"]}/payments`,
    headers: { "idempotency-key": `drill-${++n}` },
    payload: { method: "tap", amount_cents: amount, reader_id: ids["dev_front_reader"] },
  });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
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
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "drill-acct",
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
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => abhishek],
  });
  await api.ready();
  for (const label of ["Bar S710", "Front desk S710"])
    expect(
      (
        await api.inject({
          method: "POST",
          url: `/v1/venues/${venueId}/readers`,
          payload: { registration_code: "simulated-s710", label },
        })
      ).statusCode,
    ).toBe(201);
  await owner.query(
    `update device_heartbeats set last_seen_at = $1, offline_since = null
      where device_id in (select id from devices where kind = 'reader')`,
    [new Date(clock.now().epochMilliseconds)],
  );
  await owner.query(
    "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
    [ids["order_o1"]],
  );
  await withVenue(app, { venueId }, (c) =>
    presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
  );
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("the live drill's flag", () => {
  it("drops our copy of the answer during the drill: Checking with Stripe, then Paid, with one charge", async () => {
    await owner.query("update venues set drill_drop_until = $1", [
      new Date(clock.now().add({ hours: 1 }).epochMilliseconds),
    ]);
    const r = await tap(1000);
    expect(r.statusCode).toBe(202);
    expect(r.json().error).toMatchObject({
      code: "payment_unknown",
      message: "Checking with Stripe · don't retry",
    });
    const paymentId = (r.json().error.details.payment as { id: string }).id;
    const present = await fetch(
      `${fake.base}/v1/test_helpers/terminal/readers/${await readerOf()}/present_payment_method`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer rk_test_fake_payments",
          "stripe-account": account,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": `present-${++n}`,
        },
        body: "card_present[number]=4242424242424242",
      },
    );
    expect(present.status).toBe(200);
    const status = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${paymentId}/check-status`,
      headers: { "idempotency-key": `status-${++n}` },
    });
    expect(status.json()).toMatchObject({ state: "paid" });
    const intents = [...fake.objects.values()].filter(
      (o) =>
        o["object"] === "payment_intent" &&
        (o["metadata"] as Record<string, string>)["payment_id"] === paymentId,
    );
    expect(intents).toHaveLength(1);
  });

  it("past the flag's end, a tap answers as usual", async () => {
    await owner.query("update venues set drill_drop_until = $1", [
      new Date(clock.now().subtract({ minutes: 1 }).epochMilliseconds),
    ]);
    const r = await tap(1000);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ state: "waiting" });
  });
});
