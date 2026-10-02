import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createPayLink,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  withVenue,
  type Queryable,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import "../payments/disputes.js";
import { presentCheck } from "../rooms/present.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { stripeEventHandlers } from "../stripe/webhooks.js";

/**
 * Disputes (M4-24) against the fake Stripe: Room 9's balance paid on Stripe's dispute test card
 * opens an item with its evidence gathered; Submit sends it; closing and the funds moves are kept.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const clock = new FrozenClock(SEED_NOW);

const person = (slug: string, role: string): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: "passkey",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
});
const as = (p: Principal, method: "GET" | "POST", path: string, payload?: object) => {
  who = p;
  return api
    .inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) })
    .finally(() => {
      who = undefined;
    });
};
/** Applies the fake's newest event of a type through its handler, as the stripe.event job does. */
const deliver = async (type: string) => {
  const entry = [...fake.events].reverse().find((e) => e.event.type === type)!;
  const event = entry.event as unknown as Record<string, unknown>;
  await stripeEventHandlers.get(type)!({
    pool: app,
    stripe,
    venueId,
    event: {
      id: String(event["id"]),
      event_id: String(event["id"]),
      type,
      endpoint: "connect",
      account: null,
      payload: event,
      processed_at: null,
    },
    now: clock.now(),
    inVenue: <T>(work: (c: Queryable) => Promise<T>) => withVenue(app, { venueId }, work),
  });
};

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
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  const account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "dispute-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
  await owner.query(
    "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
    [ids["order_o1"]],
  );
  await withVenue(app, { venueId }, (c) =>
    presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
  );
  // Room 9's $498.60 paid online with Stripe's dispute test card (4000 0000 0000 0259).
  const link = await withVenue(app, { venueId }, (c) =>
    createPayLink(c, venueId, {
      checkId: ids["chk_room9"]!,
      amountCents: 49860,
      expiresAt: SEED_NOW.add({ hours: 1 }).toString(),
    }),
  );
  await api.inject({ method: "POST", url: `/v1/public/pay/${link.token}` });
  const paid = await api.inject({
    method: "POST",
    url: `/v1/public/pay/${link.token}/confirm`,
    payload: { test_card: "pm_card_createDispute" },
  });
  expect(paid.json().status).toBe("paid");
  await new Promise((done) => setTimeout(done, 20));
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("the disputes inbox", () => {
  it("opens with its due date and its evidence gathered: the receipt, the clock times and who served", async () => {
    await deliver("charge.dispute.created");
    await deliver("charge.dispute.created"); // a replay opens nothing new
    const inbox = (await as(person("andy", "manager"), "GET", "/disputes")).json();
    expect(inbox.disputes).toHaveLength(1);
    const d = inbox.disputes[0];
    expect(d).toMatchObject({
      amount_cents: 49860,
      reason: "fraudulent",
      status: "needs_response",
    });
    expect(d.due_by).toBeTruthy();
    expect(d.evidence.receipt).toMatchObject({ number: "#1042" });
    expect(d.evidence.clock[0]).toMatch(/^Room 9 · Fri Sep 25, 2026 · 8:00 PM EDT to /);
    expect(d.evidence.policy).toBeNull(); // bookings before M5 carry no accepted policy
    expect(d.evidence.served.length).toBeGreaterThan(0);
  });

  it("Maya and Diego can't open it", async () => {
    expect((await as(person("maya", "bartender"), "GET", "/disputes")).statusCode).toBe(403);
    expect((await as(person("diego", "front_desk"), "GET", "/disputes")).statusCode).toBe(403);
  });

  it("Submit sends the receipt PDF and the rest to Stripe, and the item shows it was submitted", async () => {
    const d = (await as(person("andy", "manager"), "GET", "/disputes")).json().disputes[0];
    expect(
      (
        await as(person("andy", "manager"), "POST", `/disputes/${d.id}/evidence`, {
          note: "Marcus signed for the room and ordered every round himself.",
        })
      ).statusCode,
    ).toBe(200);
    const sent = await as(person("andy", "manager"), "POST", `/disputes/${d.id}/submit`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ status: "under_review" });
    expect(sent.json().evidence_sent).toEqual(
      expect.arrayContaining(["receipt", "uncategorized_text"]),
    );
    const atStripe = [...fake.objects.values()].find((o) => o["id"] === d.stripe_dispute_id)!;
    expect((atStripe["evidence"] as Record<string, string>)["uncategorized_text"]).toContain(
      "Marcus signed for the room",
    );
    const after = (await as(person("andy", "manager"), "GET", "/disputes")).json().disputes[0];
    expect(after.submitted_at).toBeTruthy();
    expect(
      (await as(person("andy", "manager"), "POST", `/disputes/${d.id}/submit`)).statusCode,
    ).toBe(400);
  });

  it("closing marks it won or lost, and funds withdrawn and reinstated are kept with their amounts", async () => {
    const d = (await as(person("andy", "manager"), "GET", "/disputes")).json().disputes[0];
    const atStripe = [...fake.objects.values()].find((o) => o["id"] === d.stripe_dispute_id)!;
    const account = (await owner.query("select stripe_account_id from organizations")).rows[0]
      .stripe_account_id;
    fake.emit("connect", "charge.dispute.funds_withdrawn", atStripe, account);
    await deliver("charge.dispute.funds_withdrawn");
    await deliver("charge.dispute.funds_withdrawn");
    atStripe["status"] = "won";
    fake.emit("connect", "charge.dispute.funds_reinstated", atStripe, account);
    await deliver("charge.dispute.funds_reinstated");
    fake.emit("connect", "charge.dispute.closed", atStripe, account);
    await deliver("charge.dispute.closed");
    const closed = (await as(person("andy", "manager"), "GET", "/disputes")).json().disputes[0];
    expect(closed).toMatchObject({
      outcome: "won",
      status: "won",
      withdrawn_cents: 49860,
      reinstated_cents: 49860,
    });
  });
});
