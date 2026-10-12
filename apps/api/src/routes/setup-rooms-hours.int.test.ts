import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Worker,
  generateSigningKey,
  kitchenStop,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, KITCHEN_DEFAULTS, SEED_NOW, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import type { RegisteredRoute } from "../http/registry.js";
import { PLAN_CHECKOUT_KIND, makePlanCheckoutHandler } from "../billing/checkout.js";
import { PLAN_ROOMS_KIND, makePlanRoomsHandler } from "../billing/plan.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe, signPayload } from "../stripe/fake/index.js";
import { PLAN_LOOKUP_KEYS, ROOM_LOOKUP_KEY } from "../stripe/billing.js";
import { FAKE_WEBHOOK_SECRETS, fakeStripeSettings } from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";

/**
 * Set up your venue's steps 4 and 5 (O-06) through Admin's own routes, on a
 * venue our Console made with the Rooms + Kitchen plan started on the fake
 * Stripe: nothing is filled in before the owner types it; six rooms with
 * their sizes, capacities and the prices show in Admin and make the plan's
 * room quantity 6; a house last call after the rule pack's last sale is
 * refused with the reason; kitchen.opensAt keeps food closed until it, and
 * empty opens the kitchen with the venue. Amounts here are test fixtures.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance & { routes: RegisteredRoute[] };
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let posted = 0;
const clock = new FrozenClock(SEED_NOW);
const people: Record<string, Principal> = {};
const WHO = "owner";

const billing = <T>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}) =>
  stripe.call<T>("billing", method, path, {
    account: null,
    params,
    ...(method === "POST" ? { idempotencyKey: `test:${Math.random()}` } : {}),
  });

const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${url}`,
    headers: { "x-test-as": WHO },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

async function runJobs(): Promise<void> {
  for (const entry of fake.events.slice(posted)) {
    if (entry.endpoint !== "platform") continue;
    const payload = JSON.stringify(entry.event);
    await app.inject({
      method: "POST",
      url: "/v1/hooks/stripe/platform",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signPayload(payload, FAKE_WEBHOOK_SECRETS.platform),
      },
      payload,
    });
  }
  posted = fake.events.length;
  const worker = new Worker(owner, {
    pool: "normal",
    handlers: {
      [STRIPE_EVENT_KIND]: makeStripeEventHandler(owner, stripe),
      [PLAN_ROOMS_KIND]: makePlanRoomsHandler(stripe),
      [PLAN_CHECKOUT_KIND]: makePlanCheckoutHandler(stripe),
    },
    clock,
  });
  for (let i = 0; i < 8; i++) await worker.tick();
}

const steps = async () =>
  Object.fromEntries(
    (
      (await call("GET", "/setup")).json() as {
        checklist: { steps: { id: string; mark: string }[] };
      }
    ).checklist.steps.map((s) => [s.id, s.mark]),
  );

/** The prices a venue's owner typed (made-up test amounts). */
const PRICES = {
  rate: { mode: "perPerson", perPersonCents: 900 },
  billing: { incrementMin: 15, rounding: "up" },
  minGuests: { weeknight: 2, friSat: 3 },
  firstHourMinimum: true,
  bands: [
    {
      name: "Happy hour",
      days: [1, 2, 3, 4],
      fromMin: 17 * 60,
      toMin: 19 * 60,
      rate: { mode: "perPerson", perPersonCents: 600 },
      billing: { incrementMin: 15, rounding: "up" },
    },
  ],
  vip: null,
  minSpend: [],
  booking: { minHours: 1, maxHours: 4, maxGuests: 20, startSlots: [] },
  damageFeeCents: 5000,
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  owner = new pg.Pool({ connectionString: db.url });
  // The New York rule pack, signed and approved, as our bootstrap publishes it.
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
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

  // A venue as the Console's New venue makes it (O-01), with its owner.
  const org = await owner.query<{ id: string }>(
    "insert into organizations (legal_name) values ('Rooms Hours LLC') returning id",
  );
  venueId = (
    await owner.query<{ id: string }>(
      `insert into venues (org_id, name, slug, rule_pack_id)
         values ($1, 'Rooms Hours', 'rooms-hours', 'us-ny-new-york-county') returning id`,
      [org.rows[0]!.id],
    )
  ).rows[0]!.id;
  const u = await owner.query<{ id: string }>(
    "insert into users (name, email) values ('Rae Kim', 'rae@example.com') returning id",
  );
  const m = await owner.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, 'owner', 'active', 6) returning id",
    [venueId, u.rows[0]!.id],
  );
  people[WHO] = {
    kind: "user",
    userId: u.rows[0]!.id,
    session: "passkey",
    memberships: [{ venueId, membershipId: m.rows[0]!.id, role: "owner" }],
  };
  // Step 2 done: Rooms + Kitchen through Checkout on the fake Stripe, with no rooms yet.
  for (const key of [PLAN_LOOKUP_KEYS.rooms_kitchen, ROOM_LOOKUP_KEY])
    await billing("POST", "/v1/prices", { currency: "usd", unit_amount: 100, lookup_key: key });
  const start = await call("POST", "/plan/checkout", { plan: "rooms_kitchen" });
  expect(start.statusCode, start.body).toBe(200);
  expect((await fetch((start.json() as { url: string }).url, { redirect: "manual" })).status).toBe(
    302,
  );
  await runJobs();
});

