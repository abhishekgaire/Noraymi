import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { reconcileVenue } from "../payments/reconcile.js";

/**
 * The deposit on the payment page (M5-09; Payment flows steps 2 and 3, Failures): Jae's one
 * PaymentIntent on West 4's account with a Customer and `setup_future_usage=off_session`, a decline
 * then a good card on it, the accepted policy, the saved card, the hold running out, and the
 * reconciler leaving a deposit alone while its hold stands.
 */
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let account: string;
const clock = new FrozenClock(SEED_NOW);
const jae = { business_date: "2026-10-02", time: "23:00", hours: 2, party_size: 5 };
const details = { name: "Jae K.", phone: "+12125550188", email: "jae@example.com" };

const post = (url: string, payload?: object, headers: Record<string, string> = {}) =>
  api.inject({ method: "POST", url, ...(payload ? { payload } : {}), headers });
/** Pick, Details and Terms → Payment: the booking's link and its pay link. */
async function toPayment(time = "23:00") {
  const held = await post("/v1/public/venues/west4karaoke/bookings", { ...jae, time });
  expect(held.statusCode, held.body).toBe(201);
  const { token, booking } = held.json<{ token: string; booking: { id: string } }>();
  expect((await post(`/v1/public/bookings/${token}/details`, details)).statusCode).toBe(200);
  const r = await post(`/v1/public/bookings/${token}/pay`);
  expect(r.statusCode, r.body).toBe(200);
  const payUrl = r.json<{ pay_url: string }>().pay_url;
  expect(payUrl).toMatch(/^http:\/\/pay\.localhost:3001\/pay\/[A-Za-z0-9_-]{22}$/);
  return { token, bookingId: booking.id, pay: payUrl.split("/").pop()! };
}
const policyId = async () =>
  (
    await owner.query<{ id: string }>(
      "select id from policy_versions where venue_id = $1 and kind = 'deposit' order by version desc limit 1",
      [venueId],
    )
  ).rows[0]!.id;
const ua = { "user-agent": "Mozilla/5.0 (iPhone)", "x-forwarded-for": "198.51.100.7" };

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  pool = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "deposit-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  process.env["TRUSTED_PROXY_HOPS"] = "1";
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
  });
  await api.ready();
});

