import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { seedStripe } from "../stripe/seed-stripe.js";
import { decide } from "../approvals/service.js";

/**
 * The paper tip slip and Tips to enter (M6-09; Payment flows · Bar tab with a growing hold, steps 5 and 7;
 * screens N26): the seed's three slips (Dev S., Tom W., Ana R.) wait with their photos, never Jess P.'s
 * Visa ··4417; Ana R.'s $12.00 tip on $62.50 captures $74.50 with no approval; a $20.00 tip, a tip typed in
 * 2 h 1 min after the slip, and one over $50 wait for Andy, and one Andy typed in himself for Abhishek;
 * no tip goes in without the slip's photo; printing the slip (asked for, a tip screen nobody touched, or a
 * venue that tips on paper) leaves the hold standing; a tip after its night posts to the next date.
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

const person = (slug: string, role: string, session: "pin" | "passkey" = "passkey"): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session,
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});
const as = (slug: string, role: string) => {
  who = person(slug, role, role === "bartender" ? "pin" : "passkey");
};

async function stripeReader() {
  const r = await owner.query<{ s: string }>(
    "select stripe_reader_id as s from devices where id = $1",
    [readerId],
  );
  return r.rows[0]!.s;
}
async function fakePost(path: string, body: string) {
  const res = await fetch(`${fakeBase}${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer rk_test_fake_payments",
      "stripe-account": account,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `helper-${++n}`,
    },
    body,
  });
  expect(res.status, await res.clone().text()).toBe(200);
}
const presentCard = async (number: string) =>
  fakePost(
    `/v1/test_helpers/terminal/readers/${await stripeReader()}/present_payment_method`,
    `card_present[number]=${number}`,
  );
async function drain() {
  for (let i = 0; i < 5; i++) while ((await worker.tick()) > 0);
}
const inject = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${url}`,
    ...(method === "POST" ? { headers: { "idempotency-key": `key-${++n}` } } : {}),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

/** A tab opened card first on the bar reader (M6-06), as in tab-close.int.test.ts. */
async function openTab(name: string, number: string) {
  const reader = fake.objects.get(await stripeReader()) as { action: unknown };
  reader.action = null;
  await owner.query(
    "update device_heartbeats set last_seen_at = $2, offline_since = null where device_id = $1",
    [readerId, clock.now().toString()],
  );
  const consent = (await inject("GET", "/tabs/consent")).json<{ version_id: string }>();
  const r = await inject("POST", "/tabs", {
    reader_id: readerId,
    consent_text_version: consent.version_id,
    name,
  });
  expect(r.statusCode, r.body).toBe(201);
  const o = r.json<{ id: string; payment: { id: string } }>();
  await presentCard(number);
  await drain();
  const done = (await inject("POST", `/tabs/openings/${o.id}/check-status`)).json<{
    state: string;
    tab: { id: string; check_id: string };
  }>();
  expect(done.state).toBe("opened");
  return { ...done.tab, paymentId: o.payment.id };
}
const v = (item: string) => ids[`menu_${item}_regular`]!;
const send = (checkId: string, lines: { variant_id: string; qty: number }[]) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${checkId}/orders`,
    payload: { client_order_id: `round-${++n}`, lines },
  });

interface Slip {
  closing_id: string;
  total_cents: number;
  printed_at: string;
  photo_file_id: string | null;
  waiting_for: string | null;
}
interface Listed {
  id: string;
  name: string;
  state: string;
  open: boolean;
  card: { brand: string; last4: string } | null;
  waiting_for: string | null;
  slip: Slip | null;
}
const toEnter = async () =>
  (await inject("GET", "/tabs?state=awaiting_tip")).json<{ tabs: Listed[] }>().tabs;
const tip = (tabId: string, tipCents: number, photo?: string) =>
  inject("POST", `/tabs/${tabId}/tip`, {
    tip_cents: tipCents,
    ...(photo ? { photo_file_id: photo } : {}),
  });
const payment = async (id: string) =>
  (
    await owner.query<{
      status: string;
      amount: number;
      tip: number;
      business_date: string;
      adjusts: string | null;
    }>(
      `select status, amount_cents::int as amount, tip_cents::int as tip, business_date::text,
              adjusts_business_date::text as adjusts from payments where id = $1`,
      [id],
    )
  ).rows[0]!;
const captures = async (paymentId: string) =>
  (
    await owner.query<{ amount_cents: string; state: string }>(
      "select amount_cents, state from payment_attempts where payment_id = $1 and action = 'capture'",
      [paymentId],
    )
  ).rows;
const tabState = async (tabId: string) =>
  (await owner.query<{ state: string }>("select state from tabs where id = $1", [tabId])).rows[0]!
    .state;
const decideAs = async (approvalId: string, slug: string, decision: "approve" | "decline") =>
  withVenue(workerPool, { venueId }, (c) =>
    decide(c, venueId, approvalId, {
      decision,
      userId: ids[slug]!,
      deviceId: ids[`dev_phone_${slug}`]!,
      at: clock.now(),
    }),
  );
async function photo(kind = "slip_photo"): Promise<string> {
  const answer = (
    await inject("POST", "/files", { kind, content_type: "image/jpeg", bytes: 3 })
  ).json<{ file_id: string; upload: { url: string; fields: Record<string, string> } }>();
  const form = new FormData();
  for (const [k, val] of Object.entries(answer.upload.fields)) form.set(k, val);
  form.set("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "slip");
  const sent = await fetch(answer.upload.url, { method: "POST", body: form });
  expect(sent.status).toBeLessThan(300);
  return answer.file_id;
}

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
  // The night's Stripe side, as `stripe:seed` puts it: the account, both readers, the slips' holds.
  account = (await seedStripe(owner, stripe, () => undefined)).account;
  readerId = (await owner.query<{ id: string }>("select id from devices where name = 'Bar S710'"))
    .rows[0]!.id;
  as("maya", "bartender");
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await app.ready();
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

describe("Tips to enter (screens N26)", () => {
  it("lists Dev S., Tom W. and Ana R., each with its card, total and photo, and never Jess P.'s Visa ··4417", async () => {
    const tabs = await toEnter();
    expect(tabs.map((t) => [t.name, t.card?.brand, t.card?.last4, t.slip?.total_cents])).toEqual([
      ["Dev S.", "Visa", "3318", 4800],
      ["Tom W.", "Mastercard", "0457", 3600],
      ["Ana R.", "Amex", "2204", 6250],
    ]);
    for (const t of tabs) {
      expect(t.slip?.photo_file_id).toBeTruthy();
      expect(t).toMatchObject({ state: "awaiting_tip", open: false, waiting_for: null });
    }
    expect(tabs.some((t) => t.card?.last4 === "4417")).toBe(false);
    // The bar's open tabs are still the five; the slips list with tonight's closed ones.
    const all = (await inject("GET", "/tabs")).json<{ tabs: Listed[] }>().tabs;
    expect(all.filter((t) => t.open).map((t) => t.name)).toEqual([
      "Hana K.",
      "Jess P.",
      "Luis M.",
      "Tariq A.",
      "Seat 6 · blue jacket",
    ]);
  });

  it("Ana R.'s $12.00 tip on $62.50 captures $74.50 in one call, with no approval", async () => {
    const ana = (await toEnter()).find((t) => t.name === "Ana R.")!;
    const r = await tip(ana.id, 1200);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      state: "captured",
      tab_state: "captured",
      tip_cents: 1200,
      capture_cents: 7450,
    });
    const paymentId = ids["pay_slip_3"]!;
    expect(await payment(paymentId)).toMatchObject({
      status: "captured",
      amount: 6250,
      tip: 1200,
      business_date: "2026-09-25",
      adjusts: null,
    });
    expect(await captures(paymentId)).toEqual([{ amount_cents: "7450", state: "succeeded" }]);
    const closing = (
      await owner.query<{ tip_choice: string; tip_entered_by: string }>(
        "select tip_choice, tip_entered_by from tab_closings where tab_id = $1",
        [ana.id],
      )
    ).rows[0]!;
    expect(closing).toEqual({ tip_choice: "slip", tip_entered_by: ids["maya"] });
    // Entered once: it's gone from the list, and a second tip is refused.
    expect((await toEnter()).map((t) => t.name)).toEqual(["Dev S.", "Tom W."]);
    expect((await tip(ana.id, 1200)).statusCode).toBe(400);
  });

  it("a $20.00 tip (over 25%) waits for Andy; nothing is captured until he OKs it on his phone", async () => {
    const dev = (await toEnter()).find((t) => t.name === "Dev S.")!;
    const r = await tip(dev.id, 2000);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { user_id: ids["andy"], name: "Andy C." },
    });
    const approval = (
      await owner.query<{ kind: string; reason: string; payload: Record<string, unknown> }>(
        "select kind, reason, payload from approvals where id = $1",
        [r.json().approval_id],
      )
    ).rows[0]!;
    expect(approval).toMatchObject({
      kind: "tip_review",
      reason: "Over 25% of the tab",
      payload: { reasons: ["over_pct"], tip_cents: 2000, description: "Dev S. · $48.00" },
    });
    expect((await toEnter()).find((t) => t.name === "Dev S.")).toMatchObject({
      waiting_for: "Andy C.",
      slip: { waiting_for: "Andy C." },
    });
    expect(await payment(ids["pay_slip_1"]!)).toMatchObject({ status: "authorized", tip: 0 });
    // Another tip while it waits is refused.
    expect((await tip(dev.id, 900)).json()).toMatchObject({
      error: { details: { reason: "tip_waiting" } },
    });
    await decideAs(r.json().approval_id, "andy", "approve");
    await drain();
    expect(await payment(ids["pay_slip_1"]!)).toMatchObject({
      status: "captured",
      amount: 4800,
      tip: 2000,
    });
    expect(await tabState(dev.id)).toBe("captured");
  });

  it("a tip typed in 2 h 1 min after the slip waits for Andy; declined, the slip waits again", async () => {
    const tom = (await toEnter()).find((t) => t.name === "Tom W.")!;
    // Signed at 10:26 PM: 2 h 1 min later is 12:27 AM, still Friday's business date.
    clock.set(Temporal.Instant.from("2026-09-26T04:27:00Z"));
    const r = await tip(tom.id, 500);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ waiting_for: { name: "Andy C." } });
    const reason = (
      await owner.query<{ reason: string }>("select reason from approvals where id = $1", [
        r.json().approval_id,
      ])
    ).rows[0]!.reason;
    expect(reason).toBe("Entered more than 2 hours after the slip");
    await decideAs(r.json().approval_id, "andy", "decline");
    expect((await toEnter()).find((t) => t.name === "Tom W.")).toMatchObject({
      waiting_for: null,
      state: "awaiting_tip",
    });
    expect(await payment(ids["pay_slip_2"]!)).toMatchObject({ status: "authorized" });
  });

  it("one Andy typed in himself goes to Abhishek; approved after the night, it posts to Saturday", async () => {
    const tom = (await toEnter()).find((t) => t.name === "Tom W.")!;
    as("andy", "manager");
    const r = await tip(tom.id, 500);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({
      waiting_for: { user_id: ids["abhishek"], name: "Abhishek G." },
    });
    // Abhishek OKs it Saturday at 7:00 AM: the capture posts to Sat Sep 26, adjusting Fri Sep 25.
    clock.set(Temporal.Instant.from("2026-09-26T11:00:00Z"));
    await decideAs(r.json().approval_id, "abhishek", "approve");
    await drain();
    expect(await payment(ids["pay_slip_2"]!)).toMatchObject({
      status: "captured",
      amount: 3600,
      tip: 500,
      business_date: "2026-09-26",
      adjusts: "2026-09-25",
    });
    const entered = (
      await owner.query<{ by: string }>(
        "select tip_entered_by as by from tab_closings where tab_id = $1",
        [tom.id],
      )
    ).rows[0]!;
    expect(entered.by).toBe(ids["andy"]);
    expect(await toEnter()).toEqual([]);
  });
});

describe("Print the slip (Payment flows step 5)", () => {
  it("prints at the bar and moves the tab to awaiting_tip; the hold stays; tab.awaiting_tip goes out", async () => {
    clock.set(SEED_NOW);
    as("maya", "bartender");
    const tab = await openTab("Priya N.", "4242424242424242");
    expect((await send(tab.check_id, [{ variant_id: v("modelo"), qty: 2 }])).statusCode).toBe(201);
    const r = await inject("POST", `/tabs/${tab.id}/close`, { tip: "slip" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ state: "slip", tab_state: "awaiting_tip" });
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
    const printed = (
      await owner.query<{ station: string; payload: { lines: string[] } }>(
        "select station, payload from print_jobs where check_id = $1 and kind = 'receipt'",
        [tab.check_id],
      )
    ).rows;
    expect(printed).toHaveLength(1);
    expect(printed[0]!.station).toBe("bar");
    expect(printed[0]!.payload.lines).toEqual(
      expect.arrayContaining(["Priya N.", "Tip  ____________", "Signature  ____________"]),
    );
    const events = await owner.query<{ type: string }>(
      "select type from venue_events where entity_id = $1 and type = 'tab.awaiting_tip'",
      [tab.id],
    );
    expect(events.rows).toHaveLength(1);
    expect((await toEnter()).map((t) => t.name)).toEqual(["Priya N."]);
    // No tip goes in without the slip's photo; a damage photo isn't one.
    const none = await tip(tab.id, 300);
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ error: { details: { reason: "photo_required" } } });
    const wrong = await tip(tab.id, 300, await photo("damage_photo"));
    expect(wrong.json()).toMatchObject({ error: { details: { reason: "photo_kind" } } });
    const ok = await tip(tab.id, 300, await photo());
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: "captured", tip_cents: 300 });
  });

  it("a $50.01 tip on a tab over $200 (16.7% would not need it) goes to Andy for being over $50", async () => {
    const tab = await openTab("Big Party", "5555555555554444");
    for (let i = 0; i < 4; i++)
      expect((await send(tab.check_id, [{ variant_id: v("bucket_l"), qty: 1 }])).statusCode).toBe(
        201,
      );
    const r = await inject("POST", `/tabs/${tab.id}/close`, { tip: "slip" });
    expect(r.statusCode, r.body).toBe(200);
    const total = (await toEnter()).find((t) => t.id === tab.id)!.slip!.total_cents;
    expect(total).toBeGreaterThan(20004);
    const asked = await tip(tab.id, 5001, await photo());
    expect(asked.statusCode, asked.body).toBe(202);
    expect(asked.json()).toMatchObject({ waiting_for: { name: "Andy C." } });
    const reason = (
      await owner.query<{ reason: string }>("select reason from approvals where id = $1", [
        asked.json().approval_id,
      ])
    ).rows[0]!.reason;
    expect(reason).toBe("Over $50.00");
  });

  it("a tip screen nobody touched for 2 minutes comes down and the slip prints", async () => {
    const tab = await openTab("Kai L.", "6011111111111117");
    expect((await send(tab.check_id, [{ variant_id: v("modelo"), qty: 2 }])).statusCode).toBe(201);
    const r = await inject("POST", `/tabs/${tab.id}/close`, { tip: "reader", reader_id: readerId });
    expect(r.statusCode, r.body).toBe(200);
    clock.advance({ seconds: 121 });
    const status = await inject("POST", `/tabs/${tab.id}/close/check-status`);
    expect(status.json()).toMatchObject({ state: "slip", tab_state: "awaiting_tip" });
    expect(await payment(tab.paymentId)).toMatchObject({ status: "authorized" });
    const printed = await owner.query(
      "select 1 from print_jobs where check_id = $1 and kind = 'receipt'",
      [tab.check_id],
    );
    expect(printed.rows).toHaveLength(1);
  });

  it("with pos.barTabTip set to slip, Close to the card prints the slip first", async () => {
    await owner.query(
      `update venue_settings set value = jsonb_set(value, '{barTabTip}', '"slip"') where key = 'pos'`,
    );
    const tab = await openTab("Noor B.", "378282246310005");
    expect((await send(tab.check_id, [{ variant_id: v("modelo"), qty: 1 }])).statusCode).toBe(201);
    const r = await inject("POST", `/tabs/${tab.id}/close`, { tip: "reader", reader_id: readerId });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ state: "slip", tab_state: "awaiting_tip" });
    // The reader never asked for a tip.
    const action = (fake.objects.get(await stripeReader()) as { action: { type?: string } | null })
      .action;
    expect(action?.type).not.toBe("collect_inputs");
    await owner.query(
      `update venue_settings set value = jsonb_set(value, '{barTabTip}', '"reader"') where key = 'pos'`,
    );
  });
});
