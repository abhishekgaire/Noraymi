import { createHash, randomBytes } from "node:crypto";
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

/**
 * M5-11 acceptance on the demo seed: Jae & co. (5 guests, Fri Sep 25 at 11:00 PM, Room 3, $50.00 paid
 * Wed, free to cancel until Thu 11:00 PM) changes the booking from the manage page. Before the cut-off
 * 5 to 6 collects $10.00 on the payment page and 6 to 3 refunds $20.00 by rule; after it the $60.00
 * stays once he confirms; moving to Saturday keeps the deposit and the cut-off; running late holds
 * the room until 11:15 PM and the Board's bookings show it.
 */
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let jae: string;
let token: string;
const WED = Temporal.Instant.from("2026-09-23T20:00:00Z");
const FRI_1041 = Temporal.Instant.from("2026-09-26T02:41:00Z");
const clock = new FrozenClock(WED);
let diego: Principal;

const path = () => `/v1/public/bookings/${token}`;
const change = (payload: object) => api.inject({ method: "PATCH", url: path(), payload });
const view = async () => (await api.inject({ method: "GET", url: path() })).json().manage;
const post = (url: string, payload?: object) =>
  api.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
const refunds = async () =>
  (
    await owner.query<{ amount: number; automatic: boolean; requested_by: string | null }>(
      `select amount_cents::int as amount, automatic, requested_by from refunds where booking_id = $1
        order by requested_at, n`,
      [jae],
    )
  ).rows;

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
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  const account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "manage-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  jae = (
    await owner.query<{ id: string }>(
      "select row_id as id from seed_ids where venue_id = $1 and slug = 'bk_jae'",
      [venueId],
    )
  ).rows[0]!.id;
  token = randomBytes(16).toString("base64url");
  await owner.query("update bookings set manage_token_hash = $2 where id = $1", [
    jae,
    createHash("sha256").update(token).digest("hex"),
  ]);
  const m = (
    await owner.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'front_desk'",
      [venueId],
    )
  ).rows[0]!;
  diego = {
    kind: "user",
    userId: m.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: m.id, role: "front_desk" }],
  };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async (request) => (request.headers["x-test-staff"] ? diego : undefined)],
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

