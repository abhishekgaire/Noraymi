import { randomUUID } from "node:crypto";
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
import { decide } from "../approvals/service.js";
import { chargeNow } from "../payments/card-on-file.js";
import type { Principal } from "../http/principal.js";
import { presentCheck } from "../rooms/present.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * Card on file (M4-17) against the fake Stripe, each case on a fresh load of the seed: Room 9's
 * $498.60 on Marcus's Amex ··1005 after he confirms, after a manager approves, and declined.
 */
interface World {
  db: TestDatabase;
  owner: pg.Pool;
  app: pg.Pool;
  api: FastifyInstance;
  fake: FakeStripe;
  stripe: StripeClient;
  venueId: string;
  ids: Record<string, string>;
  host: string;
  as: { who: Principal | undefined };
}
const clock = new FrozenClock(SEED_NOW);

async function world(depositCard: string): Promise<World> {
  const db = await createTestDatabase({ migrate: true });
  const venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } }))
    .venueId;
  const owner = new pg.Pool({ connectionString: db.url });
  const app = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  const ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  const fake = new FakeStripe();
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  const account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "cof-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  // Marcus's deposit, backed by a PaymentIntent that saved his card on a Customer (as stripe:seed does).
  const deposit = (
    await owner.query<{ id: string; amount_cents: string }>(
      "select id, amount_cents from payments where booking_id = $1 and method = 'card_online'",
      [ids["bk_marcus"]],
    )
  ).rows[0]!;
  const customer = await stripe.call<{ id: string }>("payments", "POST", "/v1/customers", {
    account,
    idempotencyKey: `${deposit.id}:customer`,
    params: { name: "Marcus T." },
  });
  const pi = await stripe.call<{ id: string }>("payments", "POST", "/v1/payment_intents", {
    account,
    idempotencyKey: `${deposit.id}:create`,
    params: {
      amount: Number(deposit.amount_cents),
      currency: "usd",
      customer: customer.id,
      payment_method: depositCard,
      payment_method_types: ["card"],
      confirm: true,
      setup_future_usage: "off_session",
    },
  });
  await owner.query("update payments set stripe_pi_id = $2 where id = $1", [deposit.id, pi.id]);
  await owner.query(
    "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
    [ids["order_o1"]],
  );
  const as: World["as"] = { who: undefined };
  const api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => as.who],
  });
  await api.ready();
  const set = (
    await api.inject({
      method: "POST",
      url: "/v1/public/room-session/host",
      payload: { token: seedHostToken("sess_room9") },
    })
  ).headers["set-cookie"];
  const host = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  await withVenue(app, { venueId }, (c) =>
    presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
  );
  return { db, owner, app, api, fake, stripe, venueId, ids, host, as };
}

async function drop(w: World) {
  await w.api.close();
  await w.fake.stop();
  await w.app.end();
  await w.owner.end();
  await w.db.drop();
}

const person = (w: World, slug: string, role: string): Principal => ({
  kind: "user",
  userId: w.ids[slug]!,
  session: "passkey",
  memberships: [{ venueId: w.venueId, membershipId: w.ids[`${slug}.membership`]!, role } as never],
});
const staff = (
  w: World,
  who: Principal,
  method: "GET" | "POST",
  path: string,
  payload?: object,
) => {
  w.as.who = who;
  return w.api
    .inject({
      method,
      url: `/v1/venues/${w.venueId}${path}`,
      headers: { "idempotency-key": randomUUID() },
      ...(payload ? { payload } : {}),
    })
    .finally(() => {
      w.as.who = undefined;
    });
};
const guest = (w: World, method: "GET" | "POST", path: string) =>
  w.api.inject({ method, url: `/v1/public/room-session${path}`, headers: { cookie: w.host } });
const due = async (w: World) =>
  Number(
    (
      await withVenue(w.app, { venueId: w.venueId }, (c) =>
        c.query<{ d: string }>("select amount_due($1) as d", [w.ids["chk_room9"]]),
      )
    ).rows[0]!.d,
  );

