import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createPayLink,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let ids: Record<string, string>;
let account: string;
const clock = new FrozenClock(SEED_NOW);
const link = (
  checkSlug: string,
  cents: number,
  expiresAt = SEED_NOW.add({ hours: 24 }).toString(),
) =>
  withVenue(app, { venueId }, (c) =>
    createPayLink(c, venueId, { checkId: ids[checkSlug]!, amountCents: cents, expiresAt }),
  );
const open = (token: string) => api.inject({ method: "POST", url: `/v1/public/pay/${token}` });
const confirm = (token: string, card: string) =>
  api.inject({
    method: "POST",
    url: `/v1/public/pay/${token}/confirm`,
    payload: { test_card: card },
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
      idempotencyKey: "pay-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("pay links", () => {
  it("answers the client secret on the venue's account, and a reload reuses the same PaymentIntent", async () => {
    const { token } = await link("chk_t1", 3000);
    const first = await open(token);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    expect(first.headers["cache-control"]).toContain("no-store");
    expect(first.json()).toMatchObject({
      status: "open",
      amount_cents: 3000,
      stripe_account: account,
      publishable_key: "pk_test_fake",
      venue_name: "West 4 Boho Karaoke",
    });
    const again = await open(token);
    expect(again.json().client_secret).toBe(first.json().client_secret);
    expect(fake.list("payment_intent", account)).toHaveLength(1);
    expect(fake.list("payment_intent", account)[0]).toMatchObject({
      amount: 3000,
      automatic_payment_methods: { enabled: "true" },
    });
  });

  it("records Paid after the Payment Element confirms, and a declined card can try again on the same PaymentIntent", async () => {
    const { token } = await link("chk_t2", 5800);
    await open(token);
    const declined = await confirm(token, "pm_card_chargeDeclined");
    expect(declined.json().status).toBe("declined");
    const retry = await open(token);
    expect(retry.json().status).toBe("open");
    const paid = await confirm(token, "pm_card_visa");
    expect(paid.json().status).toBe("paid");
    const payment = await owner.query<{ status: string; attempts: number; method: string }>(
      `select p.status, p.method, (select count(*)::int from payment_attempts a where a.payment_id = p.id) as attempts
         from payments p join pay_links l on l.payment_id = p.id where l.check_id = $1`,
      [ids["chk_t2"]],
    );
    expect(payment.rows).toEqual([{ status: "captured", method: "card_online", attempts: 2 }]);
    expect(fake.list("payment_intent", account, (x) => x["amount"] === 5800)).toHaveLength(1);
    // A paid link stays paid on a reload.
    expect((await open(token)).json()).toMatchObject({ status: "paid", client_secret: null });
  });

  it("answers not found for a wrong or expired token", async () => {
    expect((await open("A".repeat(22))).statusCode).toBe(404);
    expect((await open("not-a-token")).statusCode).toBe(404);
    const { token } = await link("chk_t3", 1200, SEED_NOW.subtract({ minutes: 1 }).toString());
    expect((await open(token)).statusCode).toBe(404);
  });
});
