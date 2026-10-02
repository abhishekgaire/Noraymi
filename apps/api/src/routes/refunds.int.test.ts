import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { decide } from "../approvals/service.js";
import { applyRefund, runRefund } from "../payments/refunds.js";
import { presentCheck } from "../rooms/present.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * Refunds (M4-21) against the fake Stripe: Room 9 paid ($120.00 deposit on Marcus's card, the rest in
 * cash), refunds asked by Andy and approved by Abhishek, capped, pending until Stripe says so, failed
 * with Stripe's reason, and a deposit refunded before check-in.
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
  deposit: string;
}
const clock = new FrozenClock(SEED_NOW);

async function back(w: Omit<World, "deposit">, account: string, booking: string, card: string) {
  const dep = (
    await w.owner.query<{ id: string; amount_cents: string }>(
      "select id, amount_cents from payments where booking_id = $1 and method = 'card_online'",
      [w.ids[booking]],
    )
  ).rows[0]!;
  const pi = await w.stripe.call<{ id: string }>("payments", "POST", "/v1/payment_intents", {
    account,
    idempotencyKey: `${dep.id}:create`,
    params: {
      amount: Number(dep.amount_cents),
      currency: "usd",
      payment_method: card,
      payment_method_types: ["card"],
      confirm: true,
    },
  });
  await w.owner.query("update payments set stripe_pi_id = $2 where id = $1", [dep.id, pi.id]);
  return dep.id;
}

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
      idempotencyKey: "refund-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  const api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
  });
  await api.ready();
  const base = { db, owner, app, api, fake, stripe, venueId, ids };
  const deposit = await back(base, account, "bk_marcus", depositCard);
  await back(base, account, "bk_jae", "pm_card_visa");
  await owner.query(
    "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
    [ids["order_o1"]],
  );
  await withVenue(app, { venueId }, (c) =>
    presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
  );
  const w = { ...base, deposit };
  const cash = await as(w, "andy", "POST", `/checks/${ids["chk_room9"]}/payments`, {
    method: "cash",
    amount_cents: 49860,
    tendered_cents: 49860,
  });
  expect(cash.statusCode, cash.body).toBe(201);
  return w;
}

async function drop(w: World) {
  await w.api.close();
  await w.fake.stop();
  await w.app.end();
  await w.owner.end();
  await w.db.drop();
}

