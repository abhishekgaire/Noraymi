import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createPayLink,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  withVenue,
  type Queryable,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import "../payments/payouts.js";
import { presentCheck } from "../rooms/present.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { stripeEventHandlers } from "../stripe/webhooks.js";

/**
 * Payout matching and Unmatched payments (M7-14) against the fake Stripe: a payout covering Room 9's and
 * Room 3's card payments matches both, its lines adding up to the payout; Stripe's fee posts as a fee; a
 * Tap to Pay payment from Stripe's Dashboard app lands in Unmatched payments and Andy matches it to Room
 * 12; matching over the amount due is refused; the same event twice changes nothing; a PaymentIntent
 * another organization's venue knows is never matched to it.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const clock = new FrozenClock(SEED_NOW);

const person = (slug: string, role: string): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: "passkey",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
});
const as = (p: Principal, method: "GET" | "POST", path: string, payload?: object) => {
  who = p;
  return api
    .inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) })
    .finally(() => {
      who = undefined;
    });
};
/** Applies the fake's newest event of a type through its handler, as the stripe.event job does. */
let account = "";
const deliver = async (type: string) => {
  const entry = [...fake.events].reverse().find((e) => e.event.type === type)!;
  const event = entry.event as unknown as Record<string, unknown>;
  await stripeEventHandlers.get(type)!({
    pool: app,
    stripe,
    venueId,
    event: {
      id: String(event["id"]),
      event_id: String(event["id"]),
      type,
      endpoint: "connect",
      account,
      payload: event,
      processed_at: null,
    },
    training: false,
    now: clock.now(),
    inVenue: <T>(work: (c: Queryable) => Promise<T>) => withVenue(app, { venueId }, work),
  });
};

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
      idempotencyKey: "payout-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
  await owner.query(
    "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
    [ids["order_o1"]],
  );
  await withVenue(app, { venueId }, (c) =>
    presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
  );
  // Room 9's $498.60 paid online with Stripe's dispute test card (4000 0000 0000 0259).
  const link = await withVenue(app, { venueId }, (c) =>
    createPayLink(c, venueId, {
      checkId: ids["chk_room9"]!,
      amountCents: 49860,
      expiresAt: SEED_NOW.add({ hours: 1 }).toString(),
    }),
  );
  await api.inject({ method: "POST", url: `/v1/public/pay/${link.token}` });
  const paid = await api.inject({
    method: "POST",
    url: `/v1/public/pay/${link.token}/confirm`,
    payload: { test_card: "pm_card_visa" },
  });
  expect(paid.json().status).toBe("paid");
  // Room 3's $40.00 toward its bill, paid the same way.
  await withVenue(app, { venueId }, (c) =>
    presentCheck(c, venueId, ids["chk_room3"]!, { userId: ids["andy"]!, now: clock.now() }),
  );
  const room3 = await withVenue(app, { venueId }, (c) =>
    createPayLink(c, venueId, {
      checkId: ids["chk_room3"]!,
      amountCents: 4000,
      expiresAt: SEED_NOW.add({ hours: 1 }).toString(),
    }),
  );
  await api.inject({ method: "POST", url: `/v1/public/pay/${room3.token}` });
  const paid3 = await api.inject({
    method: "POST",
    url: `/v1/public/pay/${room3.token}/confirm`,
    payload: { test_card: "pm_card_visa" },
  });
  expect(paid3.json().status, paid3.body).toBe("paid");
  await new Promise((done) => setTimeout(done, 20));
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await app.end();
  await owner.end();
  await db.drop();
});

const piOf = async (check: string) =>
  (
    await owner.query<{ pi: string; id: string }>(
      `select p.stripe_pi_id as pi, p.id from payments p join payment_allocations a on a.payment_id = p.id
        where a.check_id = $1 and p.stripe_pi_id is not null`,
      [ids[check]],
    )
  ).rows[0]!;
const run = (body: Record<string, string | number>) =>
  fetch(`${fake.base}/fake/accounts/${account}/payout-run`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString(),
  }).then((r) => r.json() as Promise<{ payout: { id: string; amount: number } }>);