afterAll(async () => {
  await app?.close();
  await fake?.stop();
  await owner?.end();
  await db?.drop();
});

describe("Steps 4 and 5: rooms and prices, hours, kitchen times, the age policy (O-06)", () => {
  it("fills in no capacity, rate or time for the owner", async () => {
    for (const key of ["prices", "hours", "safety"])
      expect((await call("GET", `/settings/${key}`)).statusCode).toBe(404);
    expect((await call("GET", "/settings/kitchen")).json()).toMatchObject({
      value: { lastOrder: null },
    });
    const kitchen = (await call("GET", "/settings/kitchen")).json() as {
      value: { opensAt?: string | null };
    };
    expect(kitchen.value.opensAt ?? null).toBeNull();
    expect(await steps()).toMatchObject({ rooms: "not_started", hours: "not_started" });
    // Rooms & room clock is allowed by the plan and turned on as Admin → Features does.
    expect((await call("PATCH", "/modules/rooms", { state: "on" })).statusCode).toBe(200);
    // A room without the capacity the owner types is refused: nothing is guessed.
    const noCapacity = await call("POST", "/rooms", { name: "Room 1", size_tier: "small" });
    expect(noCapacity.statusCode).toBe(400);
  });

  it("six rooms with sizes, capacities and rates show in Admin, and the plan's room quantity is 6", async () => {
    const sizes = ["small", "small", "medium", "medium", "large", "vip"];
    for (const [i, size] of sizes.entries()) {
      const r = await call("POST", "/rooms", {
        name: `Room ${i + 1}`,
        size_tier: size,
        capacity_min: 2,
        capacity_max: 6 + i,
        is_vip: size === "vip",
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    const saved = await call("PUT", "/settings/prices", { value: PRICES });
    expect(saved.statusCode, saved.body).toBe(200);
    await runJobs();
    const rooms = (await call("GET", "/rooms")).json() as {
      rooms: { name: string; size_tier: string; capacity_max: number }[];
    };
    expect(rooms.rooms.map((r) => [r.name, r.size_tier, r.capacity_max])).toEqual(
      sizes.map((s, i) => [`Room ${i + 1}`, s, 6 + i]),
    );
    expect((await call("GET", "/settings/prices")).json()).toMatchObject({ value: PRICES });
    const sub = (
      await owner.query<{ room_quantity: number; stripe_subscription_id: string }>(
        "select room_quantity, stripe_subscription_id from venue_subscriptions where venue_id = $1",
        [venueId],
      )
    ).rows[0]!;
    expect(sub.room_quantity).toBe(6);
    const inStripe = await billing<{
      items: { data: { quantity: number; price: { lookup_key: string } }[] };
    }>("GET", `/v1/subscriptions/${sub.stripe_subscription_id}`);
    expect(inStripe.items.data.find((i) => i.price.lookup_key === ROOM_LOOKUP_KEY)?.quantity).toBe(
      6,
    );
    expect((await steps())["rooms"]).toBe("done");
  });

  it("refuses a last call later than the rule pack's close, with the reason", async () => {
    const weekly = [5, 6].map((day) => ({ day, opens: "17:00", closes: "04:00" }));
    const late = await call("PUT", "/settings/hours", { value: { weekly, lastCall: "05:00" } });
    expect(late.statusCode).toBe(400);
    expect((late.json() as { error: { message: string } }).error.message).toContain(
      "can't be later than the rule pack's last sale",
    );
    const ok = await call("PUT", "/settings/hours", { value: { weekly, lastCall: "03:30" } });
    expect(ok.statusCode, ok.body).toBe(200);
    // Hours alone don't finish the step: the age policy is confirmed even at its default.
    expect((await steps())["hours"]).toBe("attention");
    const age = await call("PUT", "/settings/safety", {
      value: { occupancyLimit: null, warnAtPct: 90, allAgesUntil: null },
    });
    expect(age.statusCode, age.body).toBe(200);
    expect((await steps())["hours"]).toBe("done");
  });

  it("kitchen.opensAt keeps food closed until it; empty opens the kitchen with the venue", async () => {
    const stop = () =>
      withVenue(owner, { venueId, requestId: "test" }, (c) =>
        kitchenStop(c, venueId, SEED_NOW.toString()),
      );
    expect(await stop()).toBeNull();
    const at = async (opensAt: string | null) => {
      const r = await call("PUT", "/settings/kitchen", { value: { ...KITCHEN_DEFAULTS, opensAt } });
      expect(r.statusCode, r.body).toBe(200);
    };
    await at("23:00"); // 10:41 PM now: not open yet
    expect(await stop()).toBe("not_open");
    await at("17:00");
    expect(await stop()).toBeNull();
    await at(null);
    expect(await stop()).toBeNull();
    const bad = await call("PUT", "/settings/kitchen", {
      value: { ...KITCHEN_DEFAULTS, opensAt: "5pm" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
