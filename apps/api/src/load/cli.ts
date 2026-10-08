import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { databaseUrl, readSeedFile } from "@west4/db";
import { loadConfig } from "../config.js";
import { stripeFromEnv } from "../stripe/client.js";
import { runFridayPeak, type LoadReport } from "./run.js";
import { cardPresenter, serverNow, setupLoadVenues } from "./setup.js";
import { fmtMs } from "./stats.js";

/**
 * The Friday-night load test (M8-21):
 *   pnpm --filter @west4/api load:friday -- --venues 20 --peak-s 1200 --api-url <url> [--prefix <p>]
 *     [--rooms 14] [--order-every-s 240] [--round-every-s 30] [--tabs 6] [--report-every-s 60]
 *     [--storm-at-s <s>] [--sockets 20] [--template <slug>] [--out evidence/load]
 * No .env is read: Stripe must be the fake (FAKE_STRIPE_DELAYS_MS sets its answer times).
 * It makes its own venues (practice, on their organizations' sandboxes) next to the demo seed's,
 * runs the peak against the API at --api-url, writes the report to --out and exits non-zero when
 * the alarm misses 3 seconds at the 95th percentile or anything failed on our side. Never against
 * production: the API, its database and Stripe must be a staging copy or local, with Stripe mocked.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const num = (name: string, fallback: number) => {
    const raw = arg(name);
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} is a number`);
    return n;
  };
  const apiUrl = arg("api-url");
  if (!apiUrl)
    throw new Error("usage: load:friday -- --api-url <url> [--venues 20] [--peak-s 1200] …");
  const config = loadConfig();
  if (config.env === "production") throw new Error("a load test never runs in production");
  // Stripe is mocked (the fake, at delays sampled from real calls): never real keys, even the sandbox's.
  const stripe = stripeFromEnv(config.env);
  if (stripe.settings.mode !== "fake")
    throw new Error("a load test runs on the fake Stripe only: unset the Stripe keys (no .env)");
  const count = num("venues", 20);
  const peakS = num("peak-s", 1200);
  const prefix = arg("prefix") ?? `load-${Date.now().toString(36)}`;
  const owner = new pg.Pool({ connectionString: databaseUrl(), max: 2 });
  let report: LoadReport;
  try {
    const cfg = await setupLoadVenues(owner, stripe, {
      env: config.env,
      apiUrl,
      count,
      templateSlug: arg("template") ?? readSeedFile().venue.slug,
      prefix,
      authKey: config.auth.secretKey,
      now: await serverNow(apiUrl),
    });
    console.warn(`load: made ${cfg.venues.length} venues (${prefix}-01 …)`);
    report = await runFridayPeak(cfg, {
      peakMs: peakS * 1000,
      roomsPerVenue: num("rooms", 14),
      orderEveryMs: num("order-every-s", 240) * 1000,
      roundEveryMs: num("round-every-s", 30) * 1000,
      tabsPerVenue: num("tabs", 6),
      reportEveryMs: num("report-every-s", 60) * 1000,
      stormAtMs: num("storm-at-s", Math.round(peakS / 2)) * 1000,
      socketsPerVenue: num("sockets", 20),
      log: (line) => console.warn(line),
      presentCard: cardPresenter(stripe),
    });
  } finally {
    await owner.end();
  }
  const out = arg("out") ?? "evidence/load";
  mkdirSync(out, { recursive: true });
  const file = path.join(out, `${prefix}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const a = report.alarm;
  console.warn(
    [
      `load: ${report.venues} venues, ${report.counts.orders} orders, ${report.counts.rounds} rounds, ` +
        `${report.counts.tabs} tabs, ${report.counts.payments} payments, ${report.counts.reports} reports, ` +
        `${report.counts.reconnects} reconnects`,
      `order to alarm: p50 ${fmtMs(a.p50)} · p95 ${fmtMs(a.p95)} · max ${fmtMs(a.max)} · ` +
        `${Math.round(a.within * 1000) / 10}% under 3 s · ${a.viaPoll} by the poll`,
      `  in the reconnect storm: p95 ${fmtMs(report.alarmInStorm.p95)} (${report.alarmInStorm.count})` +
        ` · while reports ran: p95 ${fmtMs(report.alarmDuringReports.p95)} (${report.alarmDuringReports.count})`,
      `  slowest: ${report.slowest.map((s) => `${s.venue} ${fmtMs(s.ms)} (${s.via})`).join(", ")}`,
      `reports p95 ${fmtMs(report.reports.p95)} · payments p95 ${fmtMs(report.payments.p95)}`,
      `failures: ${report.failures.length}${report.failures
        .slice(0, 10)
        .map((f) => `\n  ${f.venue} ${f.step}: ${f.what}`)
        .join("")}`,
      `${report.passed ? "PASS" : "FAIL"} · ${file}`,
    ].join("\n"),
  );
  process.exit(report.passed ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
