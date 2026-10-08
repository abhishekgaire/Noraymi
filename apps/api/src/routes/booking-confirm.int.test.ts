import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe, signPayload } from "../stripe/fake/index.js";
import { FAKE_WEBHOOK_SECRETS, fakeStripeSettings } from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";
import { reconcileVenue } from "../payments/reconcile.js";
import { makePaymentHandlers } from "../payments/run.js";
import { sweepHolds } from "../jobs/hold-sweep.js";
import { BOOKING_CONFIRMED_KIND, makeBookingConfirmedHandler } from "../bookings/confirm.js";

/**
 * Confirming the booking (M5-10): the page's return, the webhook and the reconciler each confirm it;
 * the cut-off is fixed at the first confirmation in New York time; the Booking confirmed text says
 * what the page says, with its own manage link; a payment that lands after its hold lapsed confirms
 * with a new block when the room is free and is refunded in full when it's gone.
 */
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let worker: Worker;
let venueId: string;
let account: string;
// Wed Sep 23, 2026, 4:00 PM in New York: Jae books for Friday.
const WED = Temporal.Instant.from("2026-09-23T20:00:00Z");
const clock = new FrozenClock(WED);
const details = { name: "Jae K.", phone: "+12125550188", email: "jae@example.com" };

const post = (url: string, payload?: object) =>
  api.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
const hold = (url: string) => api.inject({ method: "GET", url });
async function paying(body: object) {
  const held = await post("/v1/public/venues/west4karaoke/bookings", body);
  expect(held.statusCode, held.body).toBe(201);
  const { token, booking } = held.json<{ token: string; booking: { id: string } }>();
  expect((await post(`/v1/public/bookings/${token}/details`, details)).statusCode).toBe(200);
  const pay = (await post(`/v1/public/bookings/${token}/pay`)).json().pay_url.split("/").pop();
  const page = (await post(`/v1/public/pay/${pay}`)).json();
  expect(
    (await post(`/v1/public/pay/${pay}/start`, { policy_version_id: page.deposit.policy.id }))
      .statusCode,
  ).toBe(200);
  const pi = (
    await owner.query<{ pi: string }>(
      "select stripe_pi_id as pi from payments where booking_id = $1",
      [booking.id],
    )
  ).rows[0]!.pi;
  return { token, bookingId: booking.id, pay, pi };
}
/** The guest's browser confirming with Stripe, and nothing more (the page closed at once). */
const stripePays = (pi: string) =>
  stripe.call("payments", "POST", `/v1/payment_intents/${pi}/confirm`, {
    account,
    idempotencyKey: `browser:${pi}`,
    params: { payment_method: "pm_card_visa" },
  });
const statusOf = async (id: string) =>
  (await owner.query<{ status: string }>("select status from bookings where id = $1", [id]))
    .rows[0]!.status;
