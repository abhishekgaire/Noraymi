import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Worker,
  addCheckLine,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { cashDiscount } from "@west4/rules";
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
  /** U-03 follow-up: what cash pays for this share with the cash discount on, else null. */
  cash_cents: number | null;
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

describe("M8-19: a void after a cash payment alerts the owner", () => {
  it("a void on Jess P.'s tab after one $16.33 share was paid in cash alerts Abhishek", async () => {
    const tab = await openTab("Jess P.", "4000000000004417");
    expect((await send(tab.check_id, jessRound())).statusCode).toBe(201);
    const shares = (await split(tab.id, 2)).json<{ split: { shares: Share[] } }>().split.shares;
    const paid = await cash(tab.check_id, shares[1]!);
    expect(paid.statusCode, paid.body).toBe(201);
    const alerts = async () =>
      (
        await owner.query<{ kind: string; amount_cents: string; source_key: string }>(
          "select kind, amount_cents, source_key from owner_alerts where check_id = $1",
          [tab.check_id],
        )
      ).rows;
    expect(await alerts()).toEqual([]);
    const jager = (
      await owner.query<{ id: string }>(
        "select id from check_lines where check_id = $1 and kind = 'item' and description like 'J%' order by id limit 1",
        [tab.check_id],
      )
    ).rows[0]!.id;
    // Today the server refuses a void on a partly paid check ("a correction is a refund")…
    const voided = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${tab.check_id}/lines/${jager}/void`,
      payload: { reason: "Rang up by mistake", made: false },
    });
    expect(voided.statusCode, voided.body).toBe(409);
    expect(await alerts()).toEqual([]);
    // …so the condition is forced: a void line written after the cash share, as any path that
    // writes one goes through addCheckLine (an approved order return, a later screen).
    await withVenue(workerPool, { venueId, requestId: "m8-19" }, (c) =>
      addCheckLine(c, venueId, tab.check_id, {
        kind: "void",
        description: "VOID · Jäger Bomb",
        qty: 1,
        unitCents: -1200,
        amountCents: -1200,
        taxCategory: "drink",
        businessDate: "2026-09-25",
        reversesId: Number(jager),
        made: false,
        reason: "Rang up by mistake",
        addedBy: ids["maya"]!,
        addedAt: clock.now().toString(),
      }),
    );
    const line = (
      await owner.query<{ id: string }>(
        "select id from check_lines where check_id = $1 and kind = 'void'",
        [tab.check_id],
      )
    ).rows[0];
    expect(await alerts()).toEqual([
      { kind: "void_after_cash", amount_cents: "1200", source_key: `void:${line!.id}` },
    ]);
    // The push goes to the venue's owners: Abhishek at West 4.
    const push = await owner.query<{
      payload: {
        audience: { kind: string; role: string };
        message: { key: string; params: Record<string, string> };
      };
    }>(
      "select payload from jobs where kind = 'push.send' and dedupe_key like 'owner-alert:%' and venue_id = $1",
      [venueId],
    );
    expect(push.rows).toHaveLength(1);
    expect(push.rows[0]!.payload.audience).toEqual({ kind: "role", role: "owner" });
    expect(push.rows[0]!.payload.message.key).toBe("push.ownerAlert.voidAfterCash");
    expect(push.rows[0]!.payload.message.params).toMatchObject({
      amount: "$12.00",
      staff: "Maya S.",
    });
    const owners = await owner.query<{ name: string }>(
      `select u.name from memberships m join users u on u.id = m.user_id
        where m.venue_id = $1 and m.role = 'owner' and m.status = 'active'`,
      [venueId],
    );
    expect(owners.rows.map((o) => o.name)).toContain("Abhishek G.");
  });
});

describe("U-03: split a cardless tab (D133)", () => {
  /** Sing Sing's way: tabs without a card, and the outside card machine on. */
  const cardless = async (name: string) => {
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_at)
       select venue_id, key, version + 1, value || jsonb_build_object('cardRequired', false),
              starts_on, saved_at
         from venue_settings where venue_id = $1 and key = 'tabs' order by version desc limit 1`,
      [venueId],
    );
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs`,
      headers: { "idempotency-key": `u03-cardless-${++n}` },
      payload: { card: "none", name },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ tab: { id: string; check_id: string } }>().tab;
  };
  const outside = (checkId: string, amountCents: number, shareId?: string) =>
    app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${checkId}/payments`,
      headers: { "idempotency-key": `u03-outside-${++n}` },
      payload: { method: "outside_card", amount_cents: amountCents, share_id: shareId },
    });

  beforeAll(async () => {
    await owner.query(
      "delete from venue_modules where venue_id = $1 and module_id = 'outside_card'",
      [venueId],
    );
    await owner.query(
      "insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'outside_card', true, 'on')",
      [venueId],
    );
  });

  it("a cardless tab splits three ways: cash, outside machine, outside machine; it closes on the last share", async () => {
    const before = fake.requests.length;
    const tab = await cardless("Dana U03");
    expect((await send(tab.check_id, jessRound())).statusCode).toBe(201);
    const r = await split(tab.id, 3);
    expect(r.statusCode, r.body).toBe(201);
    const row = await tabRow(tab.id);
    const total = row.totals.total_cents;
    const shares = row.split!.shares;
    // Largest remainder: the parts add up to the cent, the first shares take the leftover cents.
    expect(shares.reduce((s, x) => s + x.amount_cents, 0)).toBe(total);
    const even = Math.floor(total / 3);
    expect(shares.map((s) => s.amount_cents)).toEqual(
      [0, 1, 2].map((i) => even + (i < total - even * 3 ? 1 : 0)),
    );
    expect(row).toMatchObject({ state: "open", paid_cents: 0, rest_cents: total });
    // With the cash discount off (West 4), a share has one price.
    expect(shares.map((s) => s.cash_cents)).toEqual([null, null, null]);

    expect((await cash(tab.check_id, shares[0]!)).statusCode).toBe(201);
    const first = await outside(tab.check_id, shares[1]!.amount_cents, shares[1]!.id);
    expect(first.statusCode, first.body).toBe(201);
    expect(await tabRow(tab.id)).toMatchObject({
      state: "open",
      paid_cents: shares[0]!.amount_cents + shares[1]!.amount_cents,
      rest_cents: shares[2]!.amount_cents,
    });
    // A share pays its own amount, and a paid share isn't paid twice.
    expect((await outside(tab.check_id, 1, shares[2]!.id)).statusCode).toBe(400);
    expect(
      (await outside(tab.check_id, shares[1]!.amount_cents, shares[1]!.id)).statusCode,
    ).toBeGreaterThanOrEqual(400);

    const last = await outside(tab.check_id, shares[2]!.amount_cents, shares[2]!.id);
    expect(last.statusCode, last.body).toBe(201);
    expect(last.json()).toMatchObject({ check_status: "paid" });
    expect(await tabRow(tab.id)).toMatchObject({ state: "closed" });
    expect(await checkStatusOf(tab.check_id)).toBe("paid");
    const paid = await owner.query<{ method: string; cents: number }>(
      `select p.method, a.amount_cents::int as cents from payment_allocations a
         join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
        where a.check_id = $1 and a.state = 'captured'`,
      [tab.check_id],
    );
    expect(paid.rows.map((m) => m.method).sort()).toEqual(["cash", "outside_card", "outside_card"]);
    expect(paid.rows.reduce((s, m) => s + m.cents, 0)).toBe(total);
    // No reader and no hold: Stripe hears nothing.
    expect(fake.requests.length).toBe(before);
  });

  it("Stop splitting on a cardless tab keeps the paid share; the rest is paid as one and the tab closes", async () => {
    const tab = await cardless("Eli U03");
    expect((await send(tab.check_id, jessRound())).statusCode).toBe(201);
    expect((await split(tab.id, 2)).statusCode).toBe(201);
    const row = await tabRow(tab.id);
    const shares = row.split!.shares;
    expect((await cash(tab.check_id, shares[0]!)).statusCode).toBe(201);
    const stop = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/splits/${row.split!.id}/stop`,
    });
    expect(stop.statusCode, stop.body).toBe(200);
    const after = await tabRow(tab.id);
    expect(after).toMatchObject({
      state: "open",
      split: null,
      rest_cents: shares[1]!.amount_cents,
    });
    const rest = await outside(tab.check_id, after.rest_cents);
    expect(rest.statusCode, rest.body).toBe(201);
    expect(await tabRow(tab.id)).toMatchObject({ state: "closed" });
  });
  it("Sing Sing's 3.38% cash discount: a cash share pays its cash price, the shares still add up, and the tab closes", async () => {
    // Sing Sing's cash discount (D130; Money rules 10) on this venue's pay setting, as a new version.
    const top = (
      await owner.query<{ v: number }>(
        "select max(version)::int as v from venue_settings where venue_id = $1 and key = 'pay'",
        [venueId],
      )
    ).rows[0]!.v;
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on)
       select venue_id, key, version + 1, jsonb_set(value, '{cardFee}', $2::jsonb), starts_on
         from venue_settings where venue_id = $1 and key = 'pay' and version = $3`,
      [venueId, JSON.stringify({ mode: "discount", pct: 3.38, foodIncludesFee: true }), top],
    );
    // The same rule as any cash taken on a check: the rate on the cash, half up, and its tax.
    const rule = (amountCents: number) =>
      cashDiscount({
        amountCents,
        pct: 3.38,
        taxRatePct: "8.875",
        foodIncludesFee: true,
        foodWeightCents: 0,
        otherWeightCents: 0,
      });
    try {
      const tab = await cardless("Fay U03");
      expect((await send(tab.check_id, jessRound())).statusCode).toBe(201);
      expect((await split(tab.id, 2)).statusCode).toBe(201);
      const row = await tabRow(tab.id);
      const total = row.totals.total_cents;
      const shares = row.split!.shares;
      // The shares still divide the card total to the cent; each carries its cash price.
      expect(shares.reduce((s, x) => s + x.amount_cents, 0)).toBe(total);
      for (const s of shares) {
        expect(s.cash_cents).toBe(rule(s.amount_cents).cashPaysCents);
        expect(s.cash_cents!).toBeLessThan(s.amount_cents);
      }
      // A room's close-out reads the same split from the check, with the same cash prices.
      const check = await app.inject({
        method: "GET",
        url: `/v1/venues/${venueId}/checks/${tab.check_id}`,
      });
      expect(
        check.json<{ split: { shares: Share[] } }>().split.shares.map((s) => s.cash_cents),
      ).toEqual(shares.map((s) => s.cash_cents));

      // Exact on share 1: the share's amount is sent, the cash price is handed over, no change.
      const first = shares[0]!;
      const off = rule(first.amount_cents);
      const paid = await app.inject({
        method: "POST",
        url: `/v1/venues/${venueId}/checks/${tab.check_id}/payments`,
        headers: { "idempotency-key": `u03-cash-share-${++n}` },
        payload: {
          method: "cash",
          amount_cents: first.amount_cents,
          tendered_cents: first.cash_cents,
          share_id: first.id,
        },
      });
      expect(paid.statusCode, paid.body).toBe(201);
      expect(paid.json()).toMatchObject({ amount_cents: first.cash_cents, change_cents: 0 });
      // The discount and its tax come off the check as lines, as with any cash taken.
      const lines = await owner.query<{ kind: string; cents: number }>(
        `select kind, amount_cents::int as cents from check_lines
          where check_id = $1 and (kind = 'cash_discount' or description = 'Tax · cash discount')`,
        [tab.check_id],
      );
      expect(lines.rows.map((l) => l.cents).sort((a, b) => a - b)).toEqual(
        [-off.discountCents, -off.taxOffCents].filter((c) => c !== 0).sort((a, b) => a - b),
      );
      const after = await tabRow(tab.id);
      expect(after.totals.total_cents).toBe(total - off.discountCents - off.taxOffCents);
      expect(after).toMatchObject({
        state: "open",
        paid_cents: first.cash_cents,
        rest_cents: shares[1]!.amount_cents,
      });
      expect(after.split!.shares.map((s) => s.state)).toEqual(["paid", "open"]);
      // The share left keeps its card price, and its own cash price.
      expect(after.split!.shares[1]!.cash_cents).toBe(rule(shares[1]!.amount_cents).cashPaysCents);

      // Share 2 on the outside card machine at its card price closes the tab.
      const last = await outside(tab.check_id, shares[1]!.amount_cents, shares[1]!.id);
      expect(last.statusCode, last.body).toBe(201);
      expect(last.json()).toMatchObject({ check_status: "paid" });
      expect(await tabRow(tab.id)).toMatchObject({ state: "closed" });
      const allocated = await owner.query<{ cents: number }>(
        `select coalesce(sum(amount_cents), 0)::int as cents from payment_allocations
          where check_id = $1 and state = 'captured'`,
        [tab.check_id],
      );
      expect(allocated.rows[0]!.cents).toBe(after.totals.total_cents);
    } finally {
      await owner.query(
        "delete from venue_settings where venue_id = $1 and key = 'pay' and version > $2",
        [venueId, top],
      );
    }
  });
});
