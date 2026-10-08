import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { databaseUrl, withVenue } from "@west4/db";
import { Temporal } from "@west4/shared";
import { auditNight } from "./audit.js";
import { moneyErrorRows } from "./money-error-log.js";
import { recordAudit } from "./audit-job.js";

/**
 * The money audit by hand (M9-15), for a night already past or a rerun after a fix:
 *   pnpm --filter @west4/api money-audit -- --date 2026-09-25 [--venue <id>] [--out evidence/money-audit]
 *     [--record] [--log docs/gate/money-errors.md]
 * Audits every venue's night (or one venue's), writes each result as JSON evidence, prints one line per
 * venue and exits non-zero on any money error. --record keeps the result in money_audits (as `manual`);
 * --log adds one row per error to the money-error log, with the cause, the fix and the sign-off left for
 * a person to fill in. Runs as the table owner, like the reconcile script.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const date = arg("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("send --date YYYY-MM-DD");
  const out = arg("out") ?? "evidence/money-audit";
  const log = arg("log");
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  let failed = false;
  try {
    const venues = arg("venue")
      ? [{ id: arg("venue")! }]
      : (await pool.query<{ id: string }>("select id from venues order by created_at")).rows;
    mkdirSync(out, { recursive: true });
    for (const v of venues) {
      const now = Temporal.Now.instant();
      const result = await withVenue(
        pool,
        { venueId: v.id, requestId: "ops:money-audit" },
        async (c) => {
          const audit = await auditNight(c, v.id, date, now);
          if (args.includes("--record")) await recordAudit(c, v.id, audit, "manual", now);
          return audit;
        },
      );
      const file = path.join(out, `${date}-${v.id}.json`);
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(
        `${result.ok ? "ok  " : "FAIL"} ${date} ${v.id}: ${result.errors.length} money errors · ${result.covered.join(", ")} (${file})\n`,
      );
      if (log && !result.ok) appendFileSync(log, moneyErrorRows(v.id, result));
      failed ||= !result.ok;
    }
  } finally {
    await pool.end();
  }
  if (failed) process.exitCode = 1;
}

void main();