describe("the guest confirms", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("pm_card_amex");
  });
  afterAll(() => drop(w));

  it("Andy picks Card on file: waiting for Marcus, and nobody can take the same money meanwhile", async () => {
    const andy = person(w, "andy", "manager");
    const r = await staff(w, andy, "POST", `/checks/${w.ids["chk_room9"]}/payments`, {
      method: "card_on_file",
      amount_cents: 49860,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      method: "card_on_file",
      state: "waiting_guest",
      on_file: { brand: "amex", last4: "1005", guest_name: "Marcus" },
    });
    const cash = await staff(w, andy, "POST", `/checks/${w.ids["chk_room9"]}/payments`, {
      method: "cash",
      amount_cents: 100,
      tendered_cents: 100,
    });
    expect(cash.statusCode).toBe(422);
    const again = await staff(w, andy, "POST", `/checks/${w.ids["chk_room9"]}/payments`, {
      method: "card_on_file",
      amount_cents: 100,
    });
    expect(again.statusCode).toBe(422);
  });

  it("Marcus taps Pay with Amex ··1005 on the bill: $498.60 off-session, and #1042 is paid", async () => {
    const bill = (await guest(w, "GET", "/bill")).json().presented;
    expect(bill.on_file_request).toMatchObject({ amount_cents: 49860 });
    expect(bill.card_on_file).toEqual({ brand: "amex", last4: "1005" });
    const ok = await guest(w, "POST", `/payments/${bill.on_file_request.payment_id}/confirm`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      status: "paid",
      bill: { status: "paid", amount_due_cents: 0 },
    });
    const p = (
      await w.owner.query(
        "select status, stripe_pi_id, mit_reason, card_last4 from payments where id = $1",
        [bill.on_file_request.payment_id],
      )
    ).rows[0];
    expect(p).toMatchObject({ status: "captured", mit_reason: null, card_last4: "0005" });
    const pi = await w.stripe.call<{ customer: string; metadata: Record<string, string> }>(
      "payments",
      "GET",
      `/v1/payment_intents/${p.stripe_pi_id}`,
      {
        account: (await w.owner.query("select stripe_account_id from organizations")).rows[0]
          .stripe_account_id,
      },
    );
    expect(pi.metadata["payment_id"]).toBe(bill.on_file_request.payment_id);
    expect(
      (
        await w.owner.query("select idem_key from payment_attempts where payment_id = $1", [
          bill.on_file_request.payment_id,
        ])
      ).rows[0].idem_key,
    ).toBe(`${bill.on_file_request.payment_id}:off_session:1`);
  });
});

