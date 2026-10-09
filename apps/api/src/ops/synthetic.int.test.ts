import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Worker,
  generateSigningKey,
  loadDemoSeed,
  parseAuthSecretKey,
  pinVerifier,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  newYorkCounty,
  newYorkCountyTaxed,
} from "@west4/shared";
import { MemoryExporter, Telemetry } from "@west4/shared";
import { buildApp } from "../app.js";
import { setTelemetry } from "../telemetry/index.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeSandboxSettings, fakeStripeSettings } from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";
import "../payments/webhooks.js";
import {
  SYNTHETIC_FLAG,
  SYNTHETIC_KIND,
  applySyntheticResult,
  loadSyntheticConfig,
  makeSyntheticHandler,
  runSyntheticCheck,
  scheduleSynthetic,
  type SyntheticConfig,
} from "./synthetic.js";
import { setupSyntheticVenue } from "./synthetic-setup.js";

/**
 * The synthetic check (M8-18), end to end against a running API: our own test venue (a venue of its
 * own, in its own organization, with the synthetic flag on) next to West 4. A synthetic bar device
 * signs a bartender in with a PIN, seats a practice walk-in, a guest joins with the code and
 * orders, the device hears the ring on the live channel and reports it (the order's trace closes),
 * the bartender accepts, and a tap on a simulated reader is paid on the sandbox. Breaking the
 * reader path fails the next run at the payment and pages us; the next good run clears it. West 4's
 * report doesn't move and the rows stay behind the venue wall. And the scheduler queues one run per
 * 5-minute slot during West 4's hours only.
 */
const KEY = "d".repeat(64);
let db: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let fakeBase = "";
let baseUrl = "";
let west4 = "";
let testVenue = "";
let cfg: SyntheticConfig;
let readerStripeId = "";
let workers: Worker[] = [];
const clock = new SimulatedClock(SEED_NOW);
let ids: Record<string, string> = {};

const headerAuth = async (request: { headers: Record<string, unknown> }) => {
  const raw = request.headers["x-test-principal"];
  return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
};
const as = (p: Principal) => ({ "x-test-principal": JSON.stringify(p) });
let testOwner: Principal;
let west4Owner: Principal;

const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await owner.query<T>(sql, params)).rows[0]!;

/** The test venue, as onboarding would leave it: West 4's settings and modules, one room, a soda. */
async function makeTestVenue(): Promise<{ room: string; variant: string; bartender: string }> {
  const org = await one<{ id: string }>(
    "insert into organizations (legal_name) values ('Our own test organization') returning id",
  );
  testVenue = (
    await one<{ id: string }>(
      `insert into venues (org_id, name, slug, time_zone, day_cutover, rule_pack_id)
       select $1, 'Synthetic check', 'synthetic-check', time_zone, day_cutover, rule_pack_id
         from venues where id = $2 returning id`,
      [org.id, west4],
    )
  ).id;
  await owner.query(
    `insert into venue_settings (venue_id, key, version, value, saved_by, starts_on)
     select $1, key, version, value, saved_by, starts_on from venue_settings where venue_id = $2`,
    [testVenue, west4],
  );
  await owner.query(
    `insert into venue_modules (venue_id, module_id, allowed, state)
     select $1, module_id, allowed, state from venue_modules where venue_id = $2`,
    [testVenue, west4],
  );
  const room = await one<{ id: string }>(
    `insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max)
     select $1, 'Test room', size_tier, capacity_min, capacity_max from rooms where venue_id = $2
      order by name limit 1 returning id`,
    [testVenue, west4],
  );
  const cat = await one<{ id: string }>(
    "insert into menu_categories (venue_id, name, tax_category) values ($1, 'Soft drinks', 'drink') returning id",
    [testVenue],
  );
  const item = await one<{ id: string }>(
    "insert into menu_items (venue_id, category_id, name, alcohol) values ($1, $2, 'Club soda', false) returning id",
    [testVenue, cat.id],
  );
  const variant = await one<{ id: string }>(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 300) returning id",
    [testVenue, item.id],
  );
  const person = async (name: string, role: string) => {
    const u = await one<{ id: string }>("insert into users (name) values ($1) returning id", [
      name,
    ]);
    const m = await one<{ id: string }>(
      `insert into memberships (venue_id, user_id, role, status, pin_digits, locale)
       values ($1, $2, $3, 'active', 4, 'en') returning id`,
      [testVenue, u.id, role],
    );
    return { user: u.id, membership: m.id };
  };
  const ops = await person("Synthetic owner", "owner");
  testOwner = {
    kind: "user",
    userId: ops.user,
    session: "passkey",
    memberships: [{ venueId: testVenue, membershipId: ops.membership, role: "owner" }],
  };
  const bartender = await person("Synthetic bartender", "bartender");
  await owner.query("update memberships set pin_verifier = $2 where id = $1", [
    bartender.membership,
    await pinVerifier(parseAuthSecretKey(KEY), testVenue, bartender.membership, "2468"),
  ]);
  return { room: room.id, variant: variant.id, bartender: bartender.membership };
}