afterAll(async () => {
  delete process.env["TRUSTED_PROXY_HOPS"];
  await api.close();
  await fake.stop();
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("the deposit on the payment page", () => {
  it("Jae pays $50.00: one PaymentIntent with a Customer and off_session, the policy he read, the saved card", async () => {
    const { pay, bookingId } = await toPayment();
    const page = await post(`/v1/public/pay/${pay}`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({
      status: "open",
      kind: "deposit",
      amount_cents: 5000,
      stripe_account: account,
      deposit: {
        seconds_left: 600,
        more_time_left: 10,
        pick_again_url: "http://localhost:3001/v/west4karaoke/book",
      },
    });
    expect(page.json().deposit.policy.text).toContain("A 20% gratuity is added to room tabs.");
    const intents = () =>
      fake
        .list("payment_intent", account)
        .filter((pi) => (pi["metadata"] as Record<string, string>)["booking_id"] === bookingId);
    expect(intents()).toHaveLength(1);
    expect(intents()[0]).toMatchObject({
      amount: 5000,
      setup_future_usage: "off_session",
      payment_method_types: ["card"],
    });
    expect(intents()[0]!["customer"]).toMatch(/^cus_/);
    // Pressing Pay records the policy read above the button.
    const start = await post(
      `/v1/public/pay/${pay}/start`,
      { policy_version_id: page.json().deposit.policy.id },
      ua,
    );
    expect(start.statusCode, start.body).toBe(200);
    const paid = await post(`/v1/public/pay/${pay}/confirm`, { test_card: "pm_card_visa" });
    expect(paid.json().status).toBe("paid");
    const row = await owner.query(
      `select b.policy_version_id, p.hash, host(b.accepted_ip) as ip, b.accepted_ua, b.accepted_at is not null as at,
              b.payment_method_id
         from bookings b join policy_versions p on p.id = b.policy_version_id where b.id = $1`,
      [bookingId],
    );
    expect(row.rows[0]).toMatchObject({
      policy_version_id: page.json().deposit.policy.id,
      hash: page.json().deposit.policy.hash,
      ip: "198.51.100.7",
      accepted_ua: "Mozilla/5.0 (iPhone)",
      at: true,
      payment_method_id: "pm_card_visa",
    });
    const payment = await owner.query(
      `select p.method, p.status, p.booking_id, a.portion_key from payments p
         join payment_attempts a on a.payment_id = p.id where p.booking_id = $1`,
      [bookingId],
    );
    expect(payment.rows).toEqual([
      { method: "card_online", status: "captured", booking_id: bookingId, portion_key: "deposit" },
    ]);
    expect(intents()).toHaveLength(1);
  });

  it("five tries and a declined card, then a good one: one PaymentIntent, two attempts", async () => {
    const { token, pay, bookingId } = await toPayment("22:00");
    // Five more trips to the payment page, each its own link, all to the one payment.
    const pays = [pay];
    for (let i = 0; i < 4; i++)
      pays.push((await post(`/v1/public/bookings/${token}/pay`)).json().pay_url.split("/").pop());
    for (const p of pays) expect((await post(`/v1/public/pay/${p}`)).statusCode).toBe(200);
    const policy = await policyId();
    await post(`/v1/public/pay/${pay}/start`, { policy_version_id: policy }, ua);
    const declined = await post(`/v1/public/pay/${pay}/confirm`, {
      test_card: "pm_card_chargeDeclined",
    });
    expect(declined.json().status).toBe("declined");
    // Another card on the same PaymentIntent, from another of the links.
    await post(`/v1/public/pay/${pays[3]}/start`, { policy_version_id: policy }, ua);
    const paid = await post(`/v1/public/pay/${pays[3]}/confirm`, { test_card: "pm_card_visa" });
    expect(paid.json().status).toBe("paid");
    const rows = await owner.query<{ pi: string; attempts: string; states: string[] }>(
      `select p.stripe_pi_id as pi, count(a.*)::text as attempts, array_agg(a.state order by a.attempt_no) as states
         from payments p join payment_attempts a on a.payment_id = p.id
        where p.booking_id = $1 group by p.id`,
      [bookingId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ attempts: "2", states: ["failed", "succeeded"] });
    expect(
      fake.list("payment_intent", account).filter((pi) => pi["id"] === rows.rows[0]!.pi),
    ).toHaveLength(1);
  });

  it("a policy that changed since the page loaded is refused, and the hold running out sends Jae back", async () => {
    const { pay, bookingId } = await toPayment("21:00");
    await post(`/v1/public/pay/${pay}`);
    const stale = await post(
      `/v1/public/pay/${pay}/start`,
      { policy_version_id: "00000000-0000-4000-8000-000000000009" },
      ua,
    );
    expect(stale.json().error.details).toEqual({ reason: "policy_changed" });
    // More time from the payment page.
    clock.set(SEED_NOW.add({ minutes: 9, seconds: 30 }));
    const more = await post(`/v1/public/pay/${pay}/more-time`);
    expect(more.json().deposit).toMatchObject({ seconds_left: 600, more_time_left: 9 });
    // The reconciler reads a deposit whose hold still stands, and leaves its PaymentIntent alone.
    clock.set(SEED_NOW.add({ minutes: 15 }));
    await reconcileVenue({ pool, stripe, clock }, venueId);
    const attempt = await owner.query<{ state: string; status: string }>(
      `select a.state, p.status from payments p join payment_attempts a on a.payment_id = p.id where p.booking_id = $1`,
      [bookingId],
    );
    expect(attempt.rows[0]).toEqual({ state: "started", status: "pending" });
    clock.set(SEED_NOW.add({ minutes: 20, seconds: 1 }));
    const lapsed = await post(`/v1/public/pay/${pay}`);
    expect(lapsed.json()).toMatchObject({ status: "lapsed", client_secret: null });
    const refused = await post(
      `/v1/public/pay/${pay}/start`,
      { policy_version_id: await policyId() },
      ua,
    );
    expect(refused.json().error.details).toEqual({ reason: "hold_over" });
    // Once the hold is gone, the reconciler cancels the PaymentIntent nobody paid.
    await reconcileVenue({ pool, stripe, clock }, venueId);
    const after = await owner.query<{ status: string }>(
      "select status from payments where booking_id = $1",
      [bookingId],
    );
    expect(after.rows[0]!.status).toBe("canceled");
    clock.set(SEED_NOW);
  });

  it("chaos: Stripe took the money and we never heard; the reconciler records it", async () => {
    const { pay, bookingId } = await toPayment("20:30");
    await post(`/v1/public/pay/${pay}`);
    const pi = (
      await owner.query<{ pi: string }>(
        "select stripe_pi_id as pi from payments where booking_id = $1",
        [bookingId],
      )
    ).rows[0]!.pi;
    // The browser confirmed with Stripe, then our process died before /confirm.
    await stripe.call("payments", "POST", `/v1/payment_intents/${pi}/confirm`, {
      account,
      idempotencyKey: `chaos:${pi}`,
      params: { payment_method: "pm_card_visa" },
    });
    clock.set(SEED_NOW.add({ minutes: 3 }));
    await reconcileVenue({ pool, stripe, clock }, venueId);
    clock.set(SEED_NOW);
    const row = await owner.query<{ status: string; pm: string | null }>(
      `select p.status, b.payment_method_id as pm from payments p join bookings b on b.id = p.booking_id
        where p.booking_id = $1`,
      [bookingId],
    );
    expect(row.rows[0]).toEqual({ status: "captured", pm: "pm_card_visa" });
  });

  it("no pay link before the details", async () => {
    const held = await post("/v1/public/venues/west4karaoke/bookings", { ...jae, time: "20:00" });
    const r = await post(`/v1/public/bookings/${held.json().token}/pay`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toEqual({ reason: "details" });
  });
});
