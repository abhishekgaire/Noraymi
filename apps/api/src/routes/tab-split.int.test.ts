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
 * Splitting a bar tab (M6-10; Payment flows · Bar tab step 8; Money rules 1 and 13): Jess P.'s $32.66
 * splits into $16.33 + $16.33 kept on the server, so a share paid in cash stays paid when the bar comes
 * back to the tab ("Partly paid · $16.33 of $32.66"); the held card's share is captured last, with its
 * tip on the reader; Luis M.'s $63.15 in four is $15.79, $15.79, $15.79 and $15.78; "Stop splitting ·
 * charge the rest to Visa ··4417" captures the rest on her hold; and a guest who walks out mid-split
 * leaves the hold to charge the rest with no tip.
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

async function stripeReader() {
  const r = await owner.query<{ s: string }>(
    "select stripe_reader_id as s from devices where id = $1",
    [readerId],
  );
  return r.rows[0]!.s;
}
async function presentCard(number: string, extra = "") {
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
      body: `card_present[number]=${number}${extra}`,
    },
  );
  expect(res.status).toBe(200);
}
async function drain() {
  for (let i = 0; i < 5; i++) while ((await worker.tick()) > 0);
}
const consent = async () =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs/consent` })).json<{
    version_id: string;
    version: number;
    text: string;
    asks_party_size: boolean;
  }>();
const open = async (body: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/tabs`,
    headers: { "idempotency-key": `open-${++n}` },
    payload: { reader_id: readerId, consent_text_version: (await consent()).version_id, ...body },
  });
const checkStatus = async (o: string) =>
  (
    await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/openings/${o}/check-status`,
    })
  ).json<{
    state: string;
    payment: { id: string; state: string };
    card: { brand: string; last4: string } | null;
    tab: { id: string; check_id: string; name: string } | null;
  }>();
const intentOf = async (paymentId: string) => {
  const r = await owner.query<{ pi: string }>(
    "select stripe_pi_id as pi from payments where id = $1",
    [paymentId],
  );
  return fake.objects.get(r.rows[0]!.pi) as Record<string, unknown>;
};

const v = (item: string) => ids[`menu_${item}_regular`]!;
const send = (
  checkId: string,
  lines: { variant_id: string; qty: number }[],
  key = `round-key-${++n}`,
) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${checkId}/orders`,
    payload: { client_order_id: key, lines },
  });
/** A tab opened card first (M6-06): the guest taps, the hold is placed. */
async function openTab(name: string, number: string, extra = "") {
  const reader = fake.objects.get(await stripeReader()) as { action: unknown };
  reader.action = null;
  // The reader is heard from at the venue's clock (a test above moves it on).
  await owner.query(
    "update device_heartbeats set last_seen_at = $2, offline_since = null where device_id = $1",
    [readerId, clock.now().toString()],
  );
  const r = await open({ name });
  expect(r.statusCode, r.body).toBe(201);
  const o = r.json<{ id: string; payment: { id: string } }>();
  await presentCard(number, extra);
  await drain();
  const done = await checkStatus(o.id);
  expect(done.state).toBe("opened");
  return { ...done.tab!, paymentId: o.payment.id };
}
const payment = async (id: string) =>
  (
    await owner.query<{ authorized: number; used: number; status: string }>(
      "select authorized_cents::int as authorized, increments_used as used, status from payments where id = $1",
      [id],
    )
  ).rows[0]!;
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
  const maya: Principal = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  const abhishek: Principal = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  };
  let who: Principal = abhishek;
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
    payload: { registration_code: "simulated-s710", label: "Bar S710" },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  readerId = reg.json().reader?.id ?? reg.json().id;
  who = maya;
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

async function helper(path: string, body: string) {
  const res = await fetch(
    `${fakeBase}/v1/test_helpers/terminal/readers/${await stripeReader()}/${path}`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "stripe-account": account,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `helper-${++n}`,
      },
      body,
    },
  );
  expect(res.status, await res.clone().text()).toBe(200);
}
/** The guest taps a choice on the reader's tip screen, or types a number. */
const guestPicks = (choice: string) => helper("succeed_input_collection", `selection=${choice}`);
interface CloseView {
  id: string;
  state: string;
  tab_state: string;
  balance_cents: number;
  tip_choices: { kind: string; choices_cents: number[] } | null;
  tip_choice: string | null;
  tip_cents: number | null;
  capture_cents: number | null;
  payment: { id: string; status: string; state: string; unknown: boolean };
  receipt: string | null;
  receipt_sent: boolean;
}
const close = (tabId: string, body: Record<string, unknown> = { tip: "reader" }) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/tabs/${tabId}/close`,
    headers: { "idempotency-key": `close-${++n}` },
    payload: { reader_id: readerId, ...body },
  });
const closeStatus = async (tabId: string) => {
  const r = await app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/tabs/${tabId}/close/check-status`,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json<CloseView>();
};
const jessRound = () => [
  { variant_id: v("modelo"), qty: 2 },
  { variant_id: v("jager"), qty: 1 },
];

