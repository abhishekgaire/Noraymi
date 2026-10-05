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
import { StripeClient } from "../stripe/client.js";
import { FakeStripe, fakeFingerprint } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { tabSlip } from "../tabs/slip.js";
import { moveTab } from "../tabs/state.js";
import { receiptPrintLines } from "../print/ticket.js";

/**
 * Opening a tab card first (M6-06): the consent line and its policy version, a $50.00 hold that asks
 * for incremental authorization and saves the card, the label or the dipped name, one tab per card
 * (Jess P.'s Visa ··4417 opens her tab with no second hold), the Quick sale round moving onto the
 * new tab, the reader offline, parties mode, and the slip's words.
 */
const CONSENT =
  "We'll hold $50 on this card and add to it as you order. We charge your tab when you close out, or at 4:30 AM if it's still open. Add your tip on the reader.";
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
/** The reader is free again (a declined or finished action leaves it so). */
const freeReader = async () => {
  const reader = fake.objects.get(await stripeReader()) as { action: unknown };
  reader.action = null;
};

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
  const stripe = new StripeClient(fakeStripeSettings(fakeBase));
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

describe("the consent line (Payment flows · The consent line)", () => {
  it("is the spec's words from the tab settings, saved once as a policy version", async () => {
    const first = await consent();
    expect(first.text).toBe(CONSENT);
    expect(first.version).toBe(1);
    expect((await consent()).version_id).toBe(first.version_id);
    const row = await owner.query<{ kind: string; text: string }>(
      "select kind, text from policy_versions where id = $1",
      [first.version_id],
    );
    expect(row.rows[0]).toEqual({ kind: "tab_consent", text: CONSENT });
  });

  it("a stale version is refused: the bartender reads the new words", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs`,
      headers: { "idempotency-key": `stale-${++n}` },
      payload: { reader_id: readerId, consent_text_version: ids["maya"] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.reason).toBe("consent_changed");
  });
});

describe("New tab, card first (Payment flows steps 1 and 2)", () => {
  it("a tapped phone with a label: a $50.00 hold with incremental support, and the tab", async () => {
    const r = await open({ label: "Seat 3" });
    expect(r.statusCode, r.body).toBe(201);
    const o = r.json<{ id: string; state: string; payment: { id: string; state: string } }>();
    expect(o.state).toBe("waiting");
    expect(o.payment.state).toBe("waiting");
    const pi = await intentOf(o.payment.id);
    expect(pi).toMatchObject({
      amount: 5000,
      capture_method: "manual",
      setup_future_usage: "off_session",
      payment_method_types: ["card_present"],
      payment_method_options: {
        card_present: { request_incremental_authorization_support: "true" },
      },
    });
    expect(String(pi["customer"])).toMatch(/^cus_/);
    const reader = fake.objects.get(await stripeReader()) as {
      action: { type: string; collect_payment_method: { collect_config: unknown } };
    };
    expect(reader.action.type).toBe("collect_payment_method");
    expect(reader.action.collect_payment_method.collect_config).toEqual({
      skip_tipping: "true",
      allow_redisplay: "limited",
    });

    await presentCard("4242424242424242", "&card_present[wallet]=true");
    await drain();
    const done = await checkStatus(o.id);
    expect(done.state).toBe("opened");
    expect(done.tab?.name).toBe("Seat 3");
    expect(done.card).toEqual({ brand: "Visa", last4: "4242" });
    expect((await intentOf(o.payment.id))["status"]).toBe("requires_capture");

    const tab = await owner.query(
      `select t.state, t.name, t.label, t.card_brand, t.card_last4, t.card_fingerprint, t.hold_cents,
              t.owner_id, t.opened_by, t.consent_read_by, p.kind, p.text, t.payment_id
         from tabs t join policy_versions p on p.id = t.consent_text_version where t.id = $1`,
      [done.tab!.id],
    );
    expect(tab.rows[0]).toMatchObject({
      state: "open",
      name: "Seat 3",
      label: "Seat 3",
      card_brand: "Visa",
      card_last4: "4242",
      card_fingerprint: fakeFingerprint("4242424242424242"),
      hold_cents: 5000,
      owner_id: ids["maya"],
      opened_by: ids["maya"],
      consent_read_by: ids["maya"],
      kind: "tab_consent",
      text: CONSENT,
      payment_id: o.payment.id,
    });
    const pay = await owner.query(
      `select status, authorized_cents::int, incremental_supported, overcapture_supported,
              capture_before is not null as has_capture_before, generated_card_pm
         from payments where id = $1`,
      [o.payment.id],
    );
    // A phone's wallet saves no card.
    expect(pay.rows[0]).toEqual({
      status: "authorized",
      authorized_cents: 5000,
      incremental_supported: true,
      overcapture_supported: true,
      has_capture_before: true,
      generated_card_pm: null,
    });
    const listed = (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/tabs` })).json<{
      tabs: { id: string; card: unknown; hold_cents: number }[];
    }>();
    expect(listed.tabs.find((x) => x.id === done.tab!.id)).toMatchObject({
      card: { brand: "Visa", last4: "4242" },
      hold_cents: 5000,
    });
  });

  it("a dip brings the name, and the card saved from it", async () => {
    await freeReader();
    const r = await open();
    expect(r.statusCode, r.body).toBe(201);
    const o = r.json<{ id: string; payment: { id: string } }>();
    await presentCard("5555555555554444", "&card_present[cardholder_name]=RIVERS/DANA");
    await drain();
    const done = await checkStatus(o.id);
    expect(done.tab?.name).toBe("Dana R.");
    expect(done.card).toEqual({ brand: "Mastercard", last4: "4444" });
    const pay = await owner.query<{ pm: string | null }>(
      "select generated_card_pm as pm from payments where id = $1",
      [o.payment.id],
    );
    expect(pay.rows[0]!.pm).toMatch(/^pm_/);
  });

  it("Open while the guest taps: the label tapped after the hold names the tab", async () => {
    await freeReader();
    const o = (await open()).json<{ id: string }>();
    await presentCard("4111111111111111", "&card_present[wallet]=true");
    await drain();
    const held = await checkStatus(o.id);
    expect(held.tab?.name).toBe("Visa ··1111");
    const named = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/openings/${o.id}/name`,
      payload: { name: null, label: "Seat 7" },
    });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().tab.name).toBe("Seat 7");
    const typed = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/openings/${o.id}/name`,
      payload: { name: "Ana", label: "Seat 7" },
    });
    expect(typed.json().tab.name).toBe("Ana");
  });

  it("tapping Jess P.'s Visa ··4417 opens her tab, with no second hold", async () => {
    await freeReader();
    // Her card as M6-27's real opening records it.
    await owner.query("update tabs set card_fingerprint = $2 where id = $1", [
      ids["tab_t1"],
      fakeFingerprint("4000000000004417"),
    ]);
    const before = await owner.query<{ n: number }>("select count(*)::int as n from tabs");
    const r = await open({ label: "Seat 9" });
    const o = r.json<{ id: string; payment: { id: string } }>();
    await presentCard("4000000000004417");
    await drain();
    const done = await checkStatus(o.id);
    expect(done.state).toBe("existing");
    expect(done.tab).toMatchObject({ id: ids["tab_t1"], name: "Jess P." });
    const pi = await intentOf(o.payment.id);
    // Canceled before it was ever confirmed: no authorization, no charge.
    expect(pi["status"]).toBe("canceled");
    expect(pi["latest_charge"]).toBeNull();
    expect(pi["amount_capturable"]).toBe(0);
    expect(
      (await owner.query<{ n: number }>("select count(*)::int as n from tabs")).rows[0]!.n,
    ).toBe(before.rows[0]!.n);
    expect(done.payment.state).toBe("canceled");
  });

  it("a card whose fingerprint comes only with the hold: the new hold is released at once", async () => {
    await freeReader();
    const r = await open();
    const o = r.json<{ id: string; payment: { id: string } }>();
    await presentCard("4000000000004417", "&card_present[fingerprint_on_confirm]=true");
    await drain();
    const done = await checkStatus(o.id);
    expect(done.state).toBe("existing");
    expect(done.tab?.id).toBe(ids["tab_t1"]);
    await drain();
    expect((await intentOf(o.payment.id))["status"]).toBe("canceled");
    const p = await owner.query<{ status: string }>("select status from payments where id = $1", [
      o.payment.id,
    ]);
    expect(p.rows[0]!.status).toBe("canceled");
  });

  it("drinks rung on Quick sale before the card move onto the new tab, unsent", async () => {
    await freeReader();
    const put = await app.inject({
      method: "PUT",
      url: `/v1/venues/${venueId}/drafts/quick`,
      payload: { lines: [{ variant_id: ids["menu_bud_regular"], qty: 2 }], version: 0 },
    });
    expect(put.statusCode, put.body).toBe(200);
    const r = await open({ name: "Kai" });
    const o = r.json<{ id: string }>();
    await presentCard("4000056655665556");
    await drain();
    const done = await checkStatus(o.id);
    expect(done.tab?.name).toBe("Kai");
    const onTab = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/drafts/${done.tab!.check_id}` })
    ).json<{ lines: { variant_id: string; qty: number }[] }>();
    expect(onTab.lines).toEqual([{ variant_id: ids["menu_bud_regular"], qty: 2 }]);
    const quick = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/drafts/quick` })
    ).json<{ lines: unknown[] }>();
    expect(quick.lines).toEqual([]);
    // Nothing was sent: the tab's check has no drinks yet.
    const lines = await owner.query<{ n: number }>(
      "select count(*)::int as n from check_lines where check_id = $1 and kind = 'item'",
      [done.tab!.check_id],
    );
    expect(lines.rows[0]!.n).toBe(0);
  });

  it("the card never comes: Cancel holds nothing and opens nothing", async () => {
    await freeReader();
    const r = await open({ label: "By the stage" });
    const o = r.json<{ id: string }>();
    const c = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/tabs/openings/${o.id}/cancel`,
      headers: { "idempotency-key": `cancel-${++n}` },
    });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({
      state: "canceled",
      tab: null,
      payment: { state: "canceled" },
    });
  });

  it("with the bar reader offline, no new tabs", async () => {
    await freeReader();
    await owner.query(
      `insert into device_heartbeats (venue_id, device_id, last_seen_at, offline_since)
       values ($1, $2, $3, $3)
       on conflict (venue_id, device_id) do update set offline_since = excluded.offline_since`,
      [venueId, readerId, SEED_NOW.toString()],
    );
    const r = await open({ label: "Seat 2" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("reader_offline");
    await owner.query("delete from device_heartbeats where device_id = $1", [readerId]);
  });

  it("in parties mode, New tab asks for the party size", async () => {
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_at)
       select venue_id, key, version + 1, jsonb_set(value, '{gratuity,auto}', '"parties"'), starts_on, saved_at
         from venue_settings where venue_id = $1 and key = 'pay' order by version desc limit 1`,
      [venueId],
    );
    expect((await consent()).asks_party_size).toBe(true);
    const r = await open({ label: "Seat 4" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.reason).toBe("party_size");
    await owner.query(
      `delete from venue_settings where venue_id = $1 and key = 'pay'
         and version = (select max(version) from venue_settings where venue_id = $1 and key = 'pay')`,
      [venueId],
    );
  });
});

