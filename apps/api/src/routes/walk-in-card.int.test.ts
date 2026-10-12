import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * What a walk-in check-in takes (D112; Admin → Deposits & cancelling): West 4 keeps the deposit
 * (the setting's default, so the seed is unchanged); an owner or manager can switch it to "Put a
 * card on the tab" or "Nothing", and nobody else can. With a card on the tab, the walk-in is seated
 * first, then the guest taps a card on the simulated reader: it's saved on the room's check
 * (process_setup_intent, nothing charged), and the room's bill is what it was.
 */
let db: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let app: FastifyInstance;
let worker: Worker;
let fake: FakeStripe;
let account = "";
let fakeBase = "";
let venueId = "";
let ids: Record<string, string> = {};
let readerId = "";
const clock = new FrozenClock(SEED_NOW);
let n = 0;
let who: Principal;
let abhishek: Principal;
let diego: Principal;
let maya: Principal;

async function stripeReader() {
  const r = await owner.query<{ s: string }>(
    "select stripe_reader_id as s from devices where id = $1",
    [readerId],
  );
  return r.rows[0]!.s;
}
async function presentCard(number: string) {
  const res = await fetch(
    `${fakeBase}/v1/test_helpers/terminal/readers/${await stripeReader()}/present_payment_method`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "stripe-account": account,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `present-${++n}`,
      },
      body: `card_present[number]=${number}`,
    },
  );
  expect(res.status).toBe(200);
}