const pages = () =>
  owner.query<{ rule: string; key: string; summary: string; cleared_at: string | null }>(
    "select rule, key, summary, cleared_at::text from pages where rule = 'synthetic-check' order by opened_at",
  );

beforeAll(async () => {
  // Traces on, as in production, so the order's trace runs to the alarm (M8-16).
  setTelemetry(new Telemetry({ service: "west4-api", exporter: new MemoryExporter(), flushMs: 0 }));
  db = await createTestDatabase({ migrate: true });
  west4 = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url, max: 4 });
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
  west4Owner = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId: west4, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  };
  const made = await makeTestVenue();

  fake = new FakeStripe();
  fakeBase = await fake.start();
  const sandbox = new StripeClient(fakeSandboxSettings(fakeBase));
  const stripe = new StripeClient(fakeStripeSettings(fakeBase)).withSandbox(sandbox);
  const account = await stripe
    .forTraining(true)
    .call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "acct-synthetic-sandbox",
      params: { display_name: "Synthetic check" },
    });
  await owner.query(
    "update organizations set stripe_training_account_id = $1 where id = (select org_id from venues where id = $2)",
    [account.id, testVenue],
  );

  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
  });
  app = buildApp({
    config,
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [headerAuth],
    logger: { level: "warn" },
  });
  await app.ready();
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  // A simulated reader at the test venue (practice), registered as its owner.
  const reader = await app.inject({
    method: "POST",
    url: `/v1/venues/${testVenue}/readers`,
    headers: as(testOwner),
    payload: { registration_code: "simulated-s710", label: "Synthetic S710", practice: true },
  });
  expect(reader.statusCode, reader.body).toBe(201);
  const readerId = reader.json<{ id: string }>().id;
  readerStripeId = (
    await one<{ s: string }>("select stripe_reader_id as s from devices where id = $1", [readerId])
  ).s;

  // synthetic:setup: West 4 is refused (it has live checks); the test venue gets its flag, a
  // synthetic bar computer in training with a fresh key, and the secret names its room, reader, soda.
  await expect(
    setupSyntheticVenue(workerPool, {
      venueId: west4,
      membershipId: ids["maya.membership"]!,
      pin: "4071",
      apiUrl: baseUrl,
      by: "test",
    }),
  ).rejects.toThrow(/live checks/);
  cfg = await setupSyntheticVenue(workerPool, {
    venueId: testVenue,
    membershipId: made.bartender,
    pin: "2468",
    apiUrl: baseUrl,
    by: "test",
  });
  expect(cfg).toMatchObject({
    venue_slug: "synthetic-check",
    room_id: made.room,
    reader_id: readerId,
    variant_id: made.variant,
  });
  const device = await one<{ kind: string; training: boolean }>(
    "select kind, training from devices where id = $1",
    [cfg.device_id],
  );
  expect(device).toEqual({ kind: "bar_computer", training: true });

  // The worker's pools: the payment run and Stripe's events, as in production.
  workers = [
    new Worker(workerPool, {
      pool: "critical",
      handlers: makePaymentHandlers({ pool: workerPool, stripe, clock }),
      clock,
      pollMs: 50,
    }),
    new Worker(workerPool, {
      pool: "normal",
      handlers: { [STRIPE_EVENT_KIND]: makeStripeEventHandler(workerPool, stripe) },
      clock,
      pollMs: 50,
    }),
  ];
  for (const w of workers) w.start();
}, 60_000);

