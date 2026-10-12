import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, publishRulePack, saveStripeIntegration, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, builtInRulePacks } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * O-02 acceptance, API side: GET /setup reads every step from the rows; a
 * step saved on one device is done on the next, which opens the next step
 * not done; a skipped required step blocks Finish setup, which lists what's
 * missing; once every required step is done Finish setup stamps the venue
 * and the wizard no longer opens on sign-in. A manager reads the checklist
 * and can't skip or finish.
 */
const ORIGIN = "http://localhost:5173";
const KEY = "c".repeat(64);
const OWNER_EMAIL = "owner-setup@example.com";
const MANAGER_EMAIL = "manager-setup@example.com";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
const clock = new FrozenClock(SEED_NOW);

const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return typeof line === "string" ? line.split(";")[0]! : "";
};
const call = (method: "GET" | "POST" | "PUT", url: string, cookie: string, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });

/** Signing in again, as on another device: the same passkey, a new session. */
async function signInAgain(email: string): Promise<string> {
  const post = (body: unknown) =>
    app.inject({ method: "POST", url: "/v1/auth/login", payload: body as Record<string, unknown> });
  const start = json(await post({ step: "start", method: "passkey", email }));
  const finish = await post({
    step: "finish",
    method: "passkey",
    email,
    credential: keys.get(email)!.assert(start["options"] as { challenge: string }, ORIGIN),
    client: "web",
  });
  expect(finish.statusCode, finish.body).toBe(200);
  return cookieOf(finish);
}

/** A passkey session for a person by email: the emailed code, then the passkey. */
const keys = new Map<string, SoftwarePasskey>();
async function passkeySession(email: string): Promise<string> {
  const key = new SoftwarePasskey("localhost");
  keys.set(email, key);
  const post = (body: unknown) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/enroll",
      payload: body as Record<string, unknown>,
    });
  expect((await post({ step: "start", email })).statusCode).toBe(200);
  const job = await owner.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [email],
  );
  const code = job.rows[0]!.payload.data.code;
  const opts = json(await post({ step: "passkey_options", email, code }));
  const finish = await post({
    step: "passkey_finish",
    email,
    code,
    credential: key.register(opts["options"] as { challenge: string }, ORIGIN),
    name: "Phone",
    client: "web",
  });
  expect(finish.statusCode, finish.body).toBe(201);
  return cookieOf(finish);
}

type Answer = {
  checklist: {
    steps: { id: string; mark: string; required: boolean; missing: string[] }[];
    done: number;
    total: number;
    ready: boolean;
    blocking: string[];
    next: string | null;
  };
  onboarded: boolean;
  completed_at: string | null;
};

let ownerCookie = "";
let managerCookie = "";
const setupUrl = () => `/v1/venues/${v.venueA}/setup`;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  await owner.query("update users set email = $2 where id = $1", [v.ownerA, OWNER_EMAIL]);
  const m = await owner.query<{ id: string }>(
    "insert into users (name, email) values ('Maya', $1) returning id",
    [MANAGER_EMAIL],
  );
  await owner.query(
    "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, 'manager', 'active', 6)",
    [v.venueA, m.rows[0]!.id],
  );
  await publishRulePack(owner, {
    pack: builtInRulePacks[0]!,
    effectiveOn: "2026-09-01",
    approvedBy: ["Abhishek Gaire", "Claude Code"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  // Venue A as if our Console made it (O-01).
  const staff = await owner.query<{ id: string }>(
    "insert into console_staff (name, email) values ('Lee', 'lee@noraymi.test') returning id",
  );
  await owner.query(
    "insert into venue_onboarding (venue_id, created_by, reason) values ($1, $2, 'test venue')",
    [v.venueA, staff.rows[0]!.id],
  );
  await owner.query("update venues set address = null where id = $1", [v.venueA]);
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_ORIGINS: ORIGIN,
    }),
    clock,
    moduleCacheMs: 0,
  });
  await app.ready();
  ownerCookie = await passkeySession(OWNER_EMAIL);
  managerCookie = await passkeySession(MANAGER_EMAIL);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

