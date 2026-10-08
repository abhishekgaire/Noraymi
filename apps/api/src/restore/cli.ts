import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { databaseName, databaseUrl } from "@west4/db";
import { loadConfig } from "../config.js";
import { makeClock } from "../clock.js";
import { stripeFromEnv } from "../stripe/client.js";
import { FakeVenueClient, TwilioVenueClient, loadVenueTextSettings } from "../texts/venue.js";
import { RestoreRefused, finishRestore, restoreVenue } from "./restore.js";

/**
 * Restore one venue from a scratch copy (M8-20; docs/runbooks/restore-drill.md):
 *
 *   pnpm --filter @west4/api restore:venue -- --venue <slug> --scratch-url <postgres url>
 *     --restore-point <ISO instant> [--drill] [--scratch-ready-s <seconds>] [--pull job]
 *     [--out evidence/restore | -]
 *
 * DATABASE_URL is production as the table owner (the rows go back as
 * app_migrator); APP_DATABASE_URL is production as app_rw (the pull, the
 * erasures, the jobs). The scratch copy is read through the same walls.
 * --drill marks the run as the monthly drill; --scratch-ready-s is how long
 * the cloud took to make the copy, so the time against the target is whole.
 * The pull runs here unless --pull job queues it for the worker. Writes the
 * evidence JSON and exits non-zero when a row was refused, the payments
 * don't match Stripe, or the time missed the target. Production asks for
 * --confirm <slug> as well. When Stripe or Twilio didn't answer during the
 * pull, `--venue <slug> --finish <restore id>` runs the pull and the checks again.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const slug = arg("venue");
  const finish = arg("finish");
  const scratchUrl = arg("scratch-url");
  const restorePoint = arg("restore-point");
  if (slug && finish) return finishOnly(slug, finish);
  if (!slug || !scratchUrl || !restorePoint || Number.isNaN(Date.parse(restorePoint)))
    throw new Error(
      "usage: restore:venue -- --venue <slug> --scratch-url <url> --restore-point <ISO> [--drill] [--scratch-ready-s N] [--pull job] [--out dir]",
    );
  const config = loadConfig();
  if (config.env === "production" && arg("confirm") !== slug)
    throw new Error(`production: send --confirm ${slug} to restore this venue`);
  const ready = arg("scratch-ready-s");
  const out = arg("out") ?? "evidence/restore";
  const target = new pg.Pool({ connectionString: databaseUrl(), max: 4 });
  const app = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
  const scratch = new pg.Pool({ connectionString: scratchUrl, max: 2 });
  const texts = loadVenueTextSettings(config.env);
  try {
    const venue = (
      await target.query<{ id: string }>("select id from venues where slug = $1", [slug])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const report = await restoreVenue(
      {
        target,
        app,
        scratch,
        clock: makeClock(config, app),
        stripe: stripeFromEnv(config.env),
        venueTexts: {
          client:
            texts.mode === "twilio"
              ? new TwilioVenueClient(texts.twilioBaseUrl)
              : new FakeVenueClient(),
          secretKey: config.auth.secretKey,
          settings: { allowList: texts.allowList },
        },
        log: (line) => process.stdout.write(`${line}\n`),
      },
      {
        venueId: venue.id,
        kind: args.includes("--drill") ? "drill" : "restore",
        restorePoint: new Date(restorePoint).toISOString(),
        scratchName: databaseName(scratchUrl),
        ...(ready ? { scratchReadyS: Number(ready) } : {}),
        pull: arg("pull") === "job" ? "job" : "now",
        afterTable: (table, i, of) => {
          if (i % 20 === 0 || i === of) process.stdout.write(`  ${i}/${of} tables (${table})\n`);
        },
      },
    );
    // "--out -" prints the evidence instead (a one-off task's log keeps it).
    let file = "printed above";
    if (out === "-") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      mkdirSync(out, { recursive: true });
      file = path.join(out, `${new Date().toISOString().slice(0, 10)}-${slug}-${report.kind}.json`);
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    }
    const refused = Object.entries(report.counts.skipped);
    const problems = [
      ...refused.map(([t, s]) => `${t}: ${s.rows} rows refused (${s.reason})`),
      ...(report.stripeCheck && !report.stripeCheck.match
        ? [
            `payments don't match Stripe: ${report.stripeCheck.ours.count} for ${report.stripeCheck.ours.cents}¢ here, ${report.stripeCheck.stripe.count} for ${report.stripeCheck.stripe.cents}¢ at Stripe`,
          ]
        : []),
      ...(report.target.withinTarget === false
        ? [`${report.timings.totalS} s is past the ${report.target.rtoS} s target`]
        : []),
    ];
    process.stdout.write(
      `${problems.length ? "FAIL" : "ok  "} ${report.kind} ${slug} to ${report.restorePoint}: ` +
        `${Object.values(report.counts.inserted).reduce((a, b) => a + b, 0)} rows back, ` +
        `${report.erasures?.reapplied ?? "queued"} erasures again, ` +
        `${report.timings.totalS ?? "?"} s of ${report.target.rtoS} s (${file})\n` +
        problems.map((p) => `  ${p}\n`).join(""),
    );
    if (problems.length) process.exitCode = 1;
  } catch (e) {
    if (e instanceof RestoreRefused) {
      process.stdout.write(`REFUSED\n${e.problems.map((p) => `  ${p}\n`).join("")}`);
      process.exitCode = 1;
    } else throw e;
  } finally {
    await Promise.all([target.end(), app.end(), scratch.end()]);
  }
}

/** `--venue <slug> --finish <restore id>`: the pull, the erasures and the checks again, after Stripe or Twilio didn't answer. */
async function finishOnly(slug: string, restoreId: string): Promise<void> {
  const config = loadConfig();
  const app = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
  const texts = loadVenueTextSettings(config.env);
  try {
    const venue = (await app.query<{ id: string }>("select resolve_venue_slug($1) as id", [slug]))
      .rows[0];
    if (!venue?.id) throw new Error(`no venue ${slug}`);
    const done = await finishRestore(
      {
        app,
        clock: makeClock(config, app),
        stripe: stripeFromEnv(config.env),
        venueTexts: {
          client:
            texts.mode === "twilio"
              ? new TwilioVenueClient(texts.twilioBaseUrl)
              : new FakeVenueClient(),
          secretKey: config.auth.secretKey,
          settings: { allowList: texts.allowList },
        },
      },
      venue.id,
      restoreId,
      { inline: true },
    );
    process.stdout.write(`${JSON.stringify(done, null, 2)}\n`);
    if (done.stripeCheck?.match === false || done.target.withinTarget === false)
      process.exitCode = 1;
  } finally {
    await app.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
