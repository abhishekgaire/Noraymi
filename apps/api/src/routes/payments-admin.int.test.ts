import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { stripeAccountOf, withVenue } from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient } from "../stripe/client.js";
import { createAccountFor } from "../stripe/create-account.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

let db: TestDatabase;
let v: TwoVenues;
let owner: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let who: Principal;
let accountId: string;
let otherVenue: string;
let otherOwner: string;
const clock = new FrozenClock(SEED_NOW);

const user = (
  userId: string,
  venueId: string,
  role: "owner" | "manager",
  session: "passkey" | "pin" = "passkey",
): Principal => ({
  kind: "user",
  userId,
  session,
  memberships: [{ venueId, membershipId: "00000000-0000-4000-8000-000000000001", role }],
});

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url });
  // A second organization with its own venue and owner, for the wall.
  const org = (
    await owner.query<{ id: string }>(
      "insert into organizations (legal_name) values ('Other LLC') returning id",
    )
  ).rows[0]!.id;
  otherVenue = (
    await owner.query<{ id: string }>(
      "insert into venues (org_id, name, slug) values ($1, 'Venue C', 'venue-c') returning id",
      [org],
    )
  ).rows[0]!.id;
  otherOwner = (
    await owner.query<{ id: string }>("insert into users (name) values ('Owner C') returning id")
  ).rows[0]!.id;
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  who = user(v.ownerA, v.venueA, "owner");
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      STAFF_APP_URL: "http://localhost:5173",
    }),
    clock,
    stripe,
    authenticators: [async () => who],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await owner.end();
  await db.drop();
});

describe("West 4's Stripe account", () => {
  it("the ops command makes the account with Stripe collecting fees and covering losses, stores it and audits it", async () => {
    const made = await createAccountFor(owner, stripe, v.orgId, "owner@example.test");
    accountId = made.accountId;
    const stored = fake.objects.get(accountId)!;
    expect(stored).toMatchObject({
      display_name: "Venue A",
      contact_email: "owner@example.test",
      dashboard: "full",
      defaults: {
        currency: "usd",
        responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
      },
      identity: {
        country: "us",
        entity_type: "company",
        business_details: { registered_name: "Test Org LLC" },
      },
    });
    const org = await owner.query("select stripe_account_id from organizations where id = $1", [
      v.orgId,
    ]);
    expect(org.rows[0]).toEqual({ stripe_account_id: accountId });
    const audit = await owner.query(
      "select changed_fields from audit_log where target like 'organizations/%' and request_id = 'ops:stripe:create-account'",
    );
    expect(audit.rows).toEqual([{ changed_fields: ["stripe_account_id"] }]);
    await expect(createAccountFor(owner, stripe, v.orgId, "owner@example.test")).rejects.toThrow(
      /already has Stripe account/,
    );
  });

  it("Admin → Payments shows what Stripe still needs, then card payments enabled after onboarding", async () => {
    const before = await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/payments` });
    expect(before.json()).toMatchObject({
      account_id: accountId,
      card_payments_enabled: false,
      needs: ["Business details and a bank account"],
    });
    const link = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/payments/onboarding`,
    });
    expect(link.statusCode).toBe(200);
    const finished = await fetch(link.json().url, { redirect: "manual" });
    expect(finished.status).toBe(302);
    expect(finished.headers.get("location")).toBe(
      "http://localhost:5173/admin/payments?onboarded=1",
    );
    const after = await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/payments` });
    expect(after.json()).toMatchObject({ card_payments_enabled: true, needs: [] });
    expect(fake.events.at(-1)?.event).toMatchObject({
      type: "account.updated",
      account: accountId,
    });

    await fetch(`${fake.base}/fake/accounts/${accountId}/needs`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "needs[0]=A representative's date of birth",
    });
    const due = await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/payments` });
    expect(due.json()).toMatchObject({
      card_payments_enabled: false,
      needs: ["A representative's date of birth"],
    });
  });

  it("lists payouts as Stripe has them, read with the reporting key", async () => {
    await fetch(`${fake.base}/fake/accounts/${accountId}/payouts`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "amount=123456&arrival_date=1790000000&status=paid",
    });
    const r = await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/payments/payouts` });
    expect(r.json().payouts).toEqual([
      {
        id: expect.stringMatching(/^po_/),
        amount_cents: 123456,
        arrival_date: "2026-09-21",
        status: "paid",
      },
    ]);
    expect(fake.requests.at(-1)).toMatchObject({
      path: "/v1/payouts",
      service: "reporting",
      account: accountId,
    });
  });

  it("is the owner's alone: a manager and a PIN session are refused", async () => {
    who = user(v.ownerA, v.venueA, "manager");
    expect(
      (await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/payments` })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: `/v1/venues/${v.venueA}/payments/onboarding` }))
        .statusCode,
    ).toBe(403);
    who = user(v.ownerA, v.venueA, "owner", "pin");
    expect(
      (await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/payments` })).statusCode,
    ).toBe(403);
    who = user(v.ownerA, v.venueA, "owner");
  });

  it("Connections lists Stripe, Twilio and email with their status", async () => {
    who = user(v.ownerA, v.venueA, "manager");
    const r = await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/connections` });
    expect(r.json().connections).toEqual([
      { kind: "stripe", status: "pending", connected_at: expect.any(String) },
      { kind: "twilio", status: "not_connected", connected_at: null },
      { kind: "email", status: "not_connected", connected_at: null },
    ]);
    who = user(v.ownerA, v.venueA, "owner");
  });

  it("a venue of another organization never reads or sends West 4's account id", async () => {
    expect(
      await withVenue(owner, { venueId: otherVenue }, (c) => stripeAccountOf(c, otherVenue)),
    ).toBeNull();
    who = user(otherOwner, otherVenue, "owner");
    const seen = fake.requests.length;
    const r = await app.inject({ method: "GET", url: `/v1/venues/${otherVenue}/payments` });
    expect(r.json()).toMatchObject({ account_id: null });
    const payouts = await app.inject({
      method: "GET",
      url: `/v1/venues/${otherVenue}/payments/payouts`,
    });
    expect(payouts.json()).toMatchObject({ payouts: [] });
    expect(fake.requests.slice(seen).some((x) => x.account === accountId)).toBe(false);
    who = user(v.ownerA, v.venueA, "owner");
  });
});