interface Share {
  id: string;
  share_no: number;
  amount_cents: number;
  state: string;
}
interface SplitListed {
  state: string;
  split: { id: string; share_count: number; shares: Share[] } | null;
  paid_cents: number;
  rest_cents: number;
  totals: { total_cents: number };
}
const tabRow = async (tabId: string) =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs` }))
    .json<{ tabs: (SplitListed & { id: string })[] }>()
    .tabs.find((t) => t.id === tabId)!;
const split = (tabId: string, shares: number) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/tabs/${tabId}/split`,
    payload: { shares },
  });
const cash = (checkId: string, share: Share) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${checkId}/payments`,
    headers: { "idempotency-key": `cash-${++n}` },
    payload: {
      method: "cash",
      amount_cents: share.amount_cents,
      tendered_cents: 2000,
      share_id: share.id,
    },
  });
const checkStatusOf = async (checkId: string) =>
  (await owner.query<{ status: string }>("select status from checks where id = $1", [checkId]))
    .rows[0]!.status;

describe("Split a tab and keep its paid shares (step 8)", () => {
  it("Jess P.'s $32.66 splits into $16.33 + $16.33; a cash share stays paid, and her Visa ··4417 pays the last with its tip", async () => {
    const tab = await openTab("Jess P.", "4000000000004417");
    expect((await send(tab.check_id, jessRound())).statusCode).toBe(201);
    const r = await split(tab.id, 2);
    expect(r.statusCode, r.body).toBe(201);
    const row = await tabRow(tab.id);
    expect(row.split!.shares.map((s) => s.amount_cents)).toEqual([1633, 1633]);
    expect(row).toMatchObject({ state: "open", paid_cents: 0, rest_cents: 3266 });
    // Split, the tab takes no more drinks, and closing waits for the other share.
    expect((await send(tab.check_id, jessRound())).statusCode).not.toBe(201);
    const early = await close(tab.id);
    expect(early.statusCode).toBe(400);
    expect(early.json().error.details.reason).toBe("split_shares_left");

    const second = row.split!.shares[1]!;
    const paid = await cash(tab.check_id, second);
    expect(paid.statusCode, paid.body).toBe(201);
    // Leaving the pay panel and coming back: the server still has it.
    const back = await tabRow(tab.id);
    expect(back).toMatchObject({
      state: "open",
      paid_cents: 1633,
      rest_cents: 1633,
      totals: { total_cents: 3266 },
    });
    expect(back.split!.shares.map((s) => s.state)).toEqual(["open", "paid"]);
    expect(await checkStatusOf(tab.check_id)).toBe("partly_paid");
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
    // The last share may go another way too (M6-11, tab-pay.int.test.ts); here it goes on the held card.
    // Close to the card: the tip is asked on her share's drinks ($15.00), and $16.33 plus it is captured.
    const asked = await close(tab.id);
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json<CloseView>()).toMatchObject({
      balance_cents: 1633,
      tip_choices: { kind: "percent", choices_cents: [270, 300, 330] },
    });
    expect((await tabRow(tab.id)).split!.shares[0]!.state).toBe("paying");
    await guestPicks("tip_1");
    expect(await closeStatus(tab.id)).toMatchObject({
      state: "captured",
      tab_state: "captured",
      tip_cents: 300,
      capture_cents: 1933,
    });
    expect(await intentOf(tab.paymentId)).toMatchObject({
      status: "succeeded",
      amount_received: 1933,
      _captures: 1,
    });
    const done = await tabRow(tab.id);
    expect(done.split!.shares.map((s) => s.state)).toEqual(["paid", "paid"]);
    expect(await checkStatusOf(tab.check_id)).toBe("paid");
  });

  it("Luis M.'s $63.15 in four is $15.79, $15.79, $15.79 and $15.78: a new card, cash, cash, then his hold", async () => {
    const tab = await openTab("Luis M.", "5555555555552281");
    expect((await send(tab.check_id, [{ variant_id: v("bucket_s"), qty: 1 }])).statusCode).toBe(
      201,
    );
    expect((await send(tab.check_id, [{ variant_id: v("s_drop"), qty: 2 }])).statusCode).toBe(201);
    expect((await split(tab.id, 4)).statusCode).toBe(201);
    const shares = (await tabRow(tab.id)).split!.shares;
    expect(shares.map((s) => s.amount_cents)).toEqual([1579, 1579, 1579, 1578]);
    // Share 2 on the bar reader with another card.
    const tap = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${tab.check_id}/payments`,
      headers: { "idempotency-key": `tap-${++n}` },
      payload: {
        method: "tap",
        amount_cents: 1579,
        reader_id: readerId,
        share_id: shares[1]!.id,
      },
    });
    expect(tap.statusCode, tap.body).toBe(201);
    await presentCard("4242424242424242");
    await drain();
    const status = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/payments/${tap.json<{ id: string }>().id}/check-status`,
    });
    expect(status.statusCode, status.body).toBe(200);
    expect((await tabRow(tab.id)).split!.shares[1]!.state).toBe("paid");
    expect((await cash(tab.check_id, shares[2]!)).statusCode).toBe(201);
    expect((await cash(tab.check_id, shares[3]!)).statusCode).toBe(201);
    expect(await tabRow(tab.id)).toMatchObject({ paid_cents: 4736, rest_cents: 1579 });
    (fake.objects.get(await stripeReader()) as { action: unknown }).action = null;
    expect((await close(tab.id)).statusCode).toBe(200);
    await guestPicks("none");
    expect(await closeStatus(tab.id)).toMatchObject({ state: "captured", capture_cents: 1579 });
    expect((await intentOf(tab.paymentId))["amount_received"]).toBe(1579);
    expect(await checkStatusOf(tab.check_id)).toBe("paid");
  });

  it('"Stop splitting · charge the rest to Visa ··4417" after one paid share captures the rest on her hold', async () => {
    const tab = await openTab("Jess P.", "4000000000004417");
    expect((await send(tab.check_id, jessRound())).statusCode).toBe(201);
    expect((await split(tab.id, 3)).statusCode).toBe(201);
    const shares = (await tabRow(tab.id)).split!.shares;
    expect(shares.map((s) => s.amount_cents)).toEqual([1089, 1089, 1088]);
    expect((await cash(tab.check_id, shares[1]!)).statusCode).toBe(201);
    const stopped = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/splits/${(await tabRow(tab.id)).split!.id}/stop`,
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    const row = await tabRow(tab.id);
    expect(row).toMatchObject({ split: null, paid_cents: 1089, rest_cents: 2177 });
    const r = await close(tab.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<CloseView>().balance_cents).toBe(2177);
    await guestPicks("none");
    expect(await closeStatus(tab.id)).toMatchObject({ state: "captured", capture_cents: 2177 });
    expect((await intentOf(tab.paymentId))["amount_received"]).toBe(2177);
    expect(await checkStatusOf(tab.check_id)).toBe("paid");
  });

  it("Cancel on the reader leaves the split as it was, and the held card's share to pay again", async () => {
    const tab = await openTab("Jess P.", "4000056655665556");
    expect((await send(tab.check_id, jessRound())).statusCode).toBe(201);
    expect((await split(tab.id, 2)).statusCode).toBe(201);
    const shares = (await tabRow(tab.id)).split!.shares;
    expect((await cash(tab.check_id, shares[1]!)).statusCode).toBe(201);
    expect((await close(tab.id)).statusCode).toBe(200);
    const canceled = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/${tab.id}/close/cancel`,
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    const row = await tabRow(tab.id);
    expect(row).toMatchObject({ state: "open", paid_cents: 1633, rest_cents: 1633 });
    expect(row.split!.shares.map((s) => s.state)).toEqual(["open", "paid"]);
    expect(await checkStatusOf(tab.check_id)).toBe("partly_paid");
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
  });

  it("a guest who walks out mid-split leaves the hold to charge the rest, with no tip", async () => {
    const tab = await openTab("Jess P.", "4000000000004417");
    expect((await send(tab.check_id, jessRound())).statusCode).toBe(201);
    expect((await split(tab.id, 2)).statusCode).toBe(201);
    const shares = (await tabRow(tab.id)).split!.shares;
    expect((await cash(tab.check_id, shares[1]!)).statusCode).toBe(201);
    // The hold still stands for the rest.
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized", authorized: 5000 });
    // The charge with no tip (the path Charge the remaining tabs and the 4:30 AM cut-off take).
    const r = await close(tab.id, { tip: "none" });
    expect(r.statusCode, r.body).toBe(200);
    await drain();
    expect(await closeStatus(tab.id)).toMatchObject({ state: "captured", capture_cents: 1633 });
    expect((await intentOf(tab.paymentId))["amount_received"]).toBe(1633);
    expect(await checkStatusOf(tab.check_id)).toBe("paid");
  });
});
