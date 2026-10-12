import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import type { RegisteredRoute } from "../http/registry.js";
import { StripeClient } from "../stripe/client.js";
import { FAKE_PROMO_CODE, FakeStripe, signPayload } from "../stripe/fake/index.js";
import { PLAN_LOOKUP_KEYS, ROOM_LOOKUP_KEY } from "../stripe/billing.js";
import { FAKE_WEBHOOK_SECRETS, fakeStripeSettings } from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";
import { PLAN_CHECKOUT_KIND, makePlanCheckoutHandler } from "./checkout.js";
import { PLAN_ROOMS_KIND, makePlanRoomsHandler } from "./plan.js";

/**
 * Set up your venue's step 2, Your plan (O-04), on the fake Stripe: the
 * plans' prices come from Stripe by lookup key (none: Start plan is refused
 * and nothing is made), a promo code is checked against our Promotion Codes,
 * and Start plan makes one Checkout Session per attempt. Finishing it on
 * Stripe's page sends checkout.session.completed, which starts the plan with
 * its room count and sets the allow-list; the reconciler finishes a session
 * whose event never came, and ends one that expired. The prices made here
 * are test fixtures with made-up amounts, never ours.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance & { routes: RegisteredRoute[] };
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let ids: Record<string, string>;
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
  venue = venueId,
) =>
  app.inject({
    method,
    url: `/v1/venues/${venue}${url}`,
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

async function runJobs(at: FrozenClock = clock): Promise<void> {
  const worker = new Worker(owner, {
    pool: "normal",
    handlers: {
      [STRIPE_EVENT_KIND]: makeStripeEventHandler(owner, stripe),
      [PLAN_ROOMS_KIND]: makePlanRoomsHandler(stripe),
      [PLAN_CHECKOUT_KIND]: makePlanCheckoutHandler(stripe),
    },
    clock: at,
  });
  for (let i = 0; i < 6; i++) await worker.tick();
}

/** Stripe's webhooks as the fake sent them (our billing endpoint's), then the worker. */
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

/** Stripe's hosted Checkout page: the fake pays with its test Visa and sends the owner back. */
async function finishCheckout(url: string): Promise<string> {
  const r = await fetch(url, { redirect: "manual" });
  expect(r.status).toBe(302);
  return r.headers.get("location") ?? "";
}

const subscription = async (venue = venueId) =>
  (
    await owner.query<{
      plan: string;
      room_quantity: number;
      status: string;
      stripe_subscription_id: string;
      room_item_id: string | null;
    }>(
      "select plan, room_quantity, status, stripe_subscription_id, room_item_id from venue_subscriptions where venue_id = $1",
      [venue],
    )
  ).rows[0];

const allowed = async (venue: string) =>
  (
    await owner.query<{ module_id: string }>(
      "select module_id from venue_modules where venue_id = $1 and allowed order by module_id",
      [venue],
    )
  ).rows.map((r) => r.module_id);

const checkoutPosts = () =>
  fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/checkout/sessions").length;

/** A venue as the Console's New venue makes it (O-01), with its owner. */
async function newVenue(name: string): Promise<{ venueId: string; who: string }> {
  const n = Math.random().toString(36).slice(2, 8);
  const org = await owner.query<{ id: string }>(
    "insert into organizations (legal_name) values ($1) returning id",
    [`${name} LLC`],
  );
  const v = await owner.query<{ id: string }>(
    `insert into venues (org_id, name, slug, rule_pack_id)
       values ($1, $2, $3, 'us-ny-new-york-county') returning id`,
    [org.rows[0]!.id, name, `plan-${n}`],
  );
  const u = await owner.query<{ id: string }>(
    "insert into users (name, email) values ($1, $2) returning id",
    [`Owner ${n}`, `owner-${n}@example.com`],
  );
  const m = await owner.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, 'owner', 'active', 6) returning id",
    [v.rows[0]!.id, u.rows[0]!.id],
  );
  const who = `owner-${n}`;
  people[who] = {
    kind: "user",
    userId: u.rows[0]!.id,
    session: "passkey",
    memberships: [{ venueId: v.rows[0]!.id, membershipId: m.rows[0]!.id, role: "owner" }],
  };
  return { venueId: v.rows[0]!.id, who };
}

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