const person = (slug: string, role: string): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: role === "owner" || role === "manager" ? "passkey" : "pin",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  workerPool = appPool(db.url);
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
  fakeBase = await fake.start();
  const stripe = new StripeClient(fakeStripeSettings(fakeBase), fetch, 15_000);
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  abhishek = person("abhishek", "owner");
  diego = person("diego", "front_desk");
  maya = person("maya", "bartender");
  who = abhishek;
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await app.ready();
  const reg = await app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/readers`,
    payload: { registration_code: "simulated-s710", label: "Front desk S710" },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  readerId = reg.json().reader?.id ?? reg.json().id;
  worker = new Worker(workerPool, {
    pool: "critical",
    handlers: makePaymentHandlers({ pool: workerPool, stripe, clock }),
    clock,
  });
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await workerPool.end();
  await owner.end();
  await db.drop();
});

const as = (
  p: Principal,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: unknown,
  key?: string,
) => {
  who = p;
  return app.inject({
    method,
    url: `/v1/venues/${venueId}${url}`,
    headers: key ? { "idempotency-key": key } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
};
const preview = async (room: string) =>
  (await as(diego, "GET", `/check-in/preview?room=${ids[room]}&party=4`)).json<{
    walk_in: string | null;
    deposit_cents: number;
  }>();
const deposit = async () =>
  (await as(abhishek, "GET", "/settings/deposit")).json<{ value: Record<string, unknown> }>().value;

describe("what a walk-in check-in takes (D112)", () => {
  it("is the deposit at West 4 until someone changes it, and a booking keeps its own", async () => {
    expect((await deposit())["walkIn"]).toBeUndefined();
    expect(await preview("room_11")).toMatchObject({ walk_in: "deposit", deposit_cents: 0 });
    const booked = await as(diego, "GET", `/check-in/preview?booking=${ids["bk_sam"]!}`);
    expect(booked.statusCode, booked.body).toBe(200);
    expect(booked.json().walk_in).toBeNull();
  });

  it("only an owner or a manager changes it, and only to the four choices", async () => {
    const value = await deposit();
    expect(
      (await as(diego, "PUT", "/settings/deposit", { value: { ...value, walkIn: "nothing" } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await as(maya, "PUT", "/settings/deposit", { value: { ...value, walkIn: "nothing" } }))
        .statusCode,
    ).toBe(403);
    const bad = await as(abhishek, "PUT", "/settings/deposit", {
      value: { ...value, walkIn: "hold" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await as(abhishek, "PUT", "/settings/deposit", {
      value: { ...value, walkIn: "nothing" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await preview("room_11")).walk_in).toBe("nothing");
  });

  it("each of the four choices saves and reads back the same in Admin (O-07)", async () => {
    const value = await deposit();
    for (const walkIn of ["deposit", "cardOnTab", "cardBehindBar", "nothing"]) {
      const put = await as(abhishek, "PUT", "/settings/deposit", { value: { ...value, walkIn } });
      expect(put.statusCode, put.body).toBe(200);
      expect((await deposit())["walkIn"]).toBe(walkIn);
      expect((await preview("room_11")).walk_in).toBe(walkIn);
    }
    // Deposits off with a card on the tab saves, as Sing Sing's first answer read.
    const off = await as(abhishek, "PUT", "/settings/deposit", {
      value: { ...value, on: false, walkIn: "cardOnTab" },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await deposit()).toMatchObject({ on: false, walkIn: "cardOnTab" });
    const back = await as(abhishek, "PUT", "/settings/deposit", { value });
    expect(back.statusCode, back.body).toBe(200);
  });

  it("with a card on the tab: seated first, then the card saved on the room's check, nothing charged", async () => {
    const value = await deposit();
    const set = await as(abhishek, "PUT", "/settings/deposit", {
      value: { ...value, walkIn: "cardOnTab" },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((await preview("room_11")).walk_in).toBe("cardOnTab");

    const seated = await as(diego, "POST", `/rooms/${ids["room_11"]}/sessions`, {
      party_size: 4,
      ids_checked: 4,
      minutes: 120,
    });
    expect(seated.statusCode, seated.body).toBe(201);
    const checkId = seated.json<{ check_id: string }>().check_id;
    const paymentsBefore = await owner.query(
      "select payment_id from payment_attempts where check_id = $1 union all select payment_id from payment_allocations where check_id = $1",
      [checkId],
    );

    const consent = (await as(diego, "GET", "/room-card-consent")).json<{
      version_id: string;
      text: string;
    }>();
    expect(consent.text).toContain("Nothing is charged now");
    await owner.query(
      "update device_heartbeats set last_seen_at = $2, offline_since = null where device_id = $1",
      [readerId, clock.now().toString()],
    );
    const tap = await as(
      diego,
      "POST",
      `/checks/${checkId}/card-tap`,
      { reader_id: readerId, consent_text_version: consent.version_id },
      `tap-${++n}`,
    );
    expect(tap.statusCode, tap.body).toBe(201);
    expect(tap.json()).toMatchObject({ state: "waiting", card: null });
    await presentCard("4242424242424242");
    const saved = await as(diego, "POST", `/checks/${checkId}/card-tap/check-status`);
    expect(saved.json()).toMatchObject({ state: "saved", card: { brand: "visa", last4: "4242" } });
    for (let i = 0; i < 5; i++) while ((await worker.tick()) > 0);

    const card = (
      await owner.query<{ pm: string; read_by: string; si: string }>(
        `select stripe_payment_method_id as pm, consent_read_by as read_by,
                stripe_setup_intent_id as si from check_cards where check_id = $1`,
        [checkId],
      )
    ).rows[0]!;
    expect(card.read_by).toBe(ids["diego"]);
    expect(card.pm).toMatch(/^pm_/);
    expect(fake.objects.get(card.si)).toMatchObject({ status: "succeeded" });
    // Nothing charged: no payment on the room's check, and the check still open.
    const paymentsAfter = await owner.query(
      "select payment_id from payment_attempts where check_id = $1 union all select payment_id from payment_allocations where check_id = $1",
      [checkId],
    );
    expect(paymentsAfter.rowCount).toBe(paymentsBefore.rowCount);
    const check = await owner.query<{ status: string }>("select status from checks where id = $1", [
      checkId,
    ]);
    expect(check.rows[0]!.status).not.toBe("paid");

    // A second card for the same room is refused: one card on the tab.
    const again = await as(
      diego,
      "POST",
      `/checks/${checkId}/card-tap`,
      { reader_id: readerId, consent_text_version: consent.version_id },
      `tap-${++n}`,
    );
    expect(again.statusCode).toBe(400);
    expect(again.json().details?.reason ?? again.json().error?.details?.reason).toBe("has_card");
  });
});
