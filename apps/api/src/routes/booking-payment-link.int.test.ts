import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { seedStripe } from "../stripe/seed-stripe.js";
import { sweepHolds } from "../jobs/hold-sweep.js";

/**
 * M5-13 acceptance: Andy sends a payment link for 22 guests in the VIP room (the Payment link text
 * goes out, the room is held 24 hours or until the start, and paying $250.00 confirms it); the
 * dialog's refusals (24 guests at 9:00 PM over Bianca L.'s hold, and a past slot); an unpaid link
 * lapsing and freeing the room; cardHold saving the card, charging $0.00 and storing the policy.
 */
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let vip: string;
const WED = Temporal.Instant.from("2026-09-23T20:00:00Z");
const FRI_1041 = Temporal.Instant.from("2026-09-26T02:41:00Z");
const clock = new FrozenClock(FRI_1041);
const who: Record<string, Principal> = {};

const post = (url: string, payload?: object) =>
  api.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
const staff = (url: string, payload?: object) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${url}`,
    headers: { "x-test-as": "manager" },
    ...(payload ? { payload } : {}),
  });
const statusOf = async (id: string) =>
  (await owner.query<{ status: string }>("select status from bookings where id = $1", [id]))
    .rows[0]!.status;

/** The guest's side of a link: Pay on the booking page, accept the policy, pay with a test card. */
async function guestPays(token: string, card = "pm_card_visa") {
  const r = await post(`/v1/public/bookings/${token}/pay`);
  expect(r.statusCode, r.body).toBe(200);
  const pay = (r.json().pay_url as string).split("/").pop()!;
  const page = (await post(`/v1/public/pay/${pay}`)).json();
  const started = await post(`/v1/public/pay/${pay}/start`, {
    policy_version_id: page.deposit.policy.id,
  });
  expect(started.statusCode, started.body).toBe(200);
  return { page, paid: (await post(`/v1/public/pay/${pay}/confirm`, { test_card: card })).json() };
}

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
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()), fetch, 15_000);
  await seedStripe(owner, stripe, () => undefined);
  vip = (
    await owner.query<{ id: string }>(
      "select row_id as id from seed_ids where venue_id = $1 and slug = 'room_vip'",
      [venueId],
    )
  ).rows[0]!.id;
  const m = (
    await owner.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'manager' limit 1",
      [venueId],
    )
  ).rows[0]!;
  who["manager"] = {
    kind: "user",
    userId: m.user_id,
    session: "passkey",
    memberships: [{ venueId, membershipId: m.id, role: "manager" }],
  };
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      GUEST_APP_URL: "https://west4karaoke.com",
    }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [
      async (request) => {
        const as = request.headers["x-test-as"];
        return typeof as === "string" ? who[as] : undefined;
      },
    ],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("payment links and cardHold", () => {
  it("Andy sends a link for 22 in the VIP room: the text goes out, the room is held until the start, and $250.00 confirms it", async () => {
    const made = await staff("/bookings", {
      guest: { name: "Priya N.", phone_e164: "+12125550161" },
      party_size: 22,
      business_date: "2026-09-26",
      time: "21:30",
      hours: 3,
      room_id: vip,
    });
    expect(made.statusCode, made.body).toBe(201);
    const booking = made.json().booking as { id: string; status: string; deposit_cents: number };
    expect(booking).toMatchObject({ status: "pending", deposit_cents: 25000 });

    const sent = await staff(`/bookings/${booking.id}/payment-link`);
    expect(sent.statusCode, sent.body).toBe(200);
    // 24 hours from Fri 10:41 PM would be after the 9:30 PM start: held until the start.
    expect(sent.json()).toMatchObject({ pending_until: "2026-09-27T01:30:00Z", texted: true });
    const text = await owner.query<{ body: string }>(
      "select body from messages where venue_id = $1 and body like '%is holding the VIP room for 22%'",
      [venueId],
    );
    expect(text.rows).toHaveLength(1);
    expect(text.rows[0]!.body).toMatch(
      /is holding the VIP room for 22 on Sat Sep 26 at 9:30 PM\. Agree to the terms and pay the \$250\.00 deposit here: west4karaoke\.com\/b\/[A-Za-z0-9_-]{22}$/,
    );
    const block = await owner.query("select kind, expires_at from room_blocks where ref_id = $1", [
      booking.id,
    ]);
    expect(block.rows).toEqual([{ kind: "hold", expires_at: new Date("2026-09-27T01:30:00Z") }]);

    const token = (sent.json().url as string).split("/").pop()!;
    const manage = (await api.inject({ method: "GET", url: `/v1/public/bookings/${token}` })).json()
      .manage;
    expect(manage.pay).toMatchObject({ deposit_cents: 25000, card_hold: false });
    const { page, paid } = await guestPays(token);
    expect(page).toMatchObject({ kind: "deposit", amount_cents: 25000 });
    expect(paid).toMatchObject({ status: "paid", deposit: { booking_status: "confirmed" } });
    expect(await statusOf(booking.id)).toBe("confirmed");
    const accepted = await owner.query(
      "select policy_version_id is not null as accepted from bookings where id = $1",
      [booking.id],
    );
    expect(accepted.rows[0]).toEqual({ accepted: true });
  });

  it("the dialog refuses 24 in the VIP room at 9:00 PM over Bianca L.'s hold, and a slot already past", async () => {
    const body = {
      guest: { name: "Test Party" },
      party_size: 24,
      business_date: "2026-09-25",
      time: "21:00",
      hours: 3,
      room_id: vip,
    };
    expect((await staff("/bookings", body)).json().error.details.reason).toBe("past");
    clock.set(WED);
    const taken = await staff("/bookings", body);
    expect(taken.json().error.code).toBe("room_not_free");
    clock.set(FRI_1041);
  });

  it("an unpaid link lapses at pending_until and frees the room", async () => {
    const made = await staff("/bookings", {
      guest: { name: "Omar Q.", phone_e164: "+12125550162" },
      party_size: 6,
      business_date: "2026-09-27",
      time: "20:00",
      hours: 2,
    });
    const id = made.json().booking.id as string;
    const sent = (await staff(`/bookings/${id}/payment-link`)).json();
    expect(sent.pending_until).toBe("2026-09-27T02:41:00Z");
    await sweepHolds(pool, Temporal.Instant.from("2026-09-27T02:41:01Z"));
    expect(await statusOf(id)).toBe("cancelled");
    expect((await owner.query("select 1 from room_blocks where ref_id = $1", [id])).rowCount).toBe(
      0,
    );
  });

  it("cardHold: a booking saves the card, charges $0.00 and stores the policy version", async () => {
    await owner.query(
      `update venue_settings set value = value || '{"mode": "cardHold", "value": 0}'::jsonb
        where venue_id = $1 and key = 'deposit'`,
      [venueId],
    );
    clock.set(WED);
    const held = await post("/v1/public/venues/west4karaoke/bookings", {
      business_date: "2026-10-02",
      time: "21:00",
      hours: 2,
      party_size: 5,
    });
    expect(held.statusCode, held.body).toBe(201);
    const { token, booking } = held.json<{ token: string; booking: { id: string } }>();
    expect(booking).toMatchObject({ card_hold: true, quote: { deposit_cents: 0 } });
    await post(`/v1/public/bookings/${token}/details`, {
      name: "Lee W.",
      phone: "+12125550163",
      email: "lee@example.com",
    });
    const { page, paid } = await guestPays(token);
    expect(page).toMatchObject({ kind: "card_hold", amount_cents: 0, status: "open" });
    expect(page.client_secret).toMatch(/^seti_secret_/);
    expect(paid).toMatchObject({ status: "paid", deposit: { booking_status: "confirmed" } });
    const b = await owner.query(
      `select status, payment_method_id like 'pm_%' as card, policy_version_id is not null as policy,
              accepted_at is not null as accepted
         from bookings where id = $1`,
      [booking.id],
    );
    expect(b.rows[0]).toEqual({ status: "confirmed", card: true, policy: true, accepted: true });
    const payments = await owner.query("select 1 from payments where booking_id = $1", [
      booking.id,
    ]);
    expect(payments.rowCount).toBe(0);
    clock.set(FRI_1041);
  });
});
