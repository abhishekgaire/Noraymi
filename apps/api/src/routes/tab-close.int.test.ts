import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { reconcileVenue } from "../payments/reconcile.js";
import { InjectedCrash, StripeClient, StripeError, StripeUnknownResult } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { decide } from "../approvals/service.js";

/**
 * Closing a bar tab with the tip on the reader (M6-08; Payment flows · Bar tab with a growing hold,
 * step 5): Jess P.'s $32.66 offers $5.40, $6.00 and $6.60, Custom and No tip, and $6.00 captures $38.66
 * in one call; Luis M.'s $63.15 with 22% captures $75.91 on his $80.00 hold, and a total over his hold
 * plus $50 raises first; Tariq A.'s $9.80 after Andy's void offers $1, $2 and $3; Cancel on the reader
 * and an untouched tip screen put the tab back to open; an offline reader offers the slip; a capture
 * whose answer is lost, or whose run dies after Stripe took it, ends as one capture.
 */
let fault: "decline" | "drop" | "lostRead" | "lost" | "crash" | null = null;
let db: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let app: FastifyInstance;
let worker: Worker;
let fake: FakeStripe;
let stripeClient: StripeClient;
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
interface Listed {
  id: string;
  check_id: string;
  name: string;
  hold_cents: number;
  waiting_for: string | null;
  totals: { total_cents: number };
  hold: {
    cents: number;
    left_cents: number;
    can_grow: boolean;
    declined: boolean;
    checking: boolean;
    increments_used: number;
  } | null;
}
const listed = async (tabId: string) =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs` }))
    .json<{ tabs: Listed[] }>()
    .tabs.find((t) => t.id === tabId)!;
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
const increments = async (id: string) =>
  (
    await owner.query<{
      idem_key: string;
      state: string;
      amount_cents: string;
      decline_code: string | null;
    }>(
      "select idem_key, state, amount_cents, decline_code from payment_attempts where payment_id = $1 and action = 'increment' order by attempt_no",
      [id],
    )
  ).rows;

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
  const stripe = new StripeClient(fakeStripeSettings(fakeBase), fetch, 15_000, {
    // The fault-injection client (M4-05): a declined raise, or a raise whose answer never came back.
    step: (name) => {
      if (name === "after-capture" && fault === "crash") {
        fault = null;
        throw new InjectedCrash(name);
      }
    },
    before: (method, path) => {
      if (path.endsWith("/increment_authorization") && fault === "decline") {
        fault = null;
        throw new StripeError(
          402,
          "card_error",
          "card_declined",
          "Your card was declined.",
          "generic_decline",
        );
      }
      if (method === "GET" && path.includes("/v1/payment_intents/") && fault === "lostRead") {
        fault = null;
        throw new StripeUnknownResult("injected: no answer from Stripe");
      }
      if (path.endsWith("/increment_authorization") && fault === "lost") {
        fault = null;
        throw new StripeUnknownResult("injected: the raise never reached Stripe");
      }
    },
    dropAnswer: (method, path) => {
      if (path.endsWith("/capture") && fault === "drop") {
        // The capture's answer is lost, and so is the next read of the PaymentIntent.
        fault = "lostRead";
        return true;
      }
      return false;
    },
  });
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  stripeClient = stripe;
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
const guestTypes = (value: string) => helper("succeed_input_collection", `value=${value}`);
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
const readerAction = async () =>
  (fake.objects.get(await stripeReader()) as { action: Record<string, unknown> | null }).action;
const tabState = async (tabId: string) =>
  (await owner.query<{ state: string }>("select state from tabs where id = $1", [tabId])).rows[0]!
    .state;
const captures = async (paymentId: string) =>
  (
    await owner.query<{ idem_key: string; state: string; amount_cents: string }>(
      "select idem_key, state, amount_cents from payment_attempts where payment_id = $1 and action = 'capture' order by attempt_no",
      [paymentId],
    )
  ).rows;
const jessRound = () => [
  { variant_id: v("modelo"), qty: 2 },
  { variant_id: v("jager"), qty: 1 },
];

describe("Close to the card: the tip on the reader, captured in one call (step 5)", () => {
  it("Jess P.'s $32.66 offers $5.40, $6.00, $6.60, Custom and No tip; $6.00 captures $38.66 once", async () => {
    const tab = await openTab("Jess P.", "4000000000004417");
    const rung = await send(tab.check_id, jessRound());
    expect(rung.statusCode, rung.body).toBe(201);
    const r = await close(tab.id);
    expect(r.statusCode, r.body).toBe(200);
    const asked = r.json<CloseView>();
    expect(asked).toMatchObject({
      state: "asking",
      tab_state: "tipping",
      balance_cents: 3266,
      tip_choices: { kind: "percent", choices_cents: [540, 600, 660] },
    });
    const action = await readerAction();
    expect(action).toMatchObject({ type: "collect_inputs", status: "in_progress" });
    const inputs = (action!["collect_inputs"] as { inputs: Record<string, unknown>[] }).inputs;
    expect(inputs[0]).toMatchObject({ type: "selection" });
    const texts = (inputs[0]!["selection"] as { choices: { text: string }[] }).choices.map(
      (x) => x.text,
    );
    expect(texts).toEqual(["$5.40 (18%)", "$6.00 (20%)", "$6.60 (22%)", "Custom", "No tip"]);

    await guestPicks("tip_1");
    const done = await closeStatus(tab.id);
    expect(done).toMatchObject({
      state: "captured",
      tab_state: "captured",
      tip_cents: 600,
      capture_cents: 3866,
      payment: { status: "captured", state: "paid" },
    });
    // Closed tonight: no hold left on it, and nothing more to close.
    expect(await listed(tab.id)).toMatchObject({ hold: null, totals: { total_cents: 3266 } });
    const pi = await intentOf(tab.paymentId);
    expect(pi).toMatchObject({ status: "succeeded", amount_received: 3866, _captures: 1 });
    const cap = await captures(tab.paymentId);
    expect(cap).toHaveLength(1);
    expect(cap[0]!.idem_key).toMatch(new RegExp(`^${tab.paymentId}:capture:\\d+:3866$`));
    const paid = (
      await owner.query<{ amount: number; tip: number }>(
        "select amount_cents::int as amount, tip_cents::int as tip from payments where id = $1",
        [tab.paymentId],
      )
    ).rows[0]!;
    expect(paid).toEqual({ amount: 3266, tip: 600 });
    // The tip ledger (M7-08): one card tip of $6.00, on the shift of the person who closed the tab.
    const ledger = await owner.query<{
      source: string;
      amount: number;
      closer: boolean;
      shift: boolean;
    }>(
      `select l.source, l.amount_cents::int as amount, l.user_id = t.closed_by as closer,
              s.membership_id = m.id as shift
         from tip_ledger l join tabs t on t.payment_id = l.payment_id
         left join shifts s on s.id = l.shift_id
         left join memberships m on m.venue_id = l.venue_id and m.user_id = l.user_id
        where l.payment_id = $1`,
      [tab.paymentId],
    );
    expect(ledger.rows).toEqual([{ source: "card_tip", amount: 600, closer: true, shift: true }]);
    const check = await owner.query<{ status: string }>("select status from checks where id = $1", [
      tab.check_id,
    ]);
    expect(check.rows[0]!.status).toBe("paid");
    // The guest's pick is kept with the payment as dispute evidence: the choice, amount, time and reader.
    const evidence = (
      await owner.query<{
        tip_choice: string;
        tip_cents: number;
        picked: boolean;
        reader: string;
      }>(
        `select tip_choice, tip_cents, tip_picked_at is not null as picked, reader_device_id as reader
           from tab_closings where payment_id = $1`,
        [tab.paymentId],
      )
    ).rows[0]!;
    expect(evidence).toEqual({
      tip_choice: "choice_2",
      tip_cents: 600,
      picked: true,
      reader: readerId,
    });

    // The receipt: Print goes to the bar's printer; nothing is captured again.
    const printed = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/${tab.id}/close/receipt`,
      payload: { choice: "print" },
    });
    expect(printed.statusCode, printed.body).toBe(200);
    expect(printed.json()).toMatchObject({ receipt: "print", receipt_sent: true });
    expect((await intentOf(tab.paymentId))["_captures"]).toBe(1);
  });

  it("Text puts a phone number question on the reader, and the receipt is texted to it", async () => {
    const tab = await openTab("Jess P.", "4242424242424242");
    const rung = await send(tab.check_id, jessRound());
    expect(rung.statusCode, rung.body).toBe(201);
    expect((await close(tab.id)).statusCode).toBe(200);
    await guestPicks("none");
    expect(await closeStatus(tab.id)).toMatchObject({ state: "captured", tip_cents: 0 });
    expect((await intentOf(tab.paymentId))["amount_received"]).toBe(3266);
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/${tab.id}/close/receipt`,
      payload: { choice: "text" },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(await readerAction()).toMatchObject({
      type: "collect_inputs",
      collect_inputs: { inputs: [{ type: "phone" }] },
    });
    await guestTypes("2125550142");
    const sent = await closeStatus(tab.id);
    expect(sent).toMatchObject({ receipt: "text", receipt_sent: true });
    const receipts = await owner.query<{ channel: string }>(
      "select channel from receipts where check_id = $1",
      [tab.check_id],
    );
    expect(receipts.rows.map((x) => x.channel)).toContain("text");
  });

  it("Luis M.: $63.15 with a 22% tip ($12.76) captures $75.91 on his $80.00 hold with no raise", async () => {
    const tab = await openTab("Luis M.", "5555555555552281");
    expect((await send(tab.check_id, [{ variant_id: v("bucket_s"), qty: 1 }])).statusCode).toBe(
      201,
    );
    expect((await send(tab.check_id, [{ variant_id: v("s_drop"), qty: 2 }])).statusCode).toBe(201);
    const r = await close(tab.id);
    expect(r.json<CloseView>().tip_choices?.choices_cents).toEqual([1044, 1160, 1276]);
    await guestPicks("tip_2");
    expect(await closeStatus(tab.id)).toMatchObject({
      state: "captured",
      tip_cents: 1276,
      capture_cents: 7591,
    });
    expect(await intentOf(tab.paymentId)).toMatchObject({
      amount: 8000,
      amount_received: 7591,
      _increments: 1,
    });
    expect(await payment(tab.paymentId)).toMatchObject({ used: 1, status: "captured" });
  });

  it("a total over his hold plus $50 ($130.00) raises the hold first, then captures", async () => {
    const tab = await openTab("Luis M.", "5555555555554444");
    expect((await send(tab.check_id, [{ variant_id: v("bucket_s"), qty: 1 }])).statusCode).toBe(
      201,
    );
    expect((await send(tab.check_id, [{ variant_id: v("s_drop"), qty: 2 }])).statusCode).toBe(201);
    expect((await close(tab.id)).statusCode).toBe(200);
    await guestPicks("custom");
    expect(await closeStatus(tab.id)).toMatchObject({ state: "custom" });
    expect(await readerAction()).toMatchObject({
      collect_inputs: { inputs: [{ type: "numeric" }] },
    });
    await guestTypes("70");
    expect(await closeStatus(tab.id)).toMatchObject({
      state: "captured",
      tip_choice: "custom",
      tip_cents: 7000,
      capture_cents: 13315,
    });
    expect(await intentOf(tab.paymentId)).toMatchObject({
      amount: 13315,
      amount_received: 13315,
      _increments: 2,
      _captures: 1,
    });
    const inc = await increments(tab.paymentId);
    expect(inc.at(-1)).toMatchObject({ state: "succeeded", amount_cents: "13315" });
  });

  it("Tariq A.'s tab after Andy approves the void ($9.80) offers $1, $2 and $3", async () => {
    const tab = await openTab("Tariq A.", "4000056655665556");
    const round = [
      { variant_id: v("bucket_l"), qty: 1 },
      { variant_id: v("modelo"), qty: 1 },
    ];
    expect((await send(tab.check_id, round)).statusCode).toBe(201);
    const line = (
      await owner.query<{ id: string }>(
        "select id from check_lines where check_id = $1 and amount_cents = 7000 and kind = 'item'",
        [tab.check_id],
      )
    ).rows[0]!;
    const v1 = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${tab.check_id}/lines/${line.id}/void`,
      headers: { "idempotency-key": `void-${++n}` },
      payload: { reason: "Rang the wrong bucket", made: false },
    });
    expect(v1.statusCode, v1.body).toBe(202);
    await withVenue(workerPool, { venueId }, (c) =>
      decide(c, venueId, v1.json().approval_id, {
        decision: "approve",
        userId: ids["andy"]!,
        deviceId: ids["dev_phone_andy"]!,
        at: clock.now(),
      }),
    );
    const r = await close(tab.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<CloseView>()).toMatchObject({
      balance_cents: 980,
      tip_choices: { kind: "fixed", choices_cents: [100, 200, 300] },
    });
    await guestPicks("tip_1");
    expect(await closeStatus(tab.id)).toMatchObject({ state: "captured", capture_cents: 1180 });
  });
});

