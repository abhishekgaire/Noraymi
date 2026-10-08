import pg from "pg";
import { databaseUrl, withVenue } from "@west4/db";
import { gateCount } from "./gate-week.js";

/**
 * The gate's count by hand (M9-17), for docs/gate/README.md:
 *   pnpm --filter @west4/api gate:status -- [--venue west4karaoke]
 * Live nights audited clean since the last money error, when the run started, the last error and the
 * days to go, from the morning audits. Read-only.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--venue");
  const slug = i >= 0 ? args[i + 1]! : "west4karaoke";
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const venue = (
      await pool.query<{ id: string }>("select id from venues where slug = $1 or id::text = $1", [
        slug,
      ])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const s = await withVenue(pool, { venueId: venue.id, requestId: "ops:gate-status" }, (c) =>
      gateCount(c, venue.id),
    );
    process.stdout.write(
      `${s.met ? "met " : "open"} ${slug}: ${s.cleanNights} clean live nights since ${s.runStartedOn ?? "—"}; last money error ${s.lastErrorOn ?? "none"}; ${s.daysToGo} days to go\n`,
    );
    if (!s.met) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