afterAll(async () => {
  for (const w of workers) await w.stop();
  await app.close();
  await fake.stop();
  await workerPool.end();
  await owner.end();
  await db.drop();
  setTelemetry(new Telemetry({ service: "west4-api", exporter: null }));
});

const fast = { paymentPollMs: 200, paymentTimeoutMs: 15_000, ringTimeoutMs: 10_000 };

describe("the synthetic order and reader payment (M8-18)", () => {
  let firstOrderCheck = "";

  it("plays the whole path on the test venue: the ring arrives on the live channel, the payment on the sandbox", async () => {
    const reportBefore = await app.inject({
      method: "GET",
      url: `/v1/venues/${west4}/nights/2026-09-25/report`,
      headers: as(west4Owner),
    });
    expect(reportBefore.statusCode, reportBefore.body).toBe(200);

    const r = await runSyntheticCheck(cfg, fast);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, failedStep: null, ringVia: "event" });
    expect(r.orderToAlarmMs!).toBeLessThan(3000);

    // The order's trace closed at the alarm: the order-to-alarm target counts it (M8-16).
    const trace = await one<{ n: number; rang: number }>(
      "select count(*)::int as n, count(rang_at)::int as rang from order_traces where venue_id = $1",
      [testVenue],
    );
    expect(trace).toEqual({ n: 1, rang: 1 });
    // Everything was practice, paid on the sandbox, and the session is over.
    const pay = await one<{ training: boolean; status: string; check_id: string }>(
      `select p.training, p.status, a.check_id from payments p
         join payment_allocations a on a.payment_id = p.id where p.venue_id = $1`,
      [testVenue],
    );
    expect(pay).toMatchObject({ training: true, status: "captured" });
    firstOrderCheck = pay.check_id;
    const chk = await one<{ training: boolean }>("select training from checks where id = $1", [
      pay.check_id,
    ]);
    expect(chk.training).toBe(true);
    const open = await one<{ n: number }>(
      "select count(*)::int as n from room_sessions where venue_id = $1 and ended_at is null",
      [testVenue],
    );
    expect(open.n).toBe(0);
    expect(fake.requests.some((x) => x.livePrefix)).toBe(false);

    // West 4's report hasn't moved.
    const reportAfter = await app.inject({
      method: "GET",
      url: `/v1/venues/${west4}/nights/2026-09-25/report`,
      headers: as(west4Owner),
    });
    const before = reportBefore.json<Record<string, unknown>>();
    const after = reportAfter.json<Record<string, unknown>>();
    // Everything but when each response was made: the report's generated_at, and the server_time
    // (and min_client_version) every JSON response carries (http/conventions.ts). The clock is a
    // ticking SimulatedClock printed to the second, and the run between the two reads takes a second
    // or two of real time, so those fields differ whenever it crosses a second boundary.
    const perResponse = new Set(["generated_at", "server_time", "min_client_version"]);
    const moved = Object.keys(after).filter(
      (k) => !perResponse.has(k) && JSON.stringify(after[k]) !== JSON.stringify(before[k]),
    );
    expect(
      moved,
      moved.map((k) => `${k}: ${JSON.stringify(after[k]).slice(0, 200)}`).join("\n"),
    ).toEqual([]);
  }, 60_000);

  it("the test venue's rows stay behind the venue wall: West 4's context sees none of them", async () => {
    const counts = async (venueId: string) =>
      withVenue(workerPool, { venueId, requestId: "wall" }, async (c) => {
        const n = async (sql: string) =>
          (await c.query<{ n: number }>(sql, [firstOrderCheck])).rows[0]!.n;
        return {
          checks: await n("select count(*)::int as n from checks where id = $1"),
          payments: await n(
            "select count(*)::int as n from payment_allocations where check_id = $1",
          ),
          orders: await n("select count(*)::int as n from orders where check_id = $1"),
        };
      });
    expect(await counts(west4)).toEqual({ checks: 0, payments: 0, orders: 0 });
    expect(await counts(testVenue)).toEqual({ checks: 1, payments: 1, orders: 1 });
  });

  it("breaking the reader path fails the next run at the payment and pages us; the next good run clears it", async () => {
    await fetch(`${fakeBase}/fake/readers/${readerStripeId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "offline" }),
    });
    const broken = await runSyntheticCheck(cfg, fast);
    expect(broken.ok).toBe(false);
    expect(["tap", "test_card", "paid"]).toContain(broken.failedStep);
    // The ordering steps still passed.
    expect(broken.ringVia).toBe("event");
    const { paged } = await applySyntheticResult(workerPool, testVenue, broken, clock.now());
    expect(paged).toBe(true);
    const live = (await pages()).rows.filter((p) => p.cleared_at === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.summary).toContain("(payments)");
    const status = await one<{ auto_state: string }>(
      "select auto_state from status_parts where part = 'ordering'",
    );
    expect(status.auto_state).toBe("operational");
    // Nothing is left open: the stuck practice payment cancelled, the session ended.
    const open = await one<{ n: number }>(
      "select count(*)::int as n from room_sessions where venue_id = $1 and ended_at is null",
      [testVenue],
    );
    expect(open.n).toBe(0);

    await fetch(`${fakeBase}/fake/readers/${readerStripeId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "online" }),
    });
    const good = await runSyntheticCheck(cfg, fast);
    expect(good, JSON.stringify(good)).toMatchObject({ ok: true });
    await applySyntheticResult(workerPool, testVenue, good, clock.now());
    expect((await pages()).rows.filter((p) => p.cleared_at === null)).toHaveLength(0);
  }, 90_000);

  it("a wrong PIN fails at sign-in, and the job refuses a venue without the flag", async () => {
    const r = await runSyntheticCheck({ ...cfg, pin: "1111" }, fast);
    expect(r).toMatchObject({ ok: false, failedStep: "sign_in" });
    const logged: string[] = [];
    const handler = makeSyntheticHandler(workerPool, { ...cfg, venue_id: west4 }, fast, (l) =>
      logged.push(l),
    );
    await handler({
      job: { venue_id: west4 } as never,
      clock,
      step: (work) => withVenue(workerPool, { venueId: west4 }, work),
    });
    expect(logged.join("\n")).toContain("isn't the test venue");
  }, 30_000);

  it("the scheduler queues one run per 5-minute slot during West 4's hours, none outside", async () => {
    const at = (wall: string) =>
      Temporal.ZonedDateTime.from(`${wall}[America/New_York]`).toInstant();
    const jobs = () =>
      owner.query<{ dedupe_key: string }>(
        "select dedupe_key from jobs where kind = $1 order by created_at",
        [SYNTHETIC_KIND],
      );
    // Fri 10:41 PM: West 4 is open.
    expect(await scheduleSynthetic(workerPool, cfg, at("2026-09-25T22:41"))).not.toBeNull();
    expect(await scheduleSynthetic(workerPool, cfg, at("2026-09-25T22:44"))).toBeNull();
    expect(await scheduleSynthetic(workerPool, cfg, at("2026-09-25T22:45"))).not.toBeNull();
    // Sat 10:00 AM: closed. The test venue's own hours (copied from West 4) don't count.
    expect(await scheduleSynthetic(workerPool, cfg, at("2026-09-26T10:00"))).toBeNull();
    const queued = (await jobs()).rows.map((r) => r.dedupe_key);
    expect(queued).toEqual([
      `synthetic:${at("2026-09-25T22:40").toString()}`,
      `synthetic:${at("2026-09-25T22:45").toString()}`,
    ]);
    // Without the flag nothing is queued, even in hours.
    await owner.query(`update venue_flags set "on" = false where venue_id = $1 and flag = $2`, [
      testVenue,
      SYNTHETIC_FLAG,
    ]);
    expect(await scheduleSynthetic(workerPool, cfg, at("2026-09-25T23:00"))).toBeNull();
    await owner.query(`update venue_flags set "on" = true where venue_id = $1 and flag = $2`, [
      testVenue,
      SYNTHETIC_FLAG,
    ]);
  });

  it("SYNTHETIC_CHECK: unset is off; a bad secret names its fields", () => {
    expect(loadSyntheticConfig({})).toBeNull();
    expect(loadSyntheticConfig({ SYNTHETIC_CHECK: JSON.stringify(cfg) })).toEqual(cfg);
    expect(() => loadSyntheticConfig({ SYNTHETIC_CHECK: '{"api_url":"x"}' })).toThrow(/api_url/);
  });
});
