import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { decide } from "../approvals/service.js";
import type { Principal } from "../http/principal.js";
import { askRefund, applyRefund, runRefund } from "../payments/refunds.js";
import { confirmCollected } from "../payments/surcharge.js";
import { presentCheck } from "../rooms/present.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * The card fee at the reader (M4-25) on a test venue with a 2.7% surcharge, against the fake Stripe:
 * collect, the fee on credit only (and its tax while surcharges are taxable), confirm, the lines on
 * capture, and a refund that gives the fee back.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let account: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;
const deps = () => ({ pool: app, stripe, clock });

const readerOf = (slug: string) =>
  owner
    .query<{ s: string }>("select stripe_reader_id as s from devices where id = $1", [ids[slug]])
    .then((r) => r.rows[0]!.s);
const tap = (checkSlug: string, amount: number) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${ids[checkSlug]}/payments`,
    headers: { "idempotency-key": `tap-${++n}` },
    payload: { method: "tap", amount_cents: amount, reader_id: ids["dev_front_reader"] },
  });
const present = async (number: string) => {
  const r = await fetch(
    `${fake.base}/v1/test_helpers/terminal/readers/${await readerOf("dev_front_reader")}/present_payment_method`,
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
const status = (paymentId: string) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/payments/${paymentId}/check-status`,
    headers: { "idempotency-key": `status-${++n}` },
  });
