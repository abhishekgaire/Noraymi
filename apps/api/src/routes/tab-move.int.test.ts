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
import { StripeClient, StripeError, StripeUnknownResult } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { presentCheck } from "../rooms/present.js";

/**
 * Moving a tab into a room, and moving lines between tabs (M6-13; Payment flows · Moving a tab into a
 * room; Money rules 5, 9 and 12): Jess P.'s tab moves into Room 9 as "Moved from Jess P.'s bar tab" lines
 * and her hold is released at once (Marcus's card is saved); Room 9 then presents at $657.26; a cut-off
 * room refuses the move with its reason; 2 × Modelo can't move onto Hana K.'s cut-off tab; a line moved
 * onto a tab raises its hold like a send; Seat 6's tab moved into Room 5 keeps its hold on the room until
 * a card is tapped for Room 5 (process_setup_intent on the simulated reader).
 */
let fault: "decline" | "drop" | "lost" | null = null;
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
      if (path.endsWith("/increment_authorization") && fault === "lost") {
        fault = null;
        throw new StripeUnknownResult("injected: the raise never reached Stripe");
      }
    },
    dropAnswer: (method, path) => {
      if (path.endsWith("/increment_authorization") && fault === "drop") {
        fault = null;
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

const asUser = (method: "GET" | "POST", url: string, payload?: unknown, key?: string) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${url}`,
    headers: key ? { "idempotency-key": key } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const moveToRoom = (tabId: string, session: string) =>
  asUser("POST", `/tabs/${tabId}/move-to-room`, { session_id: ids[session] }, `move-${++n}`);
interface ViewLine {
  id: number;
  kind: string;
  description: string;
  qty: number;
  amount_cents: number;
  reason: string | null;
  moved?: Record<string, string | null>;
}
const checkOf = async (checkId: string) =>
  (await asUser("GET", `/checks/${checkId}`)).json<{
    lines: ViewLine[];
    holds: { name: string; cents: number }[];
    amount_due_cents: number;
    totals: {
      subtotal_cents: number;
      tax_cents: number;
      gratuity_cents: number;
      total_cents: number;
    };
  }>();
const allocations = async (paymentId: string) =>
  (
    await owner.query<{
      check_id: string;
      state: string;
      amount_cents: string;
      follows_lines: boolean;
    }>(
      "select check_id, state, amount_cents, follows_lines from payment_allocations where payment_id = $1 order by created_at, id",
      [paymentId],
    )
  ).rows;
const refusals = async (checkId: string) =>
  (
    await owner.query<{ reason: string; item: string }>(
      "select reason, item from alcohol_refusals where check_id = $1 order by item",
      [checkId],
    )
  ).rows;

describe("Move tab to a room", () => {
  it("refuses alcohol onto a cut-off room with the cut-off's reason, and logs it", async () => {
    const tab = await openTab("Ben T.", "4000000000000077");
    expect((await send(tab.check_id, [{ variant_id: v("modelo"), qty: 1 }])).statusCode).toBe(201);
    await owner.query(
      "update room_sessions set alcohol_cut_off_at = $2, alcohol_cut_off_by = $3, alcohol_cut_off_reason = 'Too drunk' where id = $1",
      [ids["sess_room9"], clock.now().toString(), ids["andy"]],
    );
    const r = await moveToRoom(tab.id, "sess_room9");
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "cut_off",
      details: {
        reason: "cut_off",
        items: ["Modelo"],
        cut_off: { by: "Andy", reason: "Too drunk" },
      },
    });
    expect(await refusals(ids["chk_room9"]!)).toEqual([{ reason: "cut_off", item: "Modelo" }]);
    // Nothing moved, the tab is still open with its hold.
    expect((await listed(tab.id)).hold_cents).toBe(5000);
    expect((await checkOf(tab.check_id)).lines.filter((l) => l.kind === "transfer_out")).toEqual(
      [],
    );
    await owner.query(
      "update room_sessions set alcohol_cut_off_at = null, alcohol_cut_off_by = null, alcohol_cut_off_reason = null where id = $1",
      [ids["sess_room9"]],
    );
  });

  it("Jess P. into Room 9: every line moves, the tab closes as Moved to Room 9, her hold goes at once", async () => {
    // Marcus's deposit saved his Amex ··1005 (stripe:seed backs it with a PaymentIntent).
    await owner.query(
      "update payments set stripe_pi_id = 'pi_seed_marcus' where booking_id = $1 and method = 'card_online'",
      [ids["bk_marcus"]],
    );
    const tab = await openTab("Jess P.", "4000000000004417");
    const round = await send(tab.check_id, [
      { variant_id: v("modelo"), qty: 2 },
      { variant_id: v("jager"), qty: 1 },
    ]);
    expect(round.statusCode, round.body).toBe(201);
    const r = await moveToRoom(tab.id, "sess_room9");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ room: "Room 9", lines: 2, hold: "released" });
    expect(r.json().tab).toMatchObject({
      state: "closed",
      moved_to: { room: "Room 9" },
      reopenable: false,
    });

    const room = await checkOf(ids["chk_room9"]!);
    const moved = room.lines.filter((l) => l.kind === "transfer_in");
    expect(moved.map((l) => [l.qty, l.description, l.amount_cents, l.reason])).toEqual([
      [2, "Modelo", 1800, "Moved from Jess P.'s bar tab"],
      [1, "Jäger Bomb", 1200, "Moved from Jess P.'s bar tab"],
    ]);
    expect(moved[0]!.moved).toEqual({ from_tab: "Jess P.", from_room: null });
    const left = await checkOf(tab.check_id);
    expect(left.lines.filter((l) => l.kind === "transfer_out").map((l) => l.moved)).toEqual([
      { to_tab: null, to_room: "Room 9" },
      { to_tab: null, to_room: "Room 9" },
    ]);
    expect(left.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(0);

    // The hold guarantees nothing now (no allocation anywhere): it's canceled on Stripe at once.
    expect(await allocations(tab.paymentId)).toEqual([]);
    await drain();
    expect((await payment(tab.paymentId)).status).toBe("canceled");
    expect((await intentOf(tab.paymentId))["status"]).toBe("canceled");
    // A moved tab doesn't come back.
    const again = await asUser("POST", `/tabs/${tab.id}/reopen`);
    expect(again.json().error?.details?.reason).toBe("moved_to_room");

    // Room 9 presents with o1 cancelled: $510.00, $45.26 tax, $102.00 gratuity, $657.26, $537.26 left.
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    await withVenue(workerPool, { venueId }, (c) =>
      presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
    );
    const presented = await checkOf(ids["chk_room9"]!);
    expect(presented.totals).toMatchObject({
      subtotal_cents: 51000,
      tax_cents: 4526,
      gratuity_cents: 10200,
      total_cents: 65726,
    });
    expect(presented.amount_due_cents).toBe(53726);
    expect(presented.holds).toEqual([]);
  });
});

describe("Move one drink to another tab (the fix panel's Move)", () => {
  it("2 × Modelo onto Hana K.'s cut-off tab is refused with the reason, and logged", async () => {
    const line = (await checkOf(ids["chk_t1"]!)).lines.find((l) => l.description === "Modelo")!;
    const r = await asUser("POST", `/checks/${ids["chk_t1"]}/lines/${line.id}/move`, {
      tab_id: ids["tab_t4"],
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "cut_off",
      details: { items: ["Modelo"], cut_off: { by: "Andy" } },
    });
    expect(await refusals(ids["chk_t4"]!)).toEqual([{ reason: "cut_off", item: "Modelo" }]);
    const listedHana = (await asUser("GET", "/tabs")).json<{
      tabs: Listed[] & { cut_off: unknown }[];
    }>();
    expect(listedHana.tabs.find((t) => t.id === ids["tab_t4"])).toMatchObject({
      cut_off: { by: "Andy" },
    });
  });

  it("needs no approval, logs on both tabs, and raises the receiving tab's hold like a send", async () => {
    const to = await openTab("Ana R.", "4000000000001234");
    // Tariq A.'s Large bucket · 10 beers ($70.00) passes Ana's $50.00 hold: it grows first.
    const line = (await checkOf(ids["chk_t5"]!)).lines.find((l) => l.amount_cents === 7000)!;
    const r = await asUser("POST", `/checks/${ids["chk_t5"]}/lines/${line.id}/move`, {
      tab_id: to.id,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(await increments(to.paymentId)).toEqual([
      expect.objectContaining({ state: "succeeded", amount_cents: "10000" }),
    ]);
    expect((await payment(to.paymentId)).authorized).toBe(10000);
    const onAna = (await checkOf(to.check_id)).lines.find((l) => l.kind === "transfer_in")!;
    expect(onAna).toMatchObject({ amount_cents: 7000, reason: "Moved from Tariq A.'s bar tab" });
    const offTariq = (await checkOf(ids["chk_t5"]!)).lines.find((l) => l.kind === "transfer_out")!;
    expect(offTariq).toMatchObject({ amount_cents: -7000, reason: "Moved to Ana R.'s bar tab" });
    expect(offTariq.moved).toEqual({ to_tab: "Ana R.", to_room: null });
  });
});

describe("Seat 6's tab into Room 5, a walk-in with no saved card", () => {
  it("keeps its hold on the room's check until a card is tapped for Room 5", async () => {
    const tab = await openTab("Seat 6 · blue jacket", "378282246317712");
    expect((await send(tab.check_id, [{ variant_id: v("modelo"), qty: 1 }])).statusCode).toBe(201);
    const r = await moveToRoom(tab.id, "sess_room5");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ room: "Room 5", hold: "kept" });
    expect(await allocations(tab.paymentId)).toEqual([
      {
        check_id: ids["chk_room5"],
        state: "in_progress",
        amount_cents: "5000",
        follows_lines: true,
      },
    ]);
    await drain();
    expect((await payment(tab.paymentId)).status).toBe("authorized");
    const room = await checkOf(ids["chk_room5"]!);
    expect(room.holds).toEqual([{ tab_id: tab.id, name: "Seat 6 · blue jacket", cents: 5000 }]);
    // The hold is a guarantee: what Room 5 owes so far (its lines; room time comes at present) leaves it out.
    expect(room.amount_due_cents).toBe(900);

    // A card tapped for Room 5: the consent read out, the reader saves it without charging.
    const consent = (await asUser("GET", "/room-card-consent")).json<{
      version_id: string;
      text: string;
    }>();
    expect(consent.text).toContain("Nothing is charged now");
    const reader = fake.objects.get(await stripeReader()) as { action: unknown };
    reader.action = null;
    await owner.query(
      "update device_heartbeats set last_seen_at = $2, offline_since = null where device_id = $1",
      [readerId, clock.now().toString()],
    );
    const tap = await asUser(
      "POST",
      `/checks/${ids["chk_room5"]}/card-tap`,
      { reader_id: readerId, consent_text_version: consent.version_id },
      `tap-${++n}`,
    );
    expect(tap.statusCode, tap.body).toBe(201);
    expect(tap.json()).toMatchObject({ state: "waiting", card: null });
    expect((await allocations(tab.paymentId))[0]!.state).toBe("in_progress");
    await presentCard("4000000000003155");
    const saved = await asUser("POST", `/checks/${ids["chk_room5"]}/card-tap/check-status`);
    expect(saved.json()).toMatchObject({ state: "saved", card: { brand: "visa", last4: "3155" } });
    const row = (
      await owner.query<{ pm: string; read_by: string; si: string }>(
        "select stripe_payment_method_id as pm, consent_read_by as read_by, stripe_setup_intent_id as si from check_cards where check_id = $1",
        [ids["chk_room5"]],
      )
    ).rows[0]!;
    expect(row.read_by).toBe(ids["maya"]);
    expect(row.pm).toMatch(/^pm_/);
    expect(fake.objects.get(row.si)).toMatchObject({ status: "succeeded" });
    // Nothing was charged; the moved hold is released and canceled.
    expect((await allocations(tab.paymentId))[0]!.state).toBe("released");
    await drain();
    expect((await payment(tab.paymentId)).status).toBe("canceled");
    expect((await checkOf(ids["chk_room5"]!)).holds).toEqual([]);
  });
});

describe("settling the room another way (Money rules 12)", () => {
  it("a room paid in cash cancels the hold it was holding for a moved tab", async () => {
    const tab = await openTab("Kim L.", "4000000000005566");
    expect((await send(tab.check_id, [{ variant_id: v("modelo"), qty: 1 }])).statusCode).toBe(201);
    const r = await moveToRoom(tab.id, "sess_room7");
    expect(r.json()).toMatchObject({ room: "Room 7", hold: "kept" });
    await withVenue(workerPool, { venueId }, (c) =>
      presentCheck(c, venueId, ids["chk_room7"]!, { userId: ids["andy"]!, now: clock.now() }),
    );
    const due = (await checkOf(ids["chk_room7"]!)).amount_due_cents;
    expect(due).toBeGreaterThan(900);
    const paid = await asUser(
      "POST",
      `/checks/${ids["chk_room7"]}/payments`,
      { method: "cash", amount_cents: due, tendered_cents: due },
      `cash-${++n}`,
    );
    expect(paid.statusCode, paid.body).toBe(201);
    expect(paid.json()).toMatchObject({ check_status: "paid" });
    expect((await allocations(tab.paymentId)).map((a) => a.state)).toEqual(["released"]);
    await drain();
    expect((await payment(tab.paymentId)).status).toBe("canceled");
  });
});