describe("the tab slip (screens N23)", () => {
  it("prints the same consent line the bartender read out", async () => {
    const tab = await owner.query<{ id: string }>("select id from tabs where name = 'Dana R.'");
    const slip = await withVenue(workerPool, { venueId, requestId: "slip" }, (c) =>
      tabSlip(c, venueId, tab.rows[0]!.id, SEED_NOW),
    );
    expect(slip.consent).toBe(CONSENT);
    const printed = receiptPrintLines({ lines: slip.lines }, { reprintN: 0 });
    expect(printed.every((l) => l.length <= 32)).toBe(true);
    expect(printed.join(" ").replace(/\s+/g, " ")).toContain(CONSENT);
  });
});

describe("the tab state machine, in one function", () => {
  it("writes only the diagram's moves", async () => {
    const tab = (await owner.query<{ id: string }>("select id from tabs where name = 'Ana'"))
      .rows[0]!.id;
    const move = (to: Parameters<typeof moveTab>[3]) =>
      withVenue(workerPool, { venueId, requestId: "move" }, (c) => moveTab(c, venueId, tab, to));
    await expect(move("captured")).rejects.toMatchObject({ code: "invalid_request" });
    expect(await move("tipping")).toBe("open");
    expect(await move("open")).toBe("tipping");
    expect(await move("closed")).toBe("open");
    await expect(move("tipping")).rejects.toMatchObject({ code: "invalid_request" });
    expect(await move("open")).toBe("closed");
  });
});