const due = async (checkSlug: string) =>
  Number(
    (
      await withVenue(app, { venueId }, (c) =>
        c.query<{ d: string }>("select amount_due($1) as d", [ids[checkSlug]]),
      )
    ).rows[0]!.d,
  );

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
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "surcharge-acct",
      params: { display_name: "A test venue" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  // A test venue: a 2.7% surcharge whose notice went out Aug 1 (so it applies from Aug 31), and the flag on.
  await owner.query(
    `update venue_settings set value = jsonb_set(value, '{cardFee}',
       '{"mode": "surcharge", "pct": 2.7, "noticeSentOn": "2026-08-01"}'::jsonb) where key = 'pay'`,
  );
  await owner.query("update venues set surcharge_reader = true");
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
  for (const label of ["Bar S710", "Front desk S710"]) {
    const r = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/readers`,
      payload: { registration_code: "simulated-s710", label },
    });
    expect(r.statusCode, r.body).toBe(201);
  }
  await owner.query(
    `update device_heartbeats set last_seen_at = $1, offline_since = null
      where device_id in (select id from devices where kind = 'reader')`,
    [new Date(clock.now().epochMilliseconds)],
  );
  await owner.query(
    "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
    [ids["order_o1"]],
  );
  for (const check of ["chk_room9", "chk_room3"]) {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where check_id = $1 and status in ('ringing', 'held')",
      [ids[check]],
    );
    await withVenue(app, { venueId }, (c) =>
      presentCheck(c, venueId, ids[check]!, { userId: ids["andy"]!, now: clock.now() }),
    );
  }
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("a 2.7% surcharge at the reader", () => {
  let paymentId = "";

  it("Room 9's $498.60 on a credit card: $13.46 surcharge and $1.19 tax on it, $513.25 in all", async () => {
    const r = await tap("chk_room9", 49860);
    expect(r.statusCode, r.body).toBe(201);
    paymentId = r.json().id;
    const reader = await readerOf("dev_front_reader");
    const action = (fake.objects.get(reader)!["action"] as { type: string }).type;
    expect(action).toBe("collect_payment_method");
    await present("4242424242424242");
    await confirmCollected(deps(), venueId, paymentId);
    const pi = [...fake.objects.values()].find(
      (o) =>
        o["object"] === "payment_intent" &&
        (o["metadata"] as Record<string, string>)["payment_id"] === paymentId,
    )!;
    expect(pi["amount"]).toBe(51325);
    expect(pi["amount_details"]).toMatchObject({ surcharge: { amount: 1346 } });
    expect((await status(paymentId)).json()).toMatchObject({ state: "paid" });
    const p = (
      await owner.query(
        "select amount_cents::int, surcharge_cents::int from payments where id = $1",
        [paymentId],
      )
    ).rows[0];
    expect(p).toEqual({ amount_cents: 49979, surcharge_cents: 1346 });
    const lines = await owner.query(
      "select kind, amount_cents::int from check_lines where check_id = $1 and reason = $2 order by id",
      [ids["chk_room9"], `payment ${paymentId}`],
    );
    expect(lines.rows).toEqual([
      { kind: "card_surcharge", amount_cents: 1346 },
      { kind: "tax", amount_cents: 119 },
    ]);
    expect(await due("chk_room9")).toBe(0);
  });

  it("the same on a debit card stays at the check's amount", async () => {
    const owed = await due("chk_room3");
    const r = await tap("chk_room3", owed);
    const id = r.json().id as string;
    await present("4000056655665556");
    await confirmCollected(deps(), venueId, id);
    expect((await status(id)).json()).toMatchObject({ state: "paid" });
    const p = (
      await owner.query(
        "select amount_cents::int, surcharge_cents::int from payments where id = $1",
        [id],
      )
    ).rows[0];
    expect(p).toEqual({ amount_cents: owed, surcharge_cents: 0 });
    expect(await due("chk_room3")).toBe(0);
  });

  it("refunding the whole surcharged payment gives back the $13.46 and its tax", async () => {
    const asked = await withVenue(app, { venueId }, (c) =>
      askRefund(c, venueId, {
        checkId: ids["chk_room9"]!,
        bookingId: null,
        lines: [],
        parts: [{ paymentId, amountCents: 51325 }],
        reason: "Charged by mistake",
        userId: ids["andy"]!,
        deviceId: null,
        businessDate: "2026-09-25",
        now: clock.now(),
      }),
    );
    await withVenue(app, { venueId }, (c) =>
      decide(c, venueId, asked.approval_id, {
        decision: "approve",
        userId: ids["abhishek"]!,
        deviceId: randomUUID(),
        at: clock.now(),
      }),
    );
    const back = await owner.query(
      "select description, amount_cents::int from check_lines where check_id = $1 and kind = 'refund' order by id",
      [ids["chk_room9"]],
    );
    expect(back.rows).toEqual(
      expect.arrayContaining([
        { description: "Refund · Credit card surcharge", amount_cents: -1346 },
        { description: "Refund · Tax · fees", amount_cents: -119 },
      ]),
    );
    expect(back.rows.reduce((s, r) => s + r.amount_cents, 0)).toBe(-51325);
    const refundId = asked.refund_ids[0]!;
    await runRefund(deps(), venueId, refundId);
    const stripeId = (
      await owner.query("select stripe_refund_id from refunds where id = $1", [refundId])
    ).rows[0].stripe_refund_id as string;
    await applyRefund(deps(), venueId, stripeId, null);
    expect(
      (await owner.query("select status from payments where id = $1", [paymentId])).rows[0].status,
    ).toBe("refunded");
  });

  it("with the fee off, nothing changes", async () => {
    await owner.query("update venues set surcharge_reader = false");
    const menu = (
      await api.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/menu" })
    ).json();
    const prices = menu.categories.flatMap(
      (c: { items: { variants: { price_cents: number }[] }[] }) =>
        c.items.flatMap((i) => i.variants.map((v) => v.price_cents)),
    );
    expect(prices).toContain(800); // Bud Light at its own $8.00
    await owner.query("update venues set surcharge_reader = true");
    const credit = (
      await api.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/menu" })
    ).json();
    const creditPrices = credit.categories.flatMap(
      (c: { items: { variants: { price_cents: number }[] }[] }) =>
        c.items.flatMap((i) => i.variants.map((v) => v.price_cents)),
    );
    expect(creditPrices).toContain(822); // $8.00 + 2.7%, half up
  });
});