describe("the manage page", () => {
  it("shows Jae's booking: 5 guests, $50.00 held, free to cancel until Thu 11:00 PM", async () => {
    expect(await view()).toMatchObject({
      status: "confirmed",
      party_size: 5,
      time: "23:00",
      minutes: 120,
      deposit_cents: 5000,
      held_cents: 5000,
      owed_cents: 0,
      cutoff_words: "Thu 11:00 PM",
      before_cutoff: true,
      can_change: true,
      grace_min: 15,
    });
  });

  it("before the cut-off, 5 to 6 guests: the deposit becomes $60.00 and he pays $10.00 on the payment page", async () => {
    const preview = await change({ party_size: 6, preview: true });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      deposit_cents: 6000,
      collect_cents: 1000,
      pay_url: null,
    });
    expect((await view()).party_size).toBe(5);

    const r = await change({ party_size: 6 });
    expect(r.statusCode, r.body).toBe(200);
    const answer = r.json();
    expect(answer).toMatchObject({
      deposit_cents: 6000,
      collect_cents: 1000,
      refund_cents: 0,
      booking: { party_size: 6, deposit_cents: 6000, held_cents: 5000, owed_cents: 1000 },
    });
    const pay = (answer.pay_url as string).split("/").pop()!;
    const page = (await post(`/v1/public/pay/${pay}`)).json();
    expect(page).toMatchObject({ kind: "deposit", amount_cents: 1000, status: "open" });
    // The policy was accepted when the booking was paid for; Pay just starts.
    expect((await post(`/v1/public/pay/${pay}/start`, {})).statusCode).toBe(200);
    const paid = await post(`/v1/public/pay/${pay}/confirm`, { test_card: "pm_card_visa" });
    expect(paid.json()).toMatchObject({ status: "paid" });
    expect(await view()).toMatchObject({ held_cents: 6000, owed_cents: 0 });
    // Asking for a pay link with nothing owed is refused.
    expect((await post(`${path()}/pay`)).json().error.details.reason).toBe("nothing_owed");
  });

  it("after the cut-off, 6 to 3: the $60.00 stays, and the page says so before he confirms", async () => {
    clock.set(FRI_1041);
    const preview = (await change({ party_size: 3, preview: true })).json();
    expect(preview).toMatchObject({ deposit_cents: 6000, refund_cents: 0, stays_cents: 2000 });
    const unconfirmed = await change({ party_size: 3 });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.details).toMatchObject({
      reason: "confirm_keep",
      stays_cents: 2000,
    });
    const r = await change({ party_size: 3, accept_keep: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      booking: { party_size: 3, deposit_cents: 6000, held_cents: 6000, before_cutoff: false },
    });
    expect(await refunds()).toEqual([]);
    clock.set(WED);
  });

  it("before the cut-off, 6 to 3: the deposit becomes $40.00 (Friday bills 4) and $20.00 comes back by rule", async () => {
    await owner.query("update bookings set party_size = 6 where id = $1", [jae]);
    const r = await change({ party_size: 3 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      deposit_cents: 4000,
      refund_cents: 2000,
      booking: { party_size: 3, deposit_cents: 4000, held_cents: 4000 },
    });
    const back = await refunds();
    expect(back.reduce((s, x) => s + x.amount, 0)).toBe(2000);
    // The policy decides it: automatic, with no one asking or approving.
    expect(back.every((x) => x.automatic && x.requested_by === null)).toBe(true);
    const jobs = await owner.query(
      "select 1 from jobs where kind = 'refund.run' and venue_id = $1",
      [venueId],
    );
    expect(jobs.rowCount).toBe(back.length);
  });

  it("running late: held until 11:15 PM, and the Board's bookings show it", async () => {
    clock.set(FRI_1041);
    const r = await change({ running_late: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      running_late_until: "2026-09-26T03:15:00+00:00",
      grace_min: 15,
    });
    const tonight = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/bookings?business_date=2026-09-25`,
      headers: { "x-test-staff": "1" },
    });
    expect(tonight.statusCode, tonight.body).toBe(200);
    const list = tonight.json() as { bookings?: unknown[] } | unknown[];
    const rows = (Array.isArray(list) ? list : (list.bookings ?? [])) as Record<string, unknown>[];
    expect(rows.find((b) => b["id"] === jae)).toMatchObject({
      running_late_until: "2026-09-26T03:15:00+00:00",
    });
    clock.set(WED);
  });

  it("moving Jae to Saturday keeps his deposit, gives him a small room free then, and keeps the Thu 11:00 PM cut-off", async () => {
    const r = await change({ business_date: "2026-09-26" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      collect_cents: 0,
      refund_cents: 0,
      booking: {
        business_date: "2026-09-26",
        time: "23:00",
        size_tier: "small",
        deposit_cents: 4000,
        held_cents: 4000,
        refund_cutoff_at: "2026-09-25T03:00:00+00:00",
        cutoff_words: "Thu 11:00 PM",
        running_late_until: null,
      },
    });
    const blocks = await owner.query<{ lower: string }>(
      "select to_json(lower(period)) #>> '{}' as lower from room_blocks where ref_id = $1",
      [jae],
    );
    expect(blocks.rows).toEqual([{ lower: "2026-09-27T03:00:00+00:00" }]);
  });

  it("refuses a slot off the grid, a past one, and changes once the booking has started", async () => {
    expect((await change({ time: "23:07" })).json().error.details.reason).toBe("off_grid");
    expect((await change({ business_date: "2026-09-20" })).json().error.details.reason).toBe(
      "past",
    );
    clock.set(Temporal.Instant.from("2026-09-27T03:05:00Z"));
    expect((await change({ party_size: 4 })).json().error.details.reason).toBe("started");
    clock.set(WED);
  });
});