describe("back to open, and the slip", () => {
  it("Cancel on the reader puts the tab back to open, and it takes drinks again", async () => {
    const tab = await openTab("Jess P.", "6011111111111117");
    const rung = await send(tab.check_id, jessRound());
    expect(rung.statusCode, rung.body).toBe(201);
    expect((await close(tab.id)).statusCode).toBe(200);
    expect(await tabState(tab.id)).toBe("tipping");
    // While the reader asks, nothing more goes on the tab.
    expect((await send(tab.check_id, [{ variant_id: v("modelo"), qty: 1 }])).statusCode).toBe(409);
    const reader = await stripeReader();
    const res = await fetch(`${fakeBase}/v1/terminal/readers/${reader}/cancel_action`, {
      method: "POST",
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "stripe-account": account,
        "idempotency-key": `guest-cancel-${++n}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await closeStatus(tab.id)).toMatchObject({ state: "canceled", tab_state: "open" });
    expect((await send(tab.check_id, [{ variant_id: v("modelo"), qty: 1 }])).statusCode).toBe(201);
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
  });

  it("a tip screen left untouched for 2 minutes comes down, and the paper slip prints (M6-09)", async () => {
    const tab = await openTab("Jess P.", "3056930009020004");
    const rung = await send(tab.check_id, jessRound());
    expect(rung.statusCode, rung.body).toBe(201);
    expect((await close(tab.id)).statusCode).toBe(200);
    clock.advance({ seconds: 121 });
    expect(await closeStatus(tab.id)).toMatchObject({ state: "slip", tab_state: "awaiting_tip" });
    expect(await readerAction()).toMatchObject({ status: "failed" });
  });

  it("with the reader offline at close, the slip is offered", async () => {
    const tab = await openTab("Jess P.", "3566002020360505");
    const rung = await send(tab.check_id, jessRound());
    expect(rung.statusCode, rung.body).toBe(201);
    await owner.query("update device_heartbeats set offline_since = $2 where device_id = $1", [
      readerId,
      clock.now().toString(),
    ]);
    const r = await close(tab.id);
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json()).toMatchObject({ error: { code: "reader_offline", details: { slip: true } } });
    expect(await tabState(tab.id)).toBe("open");
    const slip = await close(tab.id, { tip: "slip" });
    expect(slip.statusCode, slip.body).toBe(200);
    expect(await tabState(tab.id)).toBe("awaiting_tip");
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
  });
});

describe("a capture that times out ends as one capture (chaos)", () => {
  it("its answer is lost: Checking with Stripe, then captured once, never twice", async () => {
    const tab = await openTab("Jess P.", "4000002500003155");
    const rung = await send(tab.check_id, jessRound());
    expect(rung.statusCode, rung.body).toBe(201);
    expect((await close(tab.id)).statusCode).toBe(200);
    await guestPicks("tip_1");
    fault = "drop";
    const checking = await closeStatus(tab.id);
    expect(checking).toMatchObject({ state: "capturing", payment: { unknown: true } });
    // Nothing is sent again: the poller and the reconciler read Stripe.
    clock.advance({ seconds: 150 });
    await reconcileVenue({ pool: workerPool, stripe: stripeClient, clock }, venueId);
    expect(await closeStatus(tab.id)).toMatchObject({ state: "captured", tab_state: "captured" });
    expect(await intentOf(tab.paymentId)).toMatchObject({ amount_received: 3866, _captures: 1 });
    expect(await captures(tab.paymentId)).toHaveLength(1);
  });

  it("killed between the capture's success and our record: the reconciler records it once", async () => {
    const tab = await openTab("Jess P.", "4000000760000002");
    const rung = await send(tab.check_id, jessRound());
    expect(rung.statusCode, rung.body).toBe(201);
    expect((await close(tab.id)).statusCode).toBe(200);
    await guestPicks("tip_0");
    fault = "crash";
    await closeStatus(tab.id).catch(() => undefined);
    expect(await intentOf(tab.paymentId)).toMatchObject({ status: "succeeded", _captures: 1 });
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
    clock.advance({ seconds: 150 });
    await drain();
    await reconcileVenue({ pool: workerPool, stripe: stripeClient, clock }, venueId);
    expect(await payment(tab.paymentId)).toMatchObject({ status: "captured" });
    expect(await tabState(tab.id)).toBe("captured");
    expect(await intentOf(tab.paymentId)).toMatchObject({ amount_received: 3806, _captures: 1 });
    expect(await captures(tab.paymentId)).toHaveLength(1);
  });

  it("No tip from the screen captures the balance at once, with no tip screen", async () => {
    const tab = await openTab("Jess P.", "4000003800000008");
    const rung = await send(tab.check_id, jessRound());
    expect(rung.statusCode, rung.body).toBe(201);
    const r = await close(tab.id, { tip: "none" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ state: "captured", capture_cents: 3266, tip_cents: 0 });
  });
});