describe("a manager approves", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("pm_card_amex");
  });
  afterAll(() => drop(w));

  const ask = async (who: Principal, reason: string) => {
    const made = await staff(w, who, "POST", `/checks/${w.ids["chk_room9"]}/payments`, {
      method: "card_on_file",
      amount_cents: 49860,
    });
    expect(made.statusCode, made.body).toBe(201);
    const asked = await staff(w, who, "POST", `/payments/${made.json().id}/approval`, { reason });
    expect(asked.statusCode, asked.body).toBe(202);
    return { paymentId: made.json().id as string, answer: asked.json() };
  };
  const decideAs = (slug: string, approvalId: string, decision: "approve" | "decline") =>
    withVenue(w.app, { venueId: w.venueId }, (c) =>
      decide(c, w.venueId, approvalId, {
        decision,
        userId: w.ids[slug]!,
        deviceId: randomUUID(),
        at: clock.now(),
      }),
    );

  it("Andy's own request goes to Abhishek; Andy can't approve it; declined, nothing is charged", async () => {
    // Sent with a reason, the request itself waits for a manager (202).
    const made = await staff(
      w,
      person(w, "andy", "manager"),
      "POST",
      `/checks/${w.ids["chk_room9"]}/payments`,
      {
        method: "card_on_file",
        amount_cents: 49860,
        reason: "Guest left",
      },
    );
    expect(made.statusCode, made.body).toBe(202);
    const answer = made.json();
    const paymentId = answer.payment_id as string;
    expect(answer).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: expect.stringMatching(/^Abhishek/) },
    });
    await expect(decideAs("andy", answer.approval_id, "approve")).rejects.toThrow(
      /own request|waiting for/,
    );
    await decideAs("abhishek", answer.approval_id, "decline");
    const p = (
      await w.owner.query("select status, stripe_pi_id from payments where id = $1", [paymentId])
    ).rows[0];
    expect(p).toEqual({ status: "canceled", stripe_pi_id: null });
    expect(await due(w)).toBe(49860);
  });

  it("Diego's request waits for Andy, runs only on his approval, and mit_reason holds Diego's reason", async () => {
    const diego = person(w, "diego", "front_desk");
    const { paymentId, answer } = await ask(
      diego,
      "Marcus left before paying; he OK'd the card at check-in",
    );
    expect(answer.waiting_for.name).toMatch(/^Andy/);
    const view = (await staff(w, diego, "GET", `/payments/${paymentId}`)).json();
    expect(view).toMatchObject({
      state: "waiting_guest",
      approval: { status: "pending", waiting_for: expect.stringMatching(/^Andy/) },
    });
    await expect(decideAs("diego", answer.approval_id, "approve")).rejects.toThrow();
    expect(
      (await w.owner.query("select stripe_pi_id from payments where id = $1", [paymentId])).rows[0]
        .stripe_pi_id,
    ).toBeNull();
    await decideAs("andy", answer.approval_id, "approve");
    const attempt = (
      await w.owner.query("select attempt_no from payment_attempts where payment_id = $1", [
        paymentId,
      ])
    ).rows[0];
    await chargeNow(
      {
        pool: w.app,
        stripe: w.stripe,
        clock,
        payAppUrl: "http://pay.localhost:3001",
        texts: { allowList: null },
      },
      w.venueId,
      paymentId,
      attempt.attempt_no,
    );
    const p = (
      await w.owner.query("select status, mit_reason from payments where id = $1", [paymentId])
    ).rows[0];
    expect(p).toEqual({
      status: "captured",
      mit_reason: "Marcus left before paying; he OK'd the card at check-in",
    });
    expect(await due(w)).toBe(0);
  });
});

describe("the saved card declines", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("pm_card_chargeCustomerFail");
  });
  afterAll(() => drop(w));

  it("shows Declined, frees the amount, and texts Marcus a pay link that pays the same balance", async () => {
    const andy = person(w, "andy", "manager");
    const made = await staff(w, andy, "POST", `/checks/${w.ids["chk_room9"]}/payments`, {
      method: "card_on_file",
      amount_cents: 49860,
    });
    const paymentId = made.json().id as string;
    const ok = await guest(w, "POST", `/payments/${paymentId}/confirm`);
    expect(ok.json()).toMatchObject({ status: "declined" });
    const view = (await staff(w, andy, "GET", `/payments/${paymentId}`)).json();
    expect(view).toMatchObject({ state: "declined", status: "canceled" });
    expect(await due(w)).toBe(49860);
    const text = (
      await w.owner.query<{ body: string }>(
        `select m.body from messages m join message_templates t on t.id = m.template_id
          where t.key = 'payment_link' order by m.created_at desc limit 1`,
      )
    ).rows[0];
    expect(text?.body).toContain("$498.60");
    const token = /\/pay\/([A-Za-z0-9_-]+)/.exec(text!.body)![1]!;
    expect(
      (await w.api.inject({ method: "POST", url: `/v1/public/pay/${token}` })).json(),
    ).toMatchObject({
      amount_cents: 49860,
      status: "open",
    });
    const paid = await w.api.inject({
      method: "POST",
      url: `/v1/public/pay/${token}/confirm`,
      payload: { test_card: "pm_card_visa" },
    });
    expect(paid.json().status).toBe("paid");
    expect(await due(w)).toBe(0);
  });
});