/** A signed-in session for a seeded person, and a fresh step-up token for it (as a passkey gives). */
async function as(w: World, who: string, method: "GET" | "POST", path: string, payload?: object) {
  const token = randomBytes(24).toString("base64url");
  const step = randomBytes(24).toString("base64url");
  const session = (
    await w.owner.query<{ id: string }>(
      `insert into auth_sessions (principal, user_id, membership_id, assurance, client, token_hash, started_at, last_seen_at, expires_at)
       values ('staff', $1, $2, 'passkey', 'web', $3, now(), now(), now() + interval '1 hour') returning id`,
      [w.ids[who], w.ids[`${who}.membership`], createHash("sha256").update(token).digest("hex")],
    )
  ).rows[0]!.id;
  await w.owner.query(
    `insert into auth_challenges (user_id, purpose, challenge, session_id, attempts, created_at, expires_at)
     values ($1, 'step_up_token', $2, $3, 0, now(), now() + interval '1 hour')`,
    [w.ids[who], createHash("sha256").update(step).digest("hex"), session],
  );
  return w.api.inject({
    method,
    url: `/v1/venues/${w.venueId}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      "x-step-up": step,
      "idempotency-key": randomUUID(),
    },
    ...(payload ? { payload } : {}),
  });
}
const decideAs = (w: World, who: string, approvalId: string, decision: "approve" | "decline") =>
  withVenue(w.app, { venueId: w.venueId }, (c) =>
    decide(c, w.venueId, approvalId, {
      decision,
      userId: w.ids[who]!,
      deviceId: randomUUID(),
      at: clock.now(),
    }),
  );
const deps = (w: World) => ({ pool: w.app, stripe: w.stripe, clock });
const due = async (w: World) =>
  Number(
    (
      await withVenue(w.app, { venueId: w.venueId }, (c) =>
        c.query<{ d: string }>("select amount_due($1) as d", [w.ids["chk_room9"]]),
      )
    ).rows[0]!.d,
  );
/** What the check's payments hold beyond its lines: money owed back to the guest. */
const owed = async (w: World) =>
  Number(
    (
      await w.owner.query<{ o: string }>(
        `select (select coalesce(sum(amount_cents), 0) from payment_allocations
                  where check_id = $1 and state = 'captured')
              - (select coalesce(sum(amount_cents), 0) from check_lines where check_id = $1) as o`,
        [w.ids["chk_room9"]],
      )
    ).rows[0]!.o,
  );
const stripeIdOf = async (w: World, refundId: string) =>
  (await w.owner.query("select stripe_refund_id from refunds where id = $1", [refundId])).rows[0]
    .stripe_refund_id as string;

describe("a refund off Marcus's deposit", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("pm_card_amex");
  });
  afterAll(() => drop(w));
  const ask = (who: string, cents: number) =>
    as(w, who, "POST", `/checks/${w.ids["chk_room9"]}/refunds`, {
      parts: [{ payment_id: w.deposit, amount_cents: cents }],
      reason: "Room 9's mic was out for an hour",
    });

  it("$120.01 answers 422 over_refundable, and Diego and Maya can't ask", async () => {
    const over = await ask("andy", 12001);
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toMatchObject({
      code: "over_refundable",
      details: { max_refundable_cents: 12000 },
    });
    expect((await ask("diego", 1000)).statusCode).toBe(403);
    expect((await ask("maya", 1000)).statusCode).toBe(403);
    // Nor do they get the refund sheet (M4-22); Andy's starts empty, capped at $120.00 on the deposit.
    for (const who of ["diego", "maya"])
      expect(
        (await as(w, who, "GET", `/refundable?booking=${w.ids["bk_marcus"]}`)).statusCode,
      ).toBe(403);
    const sheet = (await as(w, "andy", "GET", `/refundable?booking=${w.ids["bk_marcus"]}`)).json();
    expect(sheet.target).toMatchObject({ kind: "check", label: "#1042" });
    expect(sheet.payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payment_id: w.deposit,
          label: "Amex ··1005",
          max_refundable_cents: 12000,
        }),
      ]),
    );
    expect((await as(w, "andy", "GET", "/approvals/approver")).json().name).toMatch(/^Abhishek/);
  });

  it("Andy's $50.00 waits for Abhishek, runs only after he approves, and is pending until Stripe says so", async () => {
    const r = await ask("andy", 5000);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: expect.stringMatching(/^Abhishek/) },
    });
    const refundId = r.json().refund_ids[0] as string;
    expect((await as(w, "andy", "GET", `/refunds/${refundId}`)).json()).toMatchObject({
      state: "waiting_approval",
      waiting_for: expect.stringMatching(/^Abhishek/),
    });
    await expect(decideAs(w, "andy", r.json().approval_id, "approve")).rejects.toThrow();
    await decideAs(w, "abhishek", r.json().approval_id, "approve");
    await runRefund(deps(w), w.venueId, refundId);
    // Stripe's refund.updated is held back: still "Refund pending". The reversing line is written, so
    // the deposit now covers $50.00 less of the check: that $50.00 is what's owed back meanwhile.
    expect((await as(w, "andy", "GET", `/refunds/${refundId}`)).json()).toMatchObject({
      state: "pending",
    });
    expect(await due(w)).toBe(0);
    expect(await owed(w)).toBe(5000);
    // Then it lands: Refunded, the amount due is $0.00, and Marcus's payment is partly refunded.
    const stripeId = await stripeIdOf(w, refundId);
    await applyRefund(deps(w), w.venueId, stripeId, null);
    await applyRefund(deps(w), w.venueId, stripeId, null);
    expect((await as(w, "andy", "GET", `/refunds/${refundId}`)).json()).toMatchObject({
      state: "succeeded",
    });
    expect(await due(w)).toBe(0);
    const p = (await w.owner.query("select status from payments where id = $1", [w.deposit]))
      .rows[0];
    expect(p.status).toBe("partly_refunded");
    const allocations = await w.owner.query(
      "select amount_cents::int from payment_allocations where refund_id = $1",
      [refundId],
    );
    expect(allocations.rows).toEqual([{ amount_cents: -5000 }]);
    // One Stripe refund, keyed <payment_id>:refund:1.
    expect(
      w.fake.requests.filter((x) => x.path === "/v1/refunds").map((x) => x.idempotencyKey),
    ).toEqual([`${w.deposit}:refund:1`]);
  });

  it("after the $50.00, at most $70.00 more can come off", async () => {
    const over = await ask("andy", 7001);
    expect(over.json().error).toMatchObject({
      code: "over_refundable",
      details: { max_refundable_cents: 7000 },
    });
    const r = await ask("andy", 7000);
    expect(r.statusCode).toBe(202);

    // Chaos: Stripe makes the refund, and our process never hears the answer.
    const refundId = r.json().refund_ids[0] as string;
    await decideAs(w, "abhishek", r.json().approval_id, "approve");
    w.fake.dropNext.push({ method: "POST", path: /^\/v1\/refunds$/, afterHandling: true });
    await expect(runRefund(deps(w), w.venueId, refundId)).rejects.toThrow();
    expect(await stripeIdOf(w, refundId)).toBeNull();
    // Stripe's refund.updated still finds it, by the refund id in its metadata.
    await new Promise((done) => setTimeout(done, 20));
    const made = [...w.fake.objects.values()].filter(
      (o) =>
        o["object"] === "refund" &&
        (o["metadata"] as Record<string, string>)?.["refund_id"] === refundId,
    );
    expect(made).toHaveLength(1);
    await applyRefund(deps(w), w.venueId, made[0]!["id"] as string, refundId);
    // The job runs again with the same key and makes nothing new.
    await runRefund(deps(w), w.venueId, refundId);
    expect([...w.fake.objects.values()].filter((o) => o["object"] === "refund").length).toBe(2);
    expect(
      (await w.owner.query("select status from payments where id = $1", [w.deposit])).rows[0]
        .status,
    ).toBe("refunded");
    expect(await due(w)).toBe(0);
  });

  it("a deposit before check-in is refunded the same way, and the guest gets the Deposit refund text", async () => {
    const jae = (
      await w.owner.query<{ id: string }>(
        "select id from payments where booking_id = $1 and method = 'card_online'",
        [w.ids["bk_jae"]],
      )
    ).rows[0]!.id;
    const r = await as(w, "andy", "POST", `/bookings/${w.ids["bk_jae"]}/refunds`, {
      parts: [{ payment_id: jae, amount_cents: 5000 }],
      reason: "Cancelled by phone before the cut-off",
    });
    expect(r.statusCode, r.body).toBe(202);
    const refundId = r.json().refund_ids[0] as string;
    await decideAs(w, "abhishek", r.json().approval_id, "approve");
    await runRefund(deps(w), w.venueId, refundId);
    await applyRefund(deps(w), w.venueId, await stripeIdOf(w, refundId), null);
    expect(
      (await w.owner.query("select status from payments where id = $1", [jae])).rows[0].status,
    ).toBe("refunded");
    const text = await w.owner.query(
      `select m.body from messages m join message_templates t on t.id = m.template_id where t.key = 'deposit_refund'`,
    );
    expect(text.rows[0]?.body).toMatch(/^Your \$50\.00 deposit for /);
  });
});

describe("a refund Stripe fails", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("pm_card_refundFail");
  });
  afterAll(() => drop(w));

  it("goes back to Andy with Stripe's reason, the money stays owed to Marcus, and a late refund.updated changes nothing", async () => {
    const r = await as(w, "andy", "POST", `/checks/${w.ids["chk_room9"]}/refunds`, {
      parts: [{ payment_id: w.deposit, amount_cents: 12000 }],
      reason: "Overcharged",
    });
    const refundId = r.json().refund_ids[0] as string;
    await decideAs(w, "abhishek", r.json().approval_id, "approve");
    await runRefund(deps(w), w.venueId, refundId);
    await new Promise((done) => setTimeout(done, 20));
    const stripeId = await stripeIdOf(w, refundId);
    // refund.failed, then refund.updated: both read Stripe now, so the order doesn't matter.
    await applyRefund(deps(w), w.venueId, stripeId, null);
    await applyRefund(deps(w), w.venueId, stripeId, null);
    expect((await as(w, "andy", "GET", `/refunds/${refundId}`)).json()).toMatchObject({
      state: "failed",
      failure_reason: "expired_or_canceled_card",
    });
    expect(await due(w)).toBe(0);
    expect(await owed(w)).toBe(12000);
    expect(
      (await w.owner.query("select status from payments where id = $1", [w.deposit])).rows[0]
        .status,
    ).toBe("captured");
  });
});