describe("payout matching", () => {
  it("matches Room 9's and Room 3's payments, posts Stripe's fee as a fee, and its lines add up to the payout", async () => {
    const room9 = await piOf("chk_room9");
    const room3 = await piOf("chk_room3");
    const { payout } = await run({
      payment_intents: `${room9.pi},${room3.pi}`,
      fee_cents: 150,
      tap_to_pay_cents: 2500,
      tap_to_pay_last4: "0005",
    });
    await deliver("payout.reconciliation_completed");
    await deliver("payout.reconciliation_completed"); // the same event again changes nothing
    const rows = await owner.query<{ reconciled: boolean; amount: number }>(
      "select reconciled, amount_cents::int as amount from payouts where stripe_payout_id = $1",
      [payout.id],
    );
    expect(rows.rows).toEqual([{ reconciled: true, amount: payout.amount }]);
    const lines = await owner.query<{
      type: string;
      payment_id: string | null;
      gross: number;
      net: number;
    }>(
      `select type, payment_id, gross_cents::int as gross, net_cents::int as net from payout_lines
        order by type, gross_cents desc`,
    );
    expect(lines.rows.map((l) => l.type)).toEqual(["charge", "charge", "fee", "unmatched"]);
    expect(
      lines.rows
        .slice(0, 2)
        .map((l) => l.payment_id)
        .sort(),
    ).toEqual([room9.id, room3.id].sort());
    expect(lines.rows.reduce((s, l) => s + l.net, 0)).toBe(payout.amount);
    expect(lines.rows.find((l) => l.type === "fee")).toMatchObject({
      payment_id: null,
      gross: -150,
    });
  });

  it("lists the Tap to Pay payment in Unmatched payments, and Andy matches it to Room 12, whose amount due drops by it", async () => {
    const list = await as(person("andy", "manager"), "GET", "/payments/unmatched");
    expect(list.statusCode, list.body).toBe(200);
    const unmatched = list.json().payments as {
      id: string;
      amount_cents: number;
      card_last4: string;
      at: string;
    }[];
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({ amount_cents: 2500, card_last4: "0005" });
    const due = async () =>
      (
        await withVenue(app, { venueId }, (c) =>
          c.query<{ due: string }>("select amount_due($1) as due", [ids["chk_room12"]]),
        )
      ).rows[0]!.due;
    // Room 12's bill, presented: what it owes is on its lines.
    await withVenue(app, { venueId }, (c) =>
      presentCheck(c, venueId, ids["chk_room12"]!, { userId: ids["andy"]!, now: clock.now() }),
    );
    const before = Number(await due());
    expect(before).toBeGreaterThan(2500);
    const r = await as(person("andy", "manager"), "POST", `/payments/${unmatched[0]!.id}/match`, {
      check_id: ids["chk_room12"],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(Number(await due())).toBe(before - 2500);
    expect(
      (await as(person("andy", "manager"), "GET", "/payments/unmatched")).json().payments,
    ).toEqual([]);
  });

  it("refuses matching more than a check's amount due", async () => {
    await run({ tap_to_pay_cents: 99_999_00, tap_to_pay_last4: "9999" });
    await deliver("payout.reconciliation_completed");
    const big = (await as(person("andy", "manager"), "GET", "/payments/unmatched")).json()
      .payments[0] as {
      id: string;
    };
    const r = await as(person("andy", "manager"), "POST", `/payments/${big.id}/match`, {
      check_id: ids["chk_room12"],
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("over_amount_due");
  });

  it("never matches a PaymentIntent another organization's venue has a row for; the owner's report reads the whole payout", async () => {
    const org = (
      await owner.query<{ id: string }>(
        "insert into organizations (legal_name) values ('Other LLC') returning id",
      )
    ).rows[0]!.id;
    const other = (
      await owner.query<{ id: string }>(
        "insert into venues (org_id, name, slug) values ($1, 'Other', 'other-payouts') returning id",
        [org],
      )
    ).rows[0]!.id;
    // A payment on West 4's account that another organization's venue claims the PaymentIntent of.
    const { payout } = await run({ tap_to_pay_cents: 1500, tap_to_pay_last4: "1111" });
    const txn = fake.list(
      "balance_transaction",
      account,
      (t) => t["_payout"] === payout.id && t["type"] === "charge",
    )[0]!;
    const pi = (txn["source"] as { payment_intent: string }).payment_intent;
    await owner.query(
      `insert into payments (venue_id, method, status, stripe_pi_id, amount_cents, business_date)
       values ($1, 'card_present', 'captured', $2, 1500, '2026-09-25')`,
      [other, pi],
    );
    await deliver("payout.reconciliation_completed");
    const theirs = await owner.query("select 1 from payout_lines where venue_id = $1", [other]);
    expect(theirs.rowCount).toBe(0);
    const ours = await owner.query<{ type: string }>(
      `select l.type from payout_lines l join payouts o on o.id = l.payout_id where o.stripe_payout_id = $1`,
      [payout.id],
    );
    expect(ours.rows).toEqual([{ type: "unmatched" }]);
    const report = await as(person("abhishek", "owner"), "GET", "/reports/payouts?scope=org");
    expect(report.statusCode, report.body).toBe(200);
    expect(
      (report.json().payouts as { stripe_payout_id: string }[]).map((p) => p.stripe_payout_id),
    ).toContain(payout.id);
    expect((await as(person("andy", "manager"), "GET", "/reports/payouts")).statusCode).toBe(403);
  });
});
