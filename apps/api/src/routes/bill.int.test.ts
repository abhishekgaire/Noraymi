import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  seedHostToken,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { presentCheck, reopenCheck } from "../rooms/present.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/** "Your bill" (M4-16): Room 9's bill on Kevin's phone, Marcus's booking link, and paying another way. */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let ids: Record<string, string>;
let host = "";
const clock = new FrozenClock(SEED_NOW);
const BOOKING_TOKEN = "marcus-booking-link-token-0001";
const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;
const room = (method: "GET" | "POST", url: string, payload?: object) =>
  api.inject({
    method,
    url: `/v1/public/room-session${url}`,
    headers: { cookie: host },
    ...(payload ? { payload } : {}),
  });
const inVenue = <T>(work: Parameters<typeof withVenue<T>>[2]) => withVenue(app, { venueId }, work);

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
  const account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "bill-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  // Marcus's booking link (M5 issues these when a booking is made).
  await owner.query("update bookings set manage_token_hash = $2 where id = $1", [
    ids["bk_marcus"],
    createHash("sha256").update(BOOKING_TOKEN).digest("hex"),
  ]);
  // The ringing Margarita is cancelled, so Room 9 can be presented.
  await owner.query(
    "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
    [ids["order_o1"]],
  );
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
  });
  await api.ready();
  host = cookieOf(
    (
      await api.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken("sess_room9") },
      })
    ).headers["set-cookie"],
  );
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await app.end();
  await owner.end();
  await db.drop();
});

const ROOM_9_BILL = {
  number: "1042",
  revision: 1,
  status: "finalized",
  room_time_cents: 32200,
  drinks_cents: 15800,
  tax_cents: 4260,
  gratuity_cents: 9600,
  tax_pct: "8.875",
  gratuity_pct: "20",
  total_cents: 61860,
  deposit_cents: 12000,
  amount_due_cents: 49860,
  payments: [],
  card_on_file: { brand: "amex", last4: "1005" },
};

describe("Your bill", () => {
  it("has no bill before Present, and the booking link has none either", async () => {
    expect((await room("GET", "/bill")).json().presented).toBeNull();
    const link = await api.inject({ method: "GET", url: `/v1/public/bookings/${BOOKING_TOKEN}` });
    expect(link.statusCode, link.body).toBe(200);
    expect(link.json()).toMatchObject({ guest_name: "Marcus", party_size: 12, bill: null });
    expect((await room("POST", "/pay-link")).statusCode).toBe(400);
  });

  it("after Present, Room 9's bill reads $322.00, $158.00, $42.60, $96.00, $618.60, −$120.00 and $498.60 due", async () => {
    await inVenue((c) =>
      presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
    );
    const bill = (await room("GET", "/bill")).json().presented;
    expect(bill).toMatchObject(ROOM_9_BILL);
    expect(
      bill.lines.reduce((s: number, l: { amount_cents: number }) => s + l.amount_cents, 0),
    ).toBe(15800);
  });

  it("Marcus's booking link shows the same bill as the room page", async () => {
    const link = (
      await api.inject({ method: "GET", url: `/v1/public/bookings/${BOOKING_TOKEN}` })
    ).json();
    expect(link.bill).toEqual((await room("GET", "/bill")).json().presented);
    const wrong = await api.inject({
      method: "GET",
      url: "/v1/public/bookings/not-a-real-booking-token-000",
    });
    expect(wrong.statusCode).toBe(404);
  });

  it("Pay cash to staff, from the room page or the booking link, is a room call of kind check", async () => {
    expect((await room("POST", "/calls", { kind: "check" })).statusCode).toBe(201);
    const fromLink = await api.inject({
      method: "POST",
      url: `/v1/public/bookings/${BOOKING_TOKEN}/cash`,
    });
    expect(fromLink.statusCode, fromLink.body).toBe(201);
    const calls = await owner.query(
      "select kind from room_calls where session_id = $1 and kind = 'check'",
      [ids["sess_room9"]],
    );
    expect(calls.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("after a reopen and a second Present, the bill shows revision 2", async () => {
    await inVenue((c) => reopenCheck(c, venueId, ids["chk_room9"]!));
    expect((await room("GET", "/bill")).json().presented).toBeNull();
    await inVenue((c) =>
      presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
    );
    expect((await room("GET", "/bill")).json().presented).toMatchObject({
      revision: 2,
      total_cents: 61860,
      amount_due_cents: 49860,
    });
  });

  it("Pay another way opens a link for the amount due; a second tap replaces the first", async () => {
    const first = await room("POST", "/pay-link");
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ amount_cents: 49860 });
    expect(first.json().url).toMatch(/^http:\/\/pay\.localhost:3001\/pay\/[A-Za-z0-9_-]{20,}$/);
    const token1 = first.json().url.split("/pay/")[1];
    expect((await api.inject({ method: "POST", url: `/v1/public/pay/${token1}` })).statusCode).toBe(
      200,
    );
    const second = await api.inject({
      method: "POST",
      url: `/v1/public/bookings/${BOOKING_TOKEN}/pay-link`,
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().amount_cents).toBe(49860);
    expect((await api.inject({ method: "POST", url: `/v1/public/pay/${token1}` })).statusCode).toBe(
      404,
    );
    const token2 = second.json().url.split("/pay/")[1];
    expect((await api.inject({ method: "POST", url: `/v1/public/pay/${token2}` })).statusCode).toBe(
      200,
    );
    const paid = await api.inject({
      method: "POST",
      url: `/v1/public/pay/${token2}/confirm`,
      payload: { test_card: "pm_card_visa" },
    });
    expect(paid.json().status).toBe("paid");
    const bill = (await room("GET", "/bill")).json().presented;
    expect(bill).toMatchObject({
      status: "paid",
      amount_due_cents: 0,
      revision: 2,
      payments: [{ kind: "online", amount_cents: 49860, last4: "4242" }],
    });
    // Room 9 went to cleaning; Kevin's phone still reads the paid bill.
    expect((await room("GET", "/bill")).json().ended).toBe(true);
    // The payment reached Room 9's channel, so the phones refresh the bill.
    const events = await owner.query(
      "select type from venue_events where room_id = $1 and type in ('payment.updated', 'check.updated') order by seq",
      [ids["room_9"]],
    );
    expect(events.rows.map((e) => e.type)).toEqual(
      expect.arrayContaining(["payment.updated", "check.updated"]),
    );
  });
});