describe("Your plan: three plans, a promo code and Stripe Checkout (O-04)", () => {
  it("with a lookup key missing, the plan reads not available and Start plan sends nothing", async () => {
    const prices = await call("abhishek", "GET", "/plan/prices");
    expect(prices.statusCode).toBe(200);
    expect(prices.json()).toMatchObject({ rooms_now: 14, current: null, checkout_open: false });
    expect(
      (prices.json() as { plans: { available: boolean }[] }).plans.every((p) => !p.available),
    ).toBe(true);
    // Only the per-room Price exists: Rooms still isn't available.
    await billing("POST", "/v1/prices", {
      currency: "usd",
      unit_amount: 7,
      lookup_key: ROOM_LOOKUP_KEY,
    });
    const before = fake.requests.filter((r) => r.method === "POST").length;
    const refused = await call("abhishek", "POST", "/plan/checkout", { plan: "rooms" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { details: { reason: "plan_unavailable" } } });
    expect(fake.requests.filter((r) => r.method === "POST").length).toBe(before);
    // The plan is the owner's: a manager can't read it or start it.
    expect((await call("andy", "GET", "/plan/prices")).statusCode).toBe(403);
    expect((await call("andy", "POST", "/plan/checkout", { plan: "bar" })).statusCode).toBe(403);
  });

  it("each plan's price is read from Stripe", async () => {
    for (const [key, amount] of [
      [PLAN_LOOKUP_KEYS.bar, 11],
      [PLAN_LOOKUP_KEYS.rooms, 22],
      [PLAN_LOOKUP_KEYS.rooms_kitchen, 33],
    ] as const)
      await billing("POST", "/v1/prices", {
        currency: "usd",
        unit_amount: amount,
        lookup_key: key,
      });
    const body = (await call("abhishek", "GET", "/plan/prices")).json() as {
      plans: { id: string; available: boolean; base: { amount_cents: number }; room: unknown }[];
    };
    expect(body.plans.map((p) => [p.id, p.available, p.base.amount_cents])).toEqual([
      ["bar", true, 11],
      ["rooms", true, 22],
      ["rooms_kitchen", true, 33],
    ]);
    expect(body.plans[0]!.room).toBeNull();
    expect(body.plans[1]!.room).toMatchObject({ amount_cents: 7, currency: "usd" });
  });

  it("an unknown or expired code isn't valid, and Checkout isn't offered with it", async () => {
    expect((await call("abhishek", "GET", "/plan/promo?code=NOPE")).json()).toMatchObject({
      valid: false,
    });
    const coupon = await billing<{ id: string }>("POST", "/v1/coupons", {
      percent_off: 100,
      duration: "once",
    });
    await billing("POST", "/v1/promotion_codes", {
      code: "OLDCODE",
      promotion: { type: "coupon", coupon: coupon.id },
      expires_at: Math.floor(SEED_NOW.epochMilliseconds / 1000) - 3600,
    });
    await billing("POST", "/v1/promotion_codes", {
      code: "OFFCODE",
      promotion: { type: "coupon", coupon: coupon.id },
      active: false,
    });
    for (const code of ["OLDCODE", "OFFCODE"])
      expect((await call("abhishek", "GET", `/plan/promo?code=${code}`)).json()).toMatchObject({
        valid: false,
      });
    const good = await call("abhishek", "GET", `/plan/promo?code=${FAKE_PROMO_CODE}`);
    expect(good.json()).toMatchObject({
      valid: true,
      percent_off: 100,
      duration: "repeating",
      duration_in_months: 1,
    });
    const before = checkoutPosts();
    const refused = await call("abhishek", "POST", "/plan/checkout", {
      plan: "rooms",
      promo_code: "OLDCODE",
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: { message: "That code isn't valid", details: { reason: "promo_invalid" } },
    });
    expect(checkoutPosts()).toBe(before);
  });

  it("Rooms with the promo code: one session, a $0.00 first invoice, 14 rooms, the Rooms modules", async () => {
    const start = await call("abhishek", "POST", "/plan/checkout", {
      plan: "rooms",
      promo_code: FAKE_PROMO_CODE,
    });
    expect(start.statusCode, start.body).toBe(200);
    const url = (start.json() as { url: string }).url;
    expect(url).toContain("/fake/checkout/");
    // Pressed twice: the same attempt, the same session.
    const again = await call("abhishek", "POST", "/plan/checkout", {
      plan: "rooms",
      promo_code: FAKE_PROMO_CODE,
    });
    expect((again.json() as { url: string }).url).toBe(url);
    expect(fake.list("checkout.session", null).length).toBe(1);
    expect((await call("abhishek", "GET", "/plan/prices")).json()).toMatchObject({
      checkout_open: true,
    });
    // Every billing call on our own account, each write with a key.
    const calls = fake.requests.filter((r) => r.service === "billing");
    expect(calls.every((r) => r.account === null)).toBe(true);
    expect(calls.filter((r) => r.method === "POST").every((r) => r.idempotencyKey)).toBe(true);

    expect(await finishCheckout(url)).toBe("http://localhost:5173/set-up/plan?checkout=done");
    const sent = await deliver();
    expect(sent).toContain("checkout.session.completed");
    const sub = await subscription();
    expect(sub).toMatchObject({ plan: "rooms", room_quantity: 14, status: "active" });
    const stripeSub = await billing<{ latest_invoice: string }>(
      "GET",
      `/v1/subscriptions/${sub!.stripe_subscription_id}`,
    );
    const invoice = await billing<{ amount_due: number; status: string }>(
      "GET",
      `/v1/invoices/${stripeSub.latest_invoice}`,
    );
    expect(invoice).toMatchObject({ amount_due: 0, status: "paid" });
    const mods = await allowed(venueId);
    for (const m of [
      "rooms",
      "online_booking",
      "room_ordering",
      "packages",
      "waitlist",
      "bar_tabs",
    ])
      expect(mods).toContain(m);
    expect(mods).not.toContain("kitchen");
    const setup = (await call("abhishek", "GET", "/setup")).json() as {
      checklist: { steps: { id: string; mark: string }[] };
    };
    expect(setup.checklist.steps.find((s) => s.id === "plan")!.mark).toBe("done");
    // A started plan can't be started twice.
    const twice = await call("abhishek", "POST", "/plan/checkout", { plan: "bar" });
    expect(twice.statusCode).toBe(409);
    // The event again changes nothing.
    const completed = fake.events.find((e) => e.event.type === "checkout.session.completed")!;
    expect((await postHook(completed.event)).statusCode).toBe(200);
    await runJobs();
    expect(await subscription()).toMatchObject({ plan: "rooms", room_quantity: 14 });
  });

  it("the Bar plan allows no room module, and the Rooms step is skipped", async () => {
    const v = await newVenue("Plan Bar");
    const start = await call(v.who, "POST", "/plan/checkout", { plan: "bar" }, v.venueId);
    expect(start.statusCode, start.body).toBe(200);
    await finishCheckout((start.json() as { url: string }).url);
    await deliver();
    expect(await subscription(v.venueId)).toMatchObject({
      plan: "bar",
      room_quantity: 0,
      status: "active",
    });
    const mods = await allowed(v.venueId);
    expect(mods).toEqual(["bar_mode", "bar_screen", "bar_tabs"]);
    const setup = (await call(v.who, "GET", "/setup", undefined, v.venueId)).json() as {
      checklist: { steps: { id: string; mark: string }[] };
    };
    expect(setup.checklist.steps.find((s) => s.id === "rooms")!.mark).toBe("not_used");
    // West 4's plan is untouched by another venue's Checkout.
    expect(await subscription()).toMatchObject({ plan: "rooms", room_quantity: 14 });
  });

  it("the reconciler ends an expired session and finishes one whose event never came; the first room adds the room fee", async () => {
    const v = await newVenue("Plan Reconcile");
    const first = await call(v.who, "POST", "/plan/checkout", { plan: "rooms_kitchen" }, v.venueId);
    const firstUrl = (first.json() as { url: string }).url;
    const firstId = firstUrl.split("/").pop()!;
    await billing("POST", `/v1/checkout/sessions/${firstId}/expire`);
    // Past the session's expiry on our clock, the reconciler looks.
    const later = new FrozenClock(Temporal.Now.instant().add({ hours: 48 }));
    await runJobs(later);
    expect(
      (
        await owner.query(
          "select finished_at is not null as done, stripe_subscription_id from plan_subscribe_attempts where checkout_session_id = $1",
          [firstId],
        )
      ).rows[0],
    ).toEqual({ done: true, stripe_subscription_id: null });
    // Start plan again: a new attempt and a new session.
    const second = await call(
      v.who,
      "POST",
      "/plan/checkout",
      { plan: "rooms_kitchen" },
      v.venueId,
    );
    const secondUrl = (second.json() as { url: string }).url;
    expect(secondUrl).not.toBe(firstUrl);
    await finishCheckout(secondUrl);
    // The completed event is lost; the reconciler reads the session instead.
    posted = fake.events.length;
    expect(await subscription(v.venueId)).toBeUndefined();
    await runJobs(later);
    expect(await subscription(v.venueId)).toMatchObject({
      plan: "rooms_kitchen",
      room_quantity: 0,
      room_item_id: null,
    });
    expect(await allowed(v.venueId)).toContain("kitchen");
    // The venue's first room: the room-count job adds the per-room fee with quantity 1.
    await owner.query(
      "insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max) values ($1, 'Room A', 'small', 1, 8)",
      [v.venueId],
    );
    await owner.query(
      "insert into jobs (venue_id, kind, pool, payload, run_at, max_attempts) values ($1, $2, 'normal', '{}', now() - interval '1 minute', 10)",
      [v.venueId, PLAN_ROOMS_KIND],
    );
    await runJobs(later);
    const sub = await subscription(v.venueId);
    expect(sub).toMatchObject({ room_quantity: 1 });
    expect(sub!.room_item_id).toBeTruthy();
  });

  it("a checkout event with a bad signature is refused, and one naming no attempt reaches no venue", async () => {
    const event = {
      id: "evt_bad_sig",
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: 1,
      data: { object: { id: "cs_nobody", object: "checkout.session" } },
    };
    const bad = await postHook(event, "whsec_wrong");
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      (await owner.query("select 1 from webhook_events where event_id = 'evt_bad_sig'")).rowCount,
    ).toBe(0);
    const unknown = { ...event, id: "evt_nobody" };
    expect((await postHook(unknown)).statusCode).toBe(200);
    expect(
      (await owner.query("select venue_id from webhook_events where event_id = 'evt_nobody'"))
        .rows[0],
    ).toEqual({ venue_id: null });
  });
});
