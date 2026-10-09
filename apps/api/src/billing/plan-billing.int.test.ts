import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { readOnlyApplies } from "../http/plan-gate.js";
import type { RegisteredRoute } from "../http/registry.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe, signPayload } from "../stripe/fake/index.js";
import { PLAN_LOOKUP_KEYS, ROOM_LOOKUP_KEY, PlanPricesMissing } from "../stripe/billing.js";
import { FAKE_WEBHOOK_SECRETS, fakeStripeSettings } from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";
import { PLAN_ROOMS_KIND, makePlanRoomsHandler, subscribeVenue } from "./plan.js";

/**
 * Our plan billing (M8-15) against the fake Stripe's Billing and a test
 * clock: West 4's subscription counts its 14 rooms; a renewal charged to a
 * failing card sends invoice.payment_failed, Admin shows the banner, and 14
 * days later on our clock Admin's writes are refused while the board, rooms,
 * bar and payments keep answering; paying the invoice clears it all.
 * The prices made here are test fixtures with made-up amounts, never ours.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance & { routes: RegisteredRoute[] };
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let ids: Record<string, string>;
let customer: string;
let testClock: string;
let posted = 0;
const clock = new FrozenClock(SEED_NOW);
const people: Record<string, Principal> = {};

const billing = <T>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}) =>
  stripe.call<T>("billing", method, path, {
    account: null,
    params,
    ...(method === "POST" ? { idempotencyKey: `test:${Math.random()}` } : {}),
  });

const call = (
  as: string,
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${url}`,
    headers: { "x-test-as": as },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const postHook = (event: unknown, secret = FAKE_WEBHOOK_SECRETS.platform) => {
  const payload = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: "/v1/hooks/stripe/platform",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signPayload(payload, secret),
    },
    payload,
  });
};

/** Stripe's webhooks as the fake sent them, then the worker, as in production. */
async function deliver(): Promise<string[]> {
  const sent: string[] = [];
  for (const entry of fake.events.slice(posted)) {
    if (entry.endpoint !== "platform") continue;
    expect((await postHook(entry.event)).statusCode).toBe(200);
    sent.push(entry.event.type);
  }
  posted = fake.events.length;
  await runJobs();
  return sent;
}

async function runJobs(): Promise<void> {
  const worker = new Worker(owner, {
    pool: "normal",
    handlers: {
      [STRIPE_EVENT_KIND]: makeStripeEventHandler(owner, stripe),
      [PLAN_ROOMS_KIND]: makePlanRoomsHandler(stripe),
    },
    clock,
  });
  for (let i = 0; i < 5; i++) await worker.tick();
}

const plan = async () =>
  (
    await owner.query<{ room_quantity: number; status: string; payment_failed_at: Date | null }>(
      "select room_quantity, status, payment_failed_at from venue_subscriptions where venue_id = $1",
      [venueId],
    )
  ).rows[0]!;
const fakeRoomQuantity = async () => {
  const sub = await billing<{
    items: { data: { quantity: number; price: { lookup_key: string } }[] };
  }>(
    "GET",
    `/v1/subscriptions/${(await owner.query("select stripe_subscription_id as s from venue_subscriptions where venue_id = $1", [venueId])).rows[0].s}`,
  );
  return sub.items.data.find((i) => i.price.lookup_key === ROOM_LOOKUP_KEY)!.quantity;
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  for (const [who, role] of [
    ["abhishek", "owner"],
    ["andy", "manager"],
  ] as const)
    people[who] = {
      kind: "user",
      userId: ids[who]!,
      session: "passkey",
      memberships: [{ venueId, membershipId: ids[`${who}.membership`]!, role }],
    };
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      STAFF_APP_URL: "http://localhost:5173",
    }),
    clock,
    stripe,
    authenticators: [
      async (request) => {
        const who = request.headers["x-test-as"];
        return typeof who === "string" ? people[who] : undefined;
      },
    ],
    moduleCacheMs: 0,
  }) as FastifyInstance & { routes: RegisteredRoute[] };
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await fake?.stop();
  await owner?.end();
  await db?.drop();
});

