import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { databaseUrl, withVenue } from "@west4/db";
import { Temporal } from "@west4/shared";
import { reconcileNight } from "./night.js";

/**
 * The reconcile script (M7-19), after each close and each payout:
 *   pnpm --filter @west4/api reconcile -- --date 2026-09-25 [--venue <id>] [--out evidence/reconcile]
 * Checks every venue's night (or one venue's) to the cent, writes each report as JSON evidence for
 * M7-20, prints one line per venue and exits non-zero on any difference, naming the night and the rule.
 * Runs as the table owner, like the other ops scripts, and only reads.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const date = arg("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("send --date YYYY-MM-DD");
  const out = arg("out") ?? "evidence/reconcile";
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  let failed = false;
  try {
    const venues = arg("venue")
      ? [{ id: arg("venue")! }]
      : (await pool.query<{ id: string }>("select id from venues order by created_at")).rows;
    mkdirSync(out, { recursive: true });
    for (const v of venues) {
      const result = await withVenue(pool, { venueId: v.id, requestId: "ops:reconcile" }, (c) =>
        reconcileNight(c, v.id, date, Temporal.Now.instant()),
      );
      const file = path.join(out, `${date}-${v.id}.json`);
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(
        `${result.ok ? "ok  " : "FAIL"} ${date} ${v.id}: ${result.checked.join(", ")}${
          result.ok
            ? ""
            : ` · ${result.differences.map((d) => `${d.rule}${d.check ? ` ${d.check}` : ""}: ${d.detail}`).join("; ")}`
        } (${file})\n`,
      );
      failed ||= !result.ok;
    }
  } finally {
    await pool.end();
  }
  if (failed) process.exitCode = 1;
}

void main();
