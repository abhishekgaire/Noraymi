import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { seedStripe } from "../stripe/seed-stripe.js";
import { makePaymentHandlers } from "../payments/run.js";
import { applyRefund } from "../payments/refunds.js";

/**
 * M5-12 acceptance: Jae cancels before the cut-off and gets $50.00 back automatically, "Refunded" once
 * Stripe confirms, with the Deposit refund text; Jae cancels after it and the $50.00 is a forfeit line
 * on a fee check with the next number; the Nguyens' no-show keeps their $60.00; blocking a date with
 * three bookings refunds each in full and texts each guest; a no-show under "first hour" charges the
 * rest off-session, and a card that declines gets the Payment link text; refund status shows with
 * Online booking & deposits off.
 */
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let worker: Worker;
let stripe: StripeClient;
let venueId: string;
let ids: Record<string, string> = {};
const WED = Temporal.Instant.from("2026-09-23T20:00:00Z");
const THU_10PM = Temporal.Instant.from("2026-09-25T02:00:00Z");
const FRI_1041 = Temporal.Instant.from("2026-09-26T02:41:00Z");
const clock = new FrozenClock(WED);
const who: Record<string, Principal> = {};

const post = (url: string, payload?: object) =>
  api.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
const staff = (as: string, url: string, payload?: object) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${url}`,
    headers: { "x-test-as": as },
    ...(payload ? { payload } : {}),
  });
const cancel = (token: string) =>
  api.inject({ method: "DELETE", url: `/v1/public/bookings/${token}` });
const manage = async (token: string) =>
  (await api.inject({ method: "GET", url: `/v1/public/bookings/${token}` })).json().manage;
/** The jobs, then Stripe's word on each refund sent (what `refund.updated` brings in production). */
const drain = async () => {
  while ((await worker.tick()) > 0);
  const sent = await owner.query<{ id: string; re: string }>(
    "select id, stripe_refund_id as re from refunds where status = 'pending' and stripe_refund_id is not null",
  );
  for (const r of sent.rows) await applyRefund({ pool, stripe, clock }, venueId, r.re, r.id);
};
const linkFor = async (slug: string) => {
  const token = randomBytes(16).toString("base64url");
  await owner.query("update bookings set manage_token_hash = $2 where id = $1", [
    ids[slug],
    createHash("sha256").update(token).digest("hex"),
  ]);
  return token;
};
const texts = async (like: string) =>
  (
    await owner.query<{ body: string }>(
      "select body from messages where venue_id = $1 and body like $2 order by created_at",
      [venueId, like],
    )
  ).rows.map((r) => r.body);

/** A booking made and paid on the site, the way a guest does it. */
async function booked(
  body: { business_date: string; time: string; party_size: number },
  guest: { name: string; phone: string },
  card = "pm_card_visa",
) {
  const held = await post("/v1/public/venues/west4karaoke/bookings", { hours: 2, ...body });
  expect(held.statusCode, held.body).toBe(201);
  const { token, booking } = held.json<{ token: string; booking: { id: string } }>();
  const details = { ...guest, email: "guest@example.com" };
  expect((await post(`/v1/public/bookings/${token}/details`, details)).statusCode).toBe(200);
  const pay = (await post(`/v1/public/bookings/${token}/pay`)).json().pay_url.split("/").pop();
  const page = (await post(`/v1/public/pay/${pay}`)).json();
  await post(`/v1/public/pay/${pay}/start`, { policy_version_id: page.deposit.policy.id });
  const paid = await post(`/v1/public/pay/${pay}/confirm`, { test_card: card });
  expect(paid.json()).toMatchObject({ status: "paid" });
  return { token, bookingId: booking.id };
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
  stripe = new StripeClient(fakeStripeSettings(await fake.start()), fetch, 15_000);
  await seedStripe(owner, stripe, () => undefined);
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  for (const role of ["front_desk", "manager"]) {
    const m = (
      await owner.query<{ id: string; user_id: string }>(
        "select id, user_id from memberships where venue_id = $1 and role = $2 limit 1",
        [venueId, role],
      )
    ).rows[0]!;
    who[role] = {
      kind: "user",
      userId: m.user_id,
      session: role === "manager" ? "passkey" : "pin",
      memberships: [{ venueId, membershipId: m.id, role: role as "manager" }],
    };
  }
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
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
  worker = new Worker(pool, {
    pool: "critical",
    handlers: makePaymentHandlers({
      pool,
      stripe,
      clock,
      payAppUrl: "https://pay.west4karaoke.com",
      texts: { allowList: null },
    }),
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

describe("cancelling and no-shows", () => {
  it("Jae (booked Wed for Fri 11:00 PM) cancels Thu 10:00 PM: $50.00 back by rule, Refunded once Stripe confirms, and the Deposit refund text", async () => {
    const jae = await booked(
      { business_date: "2026-09-25", time: "23:00", party_size: 5 },
      { name: "Jae K.", phone: "+12125550188" },
    );
    clock.set(THU_10PM);
    // With Online booking & deposits off (M5-14), Jae's manage link still opens, cancels and shows the refund.
    await owner.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'online_booking'",
      [venueId],
    );
    expect((await manage(jae.token)).status).toBe("confirmed");
    const r = await cancel(jae.token);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      refund_cents: 5000,
      kept_cents: 0,
      booking: { status: "cancelled", cancelled_via: "guest", refund: { status: "pending" } },
    });
    const refund = await owner.query(
      "select amount_cents::int as amount, automatic, requested_by, approval_id from refunds where booking_id = $1",
      [jae.bookingId],
    );
    expect(refund.rows).toEqual([
      { amount: 5000, automatic: true, requested_by: null, approval_id: null },
    ]);
    expect(
      (await owner.query("select 1 from room_blocks where ref_id = $1", [jae.bookingId])).rowCount,
    ).toBe(0);
    await drain();
    expect((await manage(jae.token)).refund).toEqual({ amount_cents: 5000, status: "refunded" });
    expect(await texts("%$50.00 deposit for Fri Sep 25%")).toHaveLength(1);
    // Cancelling again changes nothing.
    expect((await cancel(jae.token)).json().refund_cents).toBe(0);
    await owner.query(
      "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'online_booking'",
      [venueId],
    );
    clock.set(WED);
  });

  it("Jae cancels Fri 10:41 PM, after Thu 11:00 PM: the $50.00 is a forfeit line on a fee check with the next number", async () => {
    clock.set(FRI_1041);
    const token = await linkFor("bk_jae");
    const next = Number(
      (
        await owner.query<{ next: string }>(
          "select next from venue_counters where venue_id = $1 and name = 'check'",
          [venueId],
        )
      ).rows[0]!.next,
    );
    const r = await cancel(token);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      refund_cents: 0,
      kept_cents: 5000,
      booking: { status: "cancelled", refund: null, kept_cents: 5000 },
    });
    const fee = await owner.query(
      `select k.number::int as number, k.kind, k.status, l.kind as line, l.amount_cents::int as amount
         from checks k join check_lines l on l.venue_id = k.venue_id and l.check_id = k.id
        where k.booking_id = $1 and k.kind = 'fee'`,
      [ids["bk_jae"]],
    );
    expect(fee.rows).toEqual([
      { number: next, kind: "fee", status: "paid", line: "forfeit", amount: 5000 },
    ]);
    expect(
      (await owner.query("select 1 from refunds where booking_id = $1", [ids["bk_jae"]])).rowCount,
    ).toBe(0);
    clock.set(WED);
  });

  it("the Nguyens, marked no-show after 11:15 PM, keep their $60.00 deposit as a forfeit", async () => {
    clock.set(Temporal.Instant.from("2026-09-26T03:16:00Z"));
    const r = await staff("front_desk", `/bookings/${ids["bk_nguyens"]}/no-show`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().deposit).toEqual({ refund_cents: 0, kept_cents: 6000, charge_cents: 0 });
    const fee = await owner.query(
      `select k.status, sum(l.amount_cents)::int as kept from checks k
         join check_lines l on l.venue_id = k.venue_id and l.check_id = k.id
        where k.booking_id = $1 and k.kind = 'fee' and l.kind = 'forfeit' group by k.status`,
      [ids["bk_nguyens"]],
    );
    expect(fee.rows).toEqual([{ status: "paid", kept: 6000 }]);
    clock.set(WED);
  });

  it("blocking a date with three bookings: Cancel and refund all refunds each in full and texts each guest", async () => {
    const guests = [
      { name: "Ana R.", phone: "+12125550141" },
      { name: "Ben S.", phone: "+12125550142" },
      { name: "Cleo T.", phone: "+12125550143" },
    ];
    const made = [];
    for (const [i, g] of guests.entries())
      made.push(
        await booked(
          { business_date: "2026-10-02", time: ["20:00", "21:00", "22:00"][i]!, party_size: 5 },
          g,
        ),
      );
    const r = await staff("manager", "/closures", {
      date: "2026-10-02",
      kind: "closed",
      cancel_bookings: true,
    });
    expect(r.statusCode, r.body).toBe(201);
    const cancelled = r.json().cancelled as { refund_cents: number; manual_refund_cents: number }[];
    expect(cancelled).toHaveLength(3);
    expect(cancelled.every((x) => x.refund_cents === 5000 && x.manual_refund_cents === 0)).toBe(
      true,
    );
    const states = await owner.query<{ status: string; cancelled_via: string }>(
      "select status, cancelled_via from bookings where id = any($1::uuid[])",
      [made.map((m) => m.bookingId)],
    );
    expect(states.rows.every((b) => b.status === "cancelled" && b.cancelled_via === "venue")).toBe(
      true,
    );
    await drain();
    expect(await texts("%$50.00 deposit for Fri Oct 2%")).toHaveLength(3);
  });

  it("a no-show under first hour: the deposit counts, the rest is charged off-session, and a card that declines gets a pay link", async () => {
    await owner.query(
      `update venue_settings set value = value || '{"mode": "flat", "value": 2000, "noShow": "firstHour"}'::jsonb
        where venue_id = $1 and key = 'deposit'`,
      [venueId],
    );
    const dee = await booked(
      { business_date: "2026-10-09", time: "21:00", party_size: 5 },
      { name: "Dee U.", phone: "+12125550144" },
      "pm_card_chargeCustomerFail",
    );
    clock.set(Temporal.Instant.from("2026-10-10T01:16:00Z"));
    const r = await staff("front_desk", `/bookings/${dee.bookingId}/no-show`);
    expect(r.statusCode, r.body).toBe(200);
    // Friday's first hour for 5 is $50.00: the $20.00 deposit is kept and $30.00 charged.
    expect(r.json().deposit).toEqual({ refund_cents: 0, kept_cents: 2000, charge_cents: 3000 });
    await drain();
    const charge = await owner.query<{ status: string; mit_reason: string }>(
      "select status, mit_reason from payments where booking_id = $1 and method = 'card_on_file'",
      [dee.bookingId],
    );
    expect(charge.rows).toEqual([
      { status: "canceled", mit_reason: "No-show, as the accepted deposit policy says" },
    ]);
    expect(await texts("%pay the $30.00 deposit here%")).toHaveLength(1);
    clock.set(WED);
  });
});
