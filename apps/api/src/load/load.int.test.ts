import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Worker,
  generateSigningKey,
  loadDemoSeed,
  parseAuthSecretKey,
  publishRulePack,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  MemoryExporter,
  SEED_NOW,
  SimulatedClock,
  Telemetry,
  newYorkCounty,
  newYorkCountyTaxed,
} from "@west4/shared";
import { setTelemetry } from "../telemetry/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { makePaymentHandlers } from "../payments/run.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeSandboxSettings, fakeStripeSettings } from "../stripe/settings.js";
import { STRIPE_EVENT_KIND, makeStripeEventHandler } from "../stripe/webhooks.js";
import "../payments/webhooks.js";
import { runFridayPeak } from "./run.js";
import { LoadRefused, cardPresenter, setupLoadVenues, type LoadConfig } from "./setup.js";

/**
 * The Friday-night load harness (M8-21), scaled down to run in the suite: two generated venues next
 * to West 4, against a running API on the fake Stripe (answering at sampled delays). Both peak
 * together: rooms order and the bar hears each ring on its live channel, bar rounds go onto rooms
 * and tabs, tabs open on the reader with different cards, the owner reads the 8-week trends, and
 * every device reconnects at once partway; then every room pays by card and every tab closes. The
 * alarm rings within 3 seconds at the 95th percentile, through the storm and the reports, and
 * nothing fails on our side. West 4 is only read, and production is refused.
 */
const KEY = "e".repeat(64);
let db: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let baseUrl = "";
let west4 = "";
let workers: Worker[] = [];
const clock = new SimulatedClock(SEED_NOW);

const west4Rows = async () =>
  (
    await owner.query<{ n: string }>(
      `select (select count(*) from checks where venue_id = $1)::text || '/' ||
              (select count(*) from orders where venue_id = $1)::text || '/' ||
              (select count(*) from payments where venue_id = $1)::text as n`,
      [west4],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  // Traces on, as in production, so each order's trace runs to the alarm (M8-16).
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
  fake = new FakeStripe({ answerDelaysMs: [20, 40, 60, 90] });
  const fakeBase = await fake.start();
  stripe = new StripeClient(fakeStripeSettings(fakeBase)).withSandbox(
    new StripeClient(fakeSandboxSettings(fakeBase)),
  );
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    // The reports' replica (here the same database, through its own pool).
    REPORTS_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
  });
  app = buildApp({ config, clock, stripe, moduleCacheMs: 0, logger: { level: "warn" } });
  await app.ready();
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
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

describe("the Friday-night load test (M8-21)", () => {
  let cfg: LoadConfig;

  it("never runs in production", async () => {
    await expect(
      setupLoadVenues(owner, stripe, {
        env: "production",
        apiUrl: baseUrl,
        count: 1,
        templateSlug: "west4",
        prefix: "load-prod",
        authKey: parseAuthSecretKey(KEY),
        now: clock.now(),
      }),
    ).rejects.toThrow(LoadRefused);
  });

  it("makes its own venues: practice, our test venues, each in its own organization", async () => {
    const template = (
      await owner.query<{ slug: string }>("select slug from venues where id = $1", [west4])
    ).rows[0]!.slug;
    const before = await west4Rows();
    cfg = await setupLoadVenues(owner, stripe, {
      env: "local",
      apiUrl: baseUrl,
      count: 2,
      templateSlug: template,
      prefix: "load-t",
      authKey: parseAuthSecretKey(KEY),
      now: clock.now(),
    });
    expect(cfg.venues.map((v) => v.slug)).toEqual(["load-t-01", "load-t-02"]);
    const rows = await owner.query<{ org: string; flags: string[]; training: boolean }>(
      `select v.org_id::text as org,
              array(select flag from venue_flags f where f.venue_id = v.id and f."on" order by flag) as flags,
              (select bool_and(training) from devices d where d.venue_id = v.id and d.kind = 'bar_computer') as training
         from venues v where v.slug like 'load-t-%' order by v.slug`,
    );
    expect(new Set(rows.rows.map((r) => r.org)).size).toBe(2);
    expect(rows.rows.map((r) => r.flags)).toEqual([
      ["load.test_venue", "synthetic.test_venue"],
      ["load.test_venue", "synthetic.test_venue"],
    ]);
    expect(rows.rows.every((r) => r.training)).toBe(true);
    expect(cfg.venues[0]!.rooms.length).toBeGreaterThan(2);
    expect(cfg.venues[0]!.readers).toHaveLength(2);
    expect(await west4Rows()).toBe(before);
    // A second run never reuses a run's venues.
    await expect(
      setupLoadVenues(owner, stripe, {
        env: "local",
        apiUrl: baseUrl,
        count: 1,
        templateSlug: template,
        prefix: "load-t",
        authKey: parseAuthSecretKey(KEY),
        now: clock.now(),
      }),
    ).rejects.toThrow(/exists/);
  }, 60_000);

  it("rings the bar within 3 s for 95% of orders through the storm and the reports, with no failures", async () => {
    const before = await west4Rows();
    const report = await runFridayPeak(cfg, {
      peakMs: 9_000,
      roomsPerVenue: 3,
      orderEveryMs: 2_000,
      roundEveryMs: 2_000,
      tabsPerVenue: 2,
      reportEveryMs: 1_500,
      stormAtMs: 4_000,
      socketsPerVenue: 4,
      presentCard: cardPresenter(stripe),
    });
    expect(report.failures).toEqual([]);
    expect(report.alarm.count).toBeGreaterThan(5);
    expect(report.alarm.p95).toBeLessThan(3_000);
    expect(report.alarmInStorm.count).toBeGreaterThan(0);
    expect(report.counts.reconnects).toBe(8);
    expect(report.counts.reports).toBeGreaterThan(0);
    // The reports read through their own pool: the replica's (spec 13 · Capacity).
    const replica = await owner.query(
      "select 1 from pg_stat_activity where datname = current_database() and application_name = 'west4-api-reports'",
    );
    expect(replica.rowCount).toBeGreaterThan(0);
    expect(report.counts.tabs).toBe(4);
    // Every room paid by card, and every tab closed to its card.
    expect(report.counts.payments).toBe(2 * 3 + 4);
    expect(report.slowest.length).toBeGreaterThan(0);
    expect(report.passed).toBe(true);
    // Each order's trace closed at the alarm (M8-16); West 4 never moved.
    const traced = await owner.query<{ n: number }>(
      `select count(*)::int as n from order_traces t join venues v on v.id = t.venue_id
        where v.slug like 'load-t-%' and t.rang_at is not null`,
    );
    expect(traced.rows[0]!.n).toBe(report.alarm.count);
    expect(await west4Rows()).toBe(before);
  }, 120_000);
});