describe("our plan on Stripe Billing (M8-15)", () => {
  it("can't start while the plan's prices aren't in Stripe, and says which", async () => {
    await expect(subscribeVenue(owner, stripe, { venueId, plan: "rooms" })).rejects.toBeInstanceOf(
      PlanPricesMissing,
    );
    const status = await call("andy", "GET", "/plan/status");
    expect(status.json()).toMatchObject({ state: "none", read_only_from: null });
    const mine = await call("abhishek", "GET", "/plan");
    expect(mine.json()).toMatchObject({ plan: null, state: "none", rooms_now: 14 });
    // The plan's details are the owner's; the manager reads only the banner's state.
    expect((await call("andy", "GET", "/plan")).statusCode).toBe(403);
  });

  it("West 4's subscription counts 14 rooms, and archiving a room lowers the quantity", async () => {
    for (const key of [PLAN_LOOKUP_KEYS.rooms, ROOM_LOOKUP_KEY])
      await billing("POST", "/v1/prices", { currency: "usd", unit_amount: 100, lookup_key: key });
    testClock = (
      await billing<{ id: string }>("POST", "/v1/test_helpers/test_clocks", {
        frozen_time: Math.floor(SEED_NOW.epochMilliseconds / 1000),
      })
    ).id;
    // The owner's card, as Stripe's hosted page would save it, on a customer on the test clock.
    customer = (
      await billing<{ id: string }>("POST", "/v1/customers", {
        name: "West 4 Boho Karaoke",
        test_clock: testClock,
      })
    ).id;
    await billing("POST", "/v1/payment_methods/pm_card_visa/attach", { customer });
    await billing("POST", `/v1/customers/${customer}`, {
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    await owner.query(
      "update organizations set billing_customer_id = $1 where id = (select org_id from venues where id = $2)",
      [customer, venueId],
    );
    const made = await subscribeVenue(owner, stripe, { venueId, plan: "rooms" });
    expect(made.rooms).toBe(14);
    expect(await plan()).toMatchObject({
      room_quantity: 14,
      status: "active",
      payment_failed_at: null,
    });
    expect(await fakeRoomQuantity()).toBe(14);
    // Every billing call went to our own account, with the billing key and a key on each write.
    const billingCalls = fake.requests.filter((r) => r.service === "billing");
    expect(billingCalls.every((r) => r.account === null)).toBe(true);
    expect(billingCalls.filter((r) => r.method === "POST").every((r) => r.idempotencyKey)).toBe(
      true,
    );
    await deliver();

    // A room switched off tonight still counts; archiving one lowers the quantity.
    const off = await call("abhishek", "PATCH", `/rooms/${ids["room_11"]}/state`, {
      state: "out_of_service",
      reason: "Mic receiver",
    });
    expect(off.statusCode).toBeLessThan(300);
    await runJobs();
    expect((await plan()).room_quantity).toBe(14);
    const archived = await call("abhishek", "PATCH", `/rooms/${ids["room_11"]}`, {
      archived: true,
    });
    expect(archived.statusCode).toBe(200);
    await runJobs();
    expect((await plan()).room_quantity).toBe(13);
    expect(await fakeRoomQuantity()).toBe(13);
    const back = await call("abhishek", "PATCH", `/rooms/${ids["room_11"]}`, { archived: false });
    expect(back.statusCode).toBe(200);
    await runJobs();
    expect((await plan()).room_quantity).toBe(14);
    expect(await fakeRoomQuantity()).toBe(14);
    await deliver();
  });

  it("a failed plan payment shows the banner in Admin, and Admin still saves", async () => {
    // The card starts failing; a month on the test clock renews the plan, and the charge fails.
    await billing("POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer });
    await billing("POST", `/v1/customers/${customer}`, {
      invoice_settings: { default_payment_method: "pm_card_chargeCustomerFail" },
    });
    await billing("POST", `/v1/test_helpers/test_clocks/${testClock}/advance`, {
      frozen_time: Math.floor(SEED_NOW.epochMilliseconds / 1000) + 31 * 24 * 3600,
    });
    const sent = await deliver();
    expect(sent).toEqual(["invoice.payment_failed", "customer.subscription.updated"]);
    const row = await plan();
    expect(row.status).toBe("past_due");
    expect(row.payment_failed_at?.toISOString()).toBe("2026-09-26T02:41:00.000Z");
    const status = await call("andy", "GET", "/plan/status");
    expect(status.json()).toMatchObject({
      state: "payment_failed",
      read_only_from: "2026-10-10T10:00:00Z",
    });
    const mine = (await call("abhishek", "GET", "/plan")).json();
    expect(mine).toMatchObject({
      plan: "rooms",
      status: "past_due",
      room_quantity: 14,
      payment_method: { brand: "visa", last4: "0341" },
      reachable: true,
    });
    expect(mine.pay_url).toMatch(/\/fake\/invoices\/in_/);
    expect(mine.next_invoice.amount_cents).toBe(1500);
    // Repeating the same events changes nothing.
    for (const entry of fake.events.filter((e) => e.endpoint === "platform").slice(-2))
      expect((await postHook(entry.event)).statusCode).toBe(200);
    await runJobs();
    expect((await plan()).payment_failed_at?.toISOString()).toBe("2026-09-26T02:41:00.000Z");
    // Admin still saves until the 14 days are up.
    expect(
      (await call("abhishek", "PATCH", `/rooms/${ids["room_11"]}`, { cleaning_min: 10 }))
        .statusCode,
    ).toBe(200);
  });

  it("14 days later Admin is read-only, while the board, rooms, bar and payments keep working", async () => {
    clock.set(Temporal.Instant.from("2026-10-10T09:59:00Z"));
    expect((await call("andy", "GET", "/plan/status")).json().state).toBe("payment_failed");
    clock.set(Temporal.Instant.from("2026-10-10T10:00:00Z"));
    expect((await call("andy", "GET", "/plan/status")).json().state).toBe("read_only");
    const refused = await call("abhishek", "PATCH", `/rooms/${ids["room_11"]}`, {
      cleaning_min: 12,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("admin_read_only");
    expect(refused.json().error.message).toMatch(
      /Admin is read-only until our plan's invoice is paid/,
    );
    expect((await call("andy", "PUT", "/settings", { values: {} })).json().error.code).toBe(
      "admin_read_only",
    );
    // Reading Admin still works, and so does paying our plan.
    expect((await call("andy", "GET", "/rooms?all=1")).statusCode).toBe(200);
    const portal = await call("abhishek", "POST", "/plan/portal");
    expect(portal.statusCode).toBe(200);
    expect(portal.json().url).toContain(`/fake/billing/${customer}`);
    // The board, rooms, bar and payments never read the plan: none of these is refused for it.
    for (const [method, url] of [
      ["GET", "/board"],
      ["GET", "/tabs"],
      ["GET", "/orders"],
      ["POST", "/tabs"],
      ["POST", `/tabs/${ids["tab_t1"]}/cut-off`],
      ["POST", `/checks/${ids["room_9"]}/payments`],
      ["POST", "/sessions"],
    ] as const) {
      const r = await call("andy", method, url, method === "POST" ? {} : undefined);
      expect(r.statusCode, `${method} ${url}`).not.toBe(500);
      if (r.statusCode >= 400)
        expect(r.json().error.code, `${method} ${url}`).not.toBe("admin_read_only");
    }
    expect((await call("andy", "GET", "/board")).statusCode).toBe(200);
  });

  it("paying the invoice clears the banner and Admin works again", async () => {
    const failed = (
      await owner.query<{ id: string }>(
        "select failed_invoice_id as id from venue_subscriptions where venue_id = $1",
        [venueId],
      )
    ).rows[0]!.id;
    await billing("POST", `/v1/invoices/${failed}/pay`, { payment_method: "pm_card_visa" });
    const sent = await deliver();
    expect(sent).toEqual(["invoice.paid", "customer.subscription.updated"]);
    expect(await plan()).toMatchObject({ status: "active", payment_failed_at: null });
    expect((await call("andy", "GET", "/plan/status")).json()).toMatchObject({
      state: "ok",
      read_only_from: null,
    });
    expect(
      (await call("abhishek", "PATCH", `/rooms/${ids["room_11"]}`, { cleaning_min: 12 }))
        .statusCode,
    ).toBe(200);
    clock.set(SEED_NOW);
  });

  it("a venue that cancels can subscribe again to the same plan with other items, and a lost answer retried makes one subscription", async () => {
    const subId = async () =>
      (
        await owner.query<{ s: string }>(
          "select stripe_subscription_id as s from venue_subscriptions where venue_id = $1",
          [venueId],
        )
      ).rows[0]!.s;
    const creates = () =>
      fake.requests.filter(
        (r) => r.service === "billing" && r.method === "POST" && r.path === "/v1/subscriptions",
      );
    // A live plan can't be started again.
    await expect(subscribeVenue(owner, stripe, { venueId, plan: "rooms" })).rejects.toThrow(
      /already has plan rooms/,
    );
    // One room fewer, so the new subscription's items differ from the first one's.
    expect(
      (await call("abhishek", "PATCH", `/rooms/${ids["room_11"]}`, { archived: true })).statusCode,
    ).toBe(200);
    await runJobs();
    const first = await subId();
    await stripe.call("billing", "DELETE", `/v1/subscriptions/${first}`, {
      account: null,
      params: {},
    });
    await deliver();
    expect((await plan()).status).toBe("canceled");

    // The first try loses Stripe's answer after the subscription was made.
    const before = creates().length;
    fake.dropNext.push({ method: "POST", path: /^\/v1\/subscriptions$/, afterHandling: true });
    await expect(subscribeVenue(owner, stripe, { venueId, plan: "rooms" })).rejects.toThrow();
    // Retrying the same attempt sends the same key, and Stripe answers with that subscription.
    const again = await subscribeVenue(owner, stripe, { venueId, plan: "rooms" });
    expect(again.rooms).toBe(13);
    expect(again.subscriptionId).not.toBe(first);
    expect(await subId()).toBe(again.subscriptionId);
    expect(await plan()).toMatchObject({
      room_quantity: 13,
      status: "active",
      payment_failed_at: null,
    });
    const keys = creates().map((r) => r.idempotencyKey);
    expect(keys.slice(before)).toHaveLength(2);
    expect(keys[before]).toBe(keys[before + 1]);
    expect(keys.slice(0, before)).not.toContain(keys[before]);
    // One live subscription on the customer: the lost answer made no second one.
    expect(
      fake.list(
        "subscription",
        null,
        (s) => s["customer"] === customer && s["status"] !== "canceled",
      ),
    ).toHaveLength(1);
    const attempts = await owner.query<{ n: number; done: number }>(
      `select count(*)::int as n, count(finished_at)::int as done
         from plan_subscribe_attempts where venue_id = $1`,
      [venueId],
    );
    expect(attempts.rows[0]).toEqual({ n: 2, done: 2 });

    expect(
      (await call("abhishek", "PATCH", `/rooms/${ids["room_11"]}`, { archived: false })).statusCode,
    ).toBe(200);
    await runJobs();
    expect(await fakeRoomQuantity()).toBe(14);
    await deliver();
  });
});

describe("our billing endpoint (M8-15)", () => {
  const event = (over: Record<string, unknown>) => ({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type: "customer.subscription.updated",
    livemode: false,
    created: 1,
    data: { object: { id: "sub_unknown", object: "subscription" } },
    ...over,
  });

  it("refuses another endpoint's secret and a live event outside production", async () => {
    expect((await postHook(event({}), FAKE_WEBHOOK_SECRETS.connect)).statusCode).toBe(400);
    expect((await postHook(event({ livemode: true }))).statusCode).toBe(400);
  });

  it("moves only the venue whose subscription the event names; venue B's never touches West 4", async () => {
    const venueB = (
      await owner.query<{ id: string }>(
        `insert into venues (org_id, name, slug)
         values ((select org_id from venues where id = $1), 'Venue B', 'venue-b-plan') returning id`,
        [venueId],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into venue_subscriptions (venue_id, plan, stripe_subscription_id, status)
       values ($1, 'bar', 'sub_venue_b', 'active')`,
      [venueB],
    );
    const before = await plan();
    const onB = event({ data: { object: { id: "sub_venue_b", object: "subscription" } } });
    const unknown = event({
      type: "invoice.payment_failed",
      data: {
        object: { id: "in_x", parent: { subscription_details: { subscription: "sub_nobody" } } },
      },
    });
    expect((await postHook(onB)).statusCode).toBe(200);
    expect((await postHook(unknown)).statusCode).toBe(200);
    const stored = await owner.query<{ event_id: string; venue_id: string | null }>(
      "select event_id, venue_id from webhook_events where event_id = any($1)",
      [[onB.id, unknown.id]],
    );
    expect(Object.fromEntries(stored.rows.map((r) => [r.event_id, r.venue_id]))).toEqual({
      [onB.id]: venueB,
      [unknown.id]: null,
    });
    await runJobs();
    expect(await plan()).toEqual(before);
  });
});

describe("read-only Admin reads no route but Admin's (M8-15)", () => {
  it("applies only to Admin writes; the board, rooms, bar and payments never read the plan", () => {
    const gated = app.routes.filter((r) => readOnlyApplies(r, r.method));
    expect(gated.length).toBeGreaterThan(30);
    for (const r of gated) expect(r.action, `${r.method} ${r.url}`).toMatch(/^admin\./);
    const operational = app.routes.filter(
      (r) => r.action !== undefined && !r.action.startsWith("admin.") && r.method !== "GET",
    );
    expect(operational.length).toBeGreaterThan(50);
    for (const r of operational)
      expect(readOnlyApplies(r, r.method), `${r.method} ${r.url}`).toBe(false);
    // Writes with no action at all (devices, guests, webhooks) never read it either.
    for (const r of app.routes.filter((x) => x.action === undefined))
      expect(readOnlyApplies(r, r.method)).toBe(false);
    // Paying our plan, erasing on request and taking access away stay open.
    const open = app.routes
      .filter((r) => r.openWhenReadOnly && r.method !== "GET")
      .map((r) => `${r.method} ${r.url.replace("/v1/venues/:venueId", "")}`)
      .sort();
    expect(open).toEqual([
      "POST /badges/:b/disable",
      "POST /devices/:d/revoke",
      "POST /guests/:guestId/erase",
      "POST /plan/portal",
      "POST /singers/:s/erase",
      "POST /support-grants/:grantId/decline",
      "POST /support-grants/:grantId/revoke",
      "POST /team/:m/deactivate",
    ]);
  });
});