const drain = async () => {
  while ((await worker.tick()) > 0);
};

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
      idempotencyKey: "confirm-acct",
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
  worker = new Worker(pool, {
    pool: "normal",
    handlers: {
      [STRIPE_EVENT_KIND]: makeStripeEventHandler(pool, stripe),
      [BOOKING_CONFIRMED_KIND]: makeBookingConfirmedHandler({
        allowList: null,
        guestAppUrl: "https://west4karaoke.com",
      }),
    },
    clock,
  });
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("confirming the booking", () => {
  it("booked Wed Sep 23 for Fri 11:00 PM: the page and the text both say Thu 11:00 PM and $50 paid", async () => {
    const { token, bookingId, pay } = await paying({
      business_date: "2026-09-25",
      time: "23:00",
      hours: 2,
      party_size: 5,
    });
    const paid = await post(`/v1/public/pay/${pay}/confirm`, { test_card: "pm_card_visa" });
    expect(paid.json()).toMatchObject({ status: "paid", deposit: { booking_status: "confirmed" } });
    const page = (await hold(`/v1/public/bookings/${token}/hold`)).json();
    expect(page).toMatchObject({
      status: "confirmed",
      pending_until: null,
      deposit_paid_cents: 5000,
      cutoff_words: "Thu 11:00 PM",
      refund_cutoff_at: "2026-09-25T03:00:00+00:00",
      late_refund: null,
    });
    const block = await owner.query("select kind, expires_at from room_blocks where ref_id = $1", [
      bookingId,
    ]);
    expect(block.rows).toEqual([{ kind: "booking", expires_at: null }]);
    await drain();
    const text = await owner.query<{ body: string }>(
      `select m.body from messages m join conversations v on v.id = m.conversation_id
        where v.context_kind = 'booking' and v.context_id = $1`,
      [bookingId],
    );
    expect(text.rows).toHaveLength(1);
    const body = text.rows[0]!.body;
    expect(body).toMatch(
      /^Booked\. Room for 5 at 11:00 PM, Fri Sep 25\. A 20% gratuity is added to room tabs\. Deposit \$50 paid, comes off your bill\. Free to cancel until Thu 11:00 PM: west4karaoke\.com\/b\/[A-Za-z0-9_-]{22}$/,
    );
    // The text's link is a manage link of its own; the one the browser holds still works.
    const textToken = body.split("/b/")[1]!;
    expect(textToken).not.toBe(token);
    const viaText = await hold(`/v1/public/bookings/${textToken}/hold`);
    expect(viaText.statusCode).toBe(200);
    expect(viaText.headers["referrer-policy"]).toBe("no-referrer");
    expect(viaText.json().id).toBe(bookingId);
    // Run again, the job sends nothing more.
    await post(`/v1/public/pay/${pay}/confirm`, { test_card: "pm_card_visa" });
    await drain();
    expect(
      (await owner.query("select 1 from booking_links where booking_id = $1", [bookingId]))
        .rowCount,
    ).toBe(1);
    // The link expires a day after the booking ends.
    clock.set(Temporal.Instant.from("2026-09-27T05:00:01Z"));
    expect((await hold(`/v1/public/bookings/${textToken}/hold`)).statusCode).toBe(404);
    clock.set(WED);
  });

  it("with the page closed right after paying, the webhook confirms the booking", async () => {
    const { bookingId, pi } = await paying({
      business_date: "2026-09-25",
      time: "21:00",
      hours: 2,
      party_size: 5,
    });
    const from = fake.events.length;
    await stripePays(pi);
    expect(await statusOf(bookingId)).toBe("pending");
    for (const e of fake.events.slice(from)) {
      const payload = JSON.stringify(e.event);
      await api.inject({
        method: "POST",
        url: `/v1/hooks/stripe/${e.endpoint}`,
        headers: {
          "content-type": "application/json",
          "stripe-signature": signPayload(payload, FAKE_WEBHOOK_SECRETS[e.endpoint]),
        },
        payload,
      });
    }
    await drain();
    expect(await statusOf(bookingId)).toBe("confirmed");
  });

  it("with the webhook held back too, the reconciler confirms it on its next run", async () => {
    const { bookingId, pi } = await paying({
      business_date: "2026-09-26",
      time: "21:00",
      hours: 2,
      party_size: 5,
    });
    await stripePays(pi);
    clock.set(WED.add({ minutes: 3 }));
    await reconcileVenue({ pool, stripe, clock }, venueId);
    clock.set(WED);
    expect(await statusOf(bookingId)).toBe("confirmed");
  });

  it("a payment after the hold lapsed: the room free again confirms with a new block; taken, it's refunded in full and the page says so", async () => {
    const free = await paying({
      business_date: "2026-09-26",
      time: "23:00",
      hours: 2,
      party_size: 5,
    });
    const gone = await paying({
      business_date: "2026-09-26",
      time: "20:00",
      hours: 2,
      party_size: 5,
    });
    clock.set(WED.add({ minutes: 11 }));
    await sweepHolds(pool, clock.now());
    expect(await statusOf(free.bookingId)).toBe("cancelled");
    expect(await statusOf(gone.bookingId)).toBe("cancelled");
    // Someone books the second room for the same time, by phone.
    await owner.query(
      `insert into room_blocks (venue_id, room_id, period, kind)
       select venue_id, room_id, tstzrange(starts_at, ends_at, '[)'), 'booking' from bookings where id = $1`,
      [gone.bookingId],
    );
    await stripePays(free.pi);
    await stripePays(gone.pi);
    await reconcileVenue({ pool, stripe, clock }, venueId);
    expect(await statusOf(free.bookingId)).toBe("confirmed");
    expect(
      (await owner.query("select kind from room_blocks where ref_id = $1", [free.bookingId])).rows,
    ).toEqual([{ kind: "booking" }]);
    expect(await statusOf(gone.bookingId)).toBe("cancelled");
    const refund = await owner.query(
      "select amount_cents::int as amount, automatic, requested_by, status from refunds where booking_id = $1",
      [gone.bookingId],
    );
    expect(refund.rows).toEqual([
      { amount: 5000, automatic: true, requested_by: null, status: "pending" },
    ]);
    const page = (await post(`/v1/public/pay/${gone.pay}`)).json();
    expect(page).toMatchObject({ status: "refunded", deposit: { late_refund_cents: 5000 } });
    const view = (await hold(`/v1/public/bookings/${gone.token}/hold`)).json();
    expect(view.late_refund).toEqual({ amount_cents: 5000, status: "pending" });
    // The refund goes to Stripe from its job, outside any transaction, with no one approving it.
    const run = makePaymentHandlers({
      pool,
      stripe,
      clock,
      payAppUrl: null,
      texts: { allowList: null },
    });
    const job = (
      await owner.query<{ payload: object }>(
        "select payload from jobs where kind = 'refund.run' and payload->>'refund_id' = (select id::text from refunds where booking_id = $1)",
        [gone.bookingId],
      )
    ).rows[0]!;
    await run["refund.run"]!({ job: { venue_id: venueId, payload: job.payload } } as never);
    const sent = await owner.query<{ stripe_refund_id: string | null }>(
      "select stripe_refund_id from refunds where booking_id = $1",
      [gone.bookingId],
    );
    expect(sent.rows[0]!.stripe_refund_id).toMatch(/^re_/);
    clock.set(WED);
  });

  it("a booking whose cut-off falls across the Nov 1, 2026 change shows it with EDT", async () => {
    clock.set(Temporal.Instant.from("2026-10-30T16:00:00Z"));
    const held = await post("/v1/public/venues/west4karaoke/bookings", {
      business_date: "2026-11-01",
      time: "21:00",
      hours: 2,
      party_size: 5,
    });
    expect(held.statusCode, held.body).toBe(201);
    const view = (await hold(`/v1/public/bookings/${held.json().token}/hold`)).json();
    // Sun Nov 1, 9:00 PM EST less 24 elapsed hours: Sat Oct 31, 10:00 PM EDT.
    expect(view.cutoff_words).toBe("Sat 10:00 PM EDT");
    clock.set(WED);
  });
});