describe("Set up your venue (O-02)", () => {
  it("reads the checklist from the rows; signing in says the wizard is pending", async () => {
    const r = await call("GET", setupUrl(), ownerCookie);
    expect(r.statusCode, r.body).toBe(200);
    const a = json(r) as unknown as Answer;
    expect(a.onboarded).toBe(true);
    expect(a.completed_at).toBeNull();
    expect(a.checklist.total).toBe(12);
    expect(a.checklist.steps[0]).toMatchObject({ id: "venue", mark: "attention" });
    expect(a.checklist.steps[0]!.missing).toEqual(["address", "guestPhone"]);
    expect(a.checklist.next).toBe("venue");
    const me = json(await call("GET", "/v1/auth/me", ownerCookie)) as {
      memberships: { venue_id: string; setup: string | null }[];
    };
    expect(me.memberships.find((m) => m.venue_id === v.venueA)?.setup).toBe("pending");
  });

  it("a step saved on one device is done on the next, which opens the next step not done", async () => {
    await owner.query(
      `update venues set address = '{"line1":"31-18 Steinway St","city":"Astoria","state":"NY","postal_code":"11103"}' where id = $1`,
      [v.venueA],
    );
    const saved = await call("PUT", `/v1/venues/${v.venueA}/settings/phone`, ownerCookie, {
      value: { callNumber: "+17185550100", textNumber: "+17185550100" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const other = await signInAgain(OWNER_EMAIL);
    const a = json(await call("GET", setupUrl(), other)) as unknown as Answer;
    expect(a.checklist.steps[0]!.mark).toBe("done");
    expect(a.checklist.next).toBe("plan");
    expect(a.checklist.done).toBe(1);
  });

  it("a skipped required step shows as skipped, stays needed, and Finish setup lists what's missing", async () => {
    const skip = await call("POST", `${setupUrl()}/skip`, ownerCookie, { step: "plan" });
    expect(skip.statusCode, skip.body).toBe(200);
    const a = json(skip) as unknown as Answer;
    expect(a.checklist.steps.find((s) => s.id === "plan")).toMatchObject({
      mark: "skipped",
      required: true,
    });
    expect(a.checklist.next).toBe("card");
    expect(a.checklist.blocking).toContain("plan");
    const finish = await call("POST", `${setupUrl()}/finish`, ownerCookie, {});
    expect(finish.statusCode).toBe(409);
    const body = json(finish) as { error: { details: { missing: string[] } } };
    expect(body.error.details.missing).toEqual(a.checklist.blocking);
    const bad = await call("POST", `${setupUrl()}/skip`, ownerCookie, { step: "songs" });
    expect(bad.statusCode).toBe(400);
  });

  it("a manager reads the checklist and can't skip or finish", async () => {
    expect((await call("GET", setupUrl(), managerCookie)).statusCode).toBe(200);
    expect(
      (await call("POST", `${setupUrl()}/skip`, managerCookie, { step: "card" })).statusCode,
    ).toBe(403);
    expect((await call("POST", `${setupUrl()}/finish`, managerCookie, {})).statusCode).toBe(403);
  });

  it("every required step done: Ready to open; Finish setup stamps the venue and ends the redirect", async () => {
    const at = v.venueA;
    await owner.query(
      `insert into venue_subscriptions (venue_id, plan, stripe_subscription_id, status)
         values ($1, 'bar', 'sub_setup_test', 'active')`,
      [at],
    );
    await owner.query("update organizations set stripe_account_id = 'acct_setup' where id = $1", [
      v.orgId,
    ]);
    await saveStripeIntegration(owner, at, {
      accountId: "acct_setup",
      cardPayments: "active",
      needs: [],
      at: SEED_NOW.toString(),
    });
    for (const [key, value] of [
      ["hours", {}],
      ["safety", {}],
    ] as const) {
      await owner.query(
        `insert into venue_settings (venue_id, key, version, value, starts_on, saved_by)
           values ($1, $2, 1, $3, '2026-09-01', null)`,
        [at, key, JSON.stringify(value)],
      );
    }
    const itemCat = await owner.query<{ id: string }>(
      "insert into menu_categories (venue_id, name) values ($1, 'Beer') returning id",
      [at],
    );
    const item = await owner.query<{ id: string }>(
      "insert into menu_items (venue_id, category_id, name) values ($1, $2, 'Bud Light') returning id",
      [at, itemCat.rows[0]!.id],
    );
    await owner.query(
      "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Bottle', 800)",
      [at, item.rows[0]!.id],
    );
    const manager = await owner.query<{ id: string }>(
      "select id from memberships where venue_id = $1 and role = 'manager'",
      [at],
    );
    await owner.query("update memberships set pin_verifier = 'x' where id = $1", [
      manager.rows[0]!.id,
    ]);
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_by)
         values ($1, 'contacts', 1, $2, '2026-09-01', null)`,
      [
        at,
        JSON.stringify({
          bookingEmails: [],
          onCall: {
            first: { membershipId: manager.rows[0]!.id, days: [5, 6], from: "18:00", to: "04:00" },
            second: null,
          },
          breach: { primary: manager.rows[0]!.id, backup: null },
        }),
      ],
    );
    await owner.query(
      "insert into licenses (venue_id, kind, created_at, updated_at) values ($1, 'liquor', now(), now())",
      [at],
    );
    const reader = await owner.query(
      "insert into devices (venue_id, kind, name) values ($1, 'reader', 'Bar S710')",
      [at],
    );
    expect(reader.rowCount).toBe(1);
    const printer = await owner.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, station) values ($1, 'printer', 'Bar printer', 'bar') returning id",
      [at],
    );
    await owner.query(
      "insert into cash_drawers (venue_id, name, station, printer_device_id) values ($1, 'Bar', 'bar', $2)",
      [at, printer.rows[0]!.id],
    );
    await owner.query(
      "insert into setup_checks (venue_id, key, status) values ($1, 'merchant_category', 'passed')",
      [at],
    );
    const ready = json(await call("GET", setupUrl(), ownerCookie)) as unknown as Answer;
    expect(ready.checklist.blocking).toEqual([]);
    expect(ready.checklist.ready).toBe(true);
    // The Bar plan doesn't use rooms or deposits.
    expect(ready.checklist.steps.find((s) => s.id === "rooms")?.mark).toBe("not_used");

    const finish = await call("POST", `${setupUrl()}/finish`, ownerCookie, {});
    expect(finish.statusCode, finish.body).toBe(200);
    expect(Date.parse((json(finish) as unknown as Answer).completed_at!)).toBe(
      SEED_NOW.epochMilliseconds,
    );
    const me = json(await call("GET", "/v1/auth/me", ownerCookie)) as {
      memberships: { venue_id: string; setup: string | null }[];
    };
    expect(me.memberships.find((m) => m.venue_id === at)?.setup).toBeNull();
  });

  it("venue wall: venue B never sees or writes venue A's skips", async () => {
    const rw = appPool(db.url);
    try {
      const seen = await withVenue(rw, { venueId: v.venueB, userId: v.ownerB }, (c) =>
        c.query("select 1 from venue_setup_skips where venue_id = $1", [v.venueA]),
      );
      expect(seen.rowCount).toBe(0);
      await expect(
        withVenue(rw, { venueId: v.venueB, userId: v.ownerB }, (c) =>
          c.query(
            "insert into venue_setup_skips (venue_id, step, skipped_by) values ($1, 'menu', $2)",
            [v.venueA, v.ownerB],
          ),
        ),
      ).rejects.toThrow();
      // Venue B's own setup reads its own rows: nothing skipped there.
      const own = await withVenue(rw, { venueId: v.venueB, userId: v.ownerB }, (c) =>
        c.query("select count(*)::int as n from venue_setup_skips"),
      );
      expect(own.rows[0]!.n).toBe(0);
    } finally {
      await rw.end();
    }
  });
});
