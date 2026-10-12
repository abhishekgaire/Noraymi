import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import type { RegisteredRoute } from "../http/registry.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe, signPayload } from "../stripe/fake/index.js";
import { FAKE_WEBHOOK_SECRETS, fakeStripeSettings } from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";

/**
 * Set up your venue's step 3, Card payments (O-05), on the fake Stripe:
 * Connect with Stripe makes the organization's one account and an Account
 * Link to Stripe's hosted onboarding; account.updated with card payments on
 * marks the step done and makes the Terminal Location and the payment page's
 * domain; before that the step needs attention. A second venue of the
 * organization is connected through it. Only the account's id is kept.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance & { routes: RegisteredRoute[] };
let fake: FakeStripe;
let stripe: StripeClient;
let westId: string;
let posted = 0;
const clock = new FrozenClock(SEED_NOW);
const people: Record<string, Principal> = {};
const PAY = "https://pay.west4.example";

const call = (as: string, method: "GET" | "POST", venue: string, url: string) =>
  app.inject({
    method,
    url: `/v1/venues/${venue}${url}`,
    headers: { "x-test-as": as },
  });

async function deliver(): Promise<string[]> {
  const sent: string[] = [];
  for (const entry of fake.events.slice(posted)) {
    if (entry.endpoint !== "connect") continue;
    const payload = JSON.stringify(entry.event);
    const r = await app.inject({
      method: "POST",
      url: "/v1/hooks/stripe/connect",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signPayload(payload, FAKE_WEBHOOK_SECRETS.connect),
      },
      payload,
    });
    expect(r.statusCode).toBe(200);
    sent.push(entry.event.type);
  }
  posted = fake.events.length;
  const worker = new Worker(owner, {
    pool: "normal",
    handlers: { [STRIPE_EVENT_KIND]: makeStripeEventHandler(owner, stripe, { payAppUrl: PAY }) },
    clock,
  });
  for (let i = 0; i < 4; i++) await worker.tick();
  return sent;
}

/** A venue as the Console's New venue makes it (O-01), with its owner; `org` adds a second venue. */
async function newVenue(
  name: string,
  org?: string,
): Promise<{ venueId: string; who: string; org: string }> {
  const n = Math.random().toString(36).slice(2, 8);
  const orgId =
    org ??
    (
      await owner.query<{ id: string }>(
        "insert into organizations (legal_name) values ($1) returning id",
        [`${name} LLC`],
      )
    ).rows[0]!.id;
  const v = await owner.query<{ id: string }>(
    `insert into venues (org_id, name, slug, rule_pack_id)
       values ($1, $2, $3, 'us-ny-new-york-county') returning id`,
    [orgId, name, `connect-${n}`],
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
  return { venueId: v.rows[0]!.id, who, org: orgId };
}

const cardMark = async (who: string, venue: string) =>
  (
    (await call(who, "GET", venue, "/setup")).json() as {
      checklist: { steps: { id: string; mark: string; missing: string[] }[] };
    }
  ).checklist.steps.find((s) => s.id === "card")!;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  westId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  const ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [westId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  people["andy"] = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId: westId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      STAFF_APP_URL: "http://localhost:5173",
      PAY_APP_URL: PAY,
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

describe("Card payments: Connect with Stripe (O-05)", () => {
  let first: { venueId: string; who: string; org: string };
  let link = "";

  it("makes one account for the organization, however often it's pressed, and keeps only its id", async () => {
    first = await newVenue("Connect One");
    const before = (await call(first.who, "GET", first.venueId, "/payments/stripe/connect")).json();
    expect(before).toMatchObject({ state: "not_connected", connected: false });
    expect((await cardMark(first.who, first.venueId)).mark).toBe("not_started");

    const one = await call(first.who, "POST", first.venueId, "/payments/stripe/connect");
    expect(one.statusCode, one.body).toBe(200);
    link = (one.json() as { url: string }).url;
    expect(link).toContain("/fake/onboarding/");
    expect(link).toContain(encodeURIComponent("http://localhost:5173/set-up/card?stripe=back"));
    const two = await call(first.who, "POST", first.venueId, "/payments/stripe/connect");
    expect(two.statusCode).toBe(200);
    expect(fake.list("v2.core.account", null)).toHaveLength(1);
    const created = fake.requests.filter(
      (r) => r.method === "POST" && r.path === "/v2/core/accounts",
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.idempotencyKey).toBe(`org:${first.org}:create-account`);
    const account = fake.list("v2.core.account", null)[0]!;
    expect(account).toMatchObject({
      display_name: "Connect One",
      identity: { business_details: { registered_name: "Connect One LLC" } },
    });
    const org = (await owner.query("select * from organizations where id = $1", [first.org]))
      .rows[0] as Record<string, unknown>;
    expect(org["stripe_account_id"]).toBe(account["id"]);
    // Nothing secret is kept: no key anywhere on the organization or the integration row.
    expect(JSON.stringify(org)).not.toMatch(/sk_(test|live)|rk_(test|live)/);
    const row = (
      await owner.query("select config from integrations where venue_id = $1 and kind = 'stripe'", [
        first.venueId,
      ])
    ).rows[0] as { config: Record<string, unknown> };
    expect(Object.keys(row.config).sort()).toEqual(["card_payments", "checked_at", "needs"]);
  });

  it("before card payments are on, the step needs attention with Continue with Stripe", async () => {
    const state = (await call(first.who, "GET", first.venueId, "/payments/stripe/connect")).json();
    expect(state).toMatchObject({
      state: "needs_more",
      connected: true,
      card_payments_enabled: false,
    });
    const mark = await cardMark(first.who, first.venueId);
    expect(mark).toMatchObject({ mark: "attention", missing: ["stripeMore"] });
  });

  it("account.updated with card payments on marks the step done, and the payment page's domain follows", async () => {
    const r = await fetch(link, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("http://localhost:5173/set-up/card?stripe=back");
    expect(await deliver()).toContain("account.updated");
    const state = (await call(first.who, "GET", first.venueId, "/payments/stripe/connect")).json();
    expect(state).toMatchObject({
      state: "connected",
      card_payments_enabled: true,
      organization_name: "Connect One LLC",
    });
    expect((await cardMark(first.who, first.venueId)).mark).toBe("done");
    const account = String(fake.list("v2.core.account", null)[0]!["id"]);
    const made = fake.requests.filter((q) => q.method === "POST" && q.account === account);
    expect(made.map((q) => q.path)).toContain("/v1/payment_method_domains");
    // The Location waits for the venue's own tip screen (never chosen for it); the job still finishes.
    expect(made.map((q) => q.path)).not.toContain("/v1/terminal/locations");
    const jobs = await owner.query("select status from jobs where kind = $1", [STRIPE_EVENT_KIND]);
    expect(jobs.rows.every((j: { status: string }) => j.status === "done")).toBe(true);
  });

  it("a second venue of the organization is connected through it, with no second account", async () => {
    const second = await newVenue("Connect Two", first.org);
    expect(
      (await call(second.who, "GET", second.venueId, "/payments/stripe/connect")).json(),
    ).toMatchObject({ connected: true, state: "waiting" });
    const r = await call(second.who, "POST", second.venueId, "/payments/stripe/connect");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      url: null,
      state: "connected",
      organization_name: "Connect One LLC",
    });
    expect(fake.list("v2.core.account", null)).toHaveLength(1);
    expect((await cardMark(second.who, second.venueId)).mark).toBe("done");
  });

  it("is the owner's: a manager can't connect", async () => {
    expect((await call("andy", "POST", westId, "/payments/stripe/connect")).statusCode).toBe(403);
    expect((await call("andy", "GET", westId, "/payments/stripe/connect")).statusCode).toBe(403);
  });
});
