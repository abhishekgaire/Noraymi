import pg from "pg";
import { databaseUrl, withVenue } from "@west4/db";
import { hardwareEvidence, hardwareReport } from "./hardware-check.js";

/**
 * The install day's device check (M9-07; docs/runbooks/hardware-install.md):
 *   pnpm --filter @west4/api devices:check -- [--venue west4karaoke]
 * prints the device check as Markdown and exits non-zero while any line is not yet in place.
 * Read-only, as the table owner like the other ops scripts.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--venue");
  const slug = i >= 0 ? args[i + 1]! : "west4karaoke";
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const venue = (
      await pool.query<{ id: string }>("select id from venues where slug = $1", [slug])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const evidence = await withVenue(
      pool,
      { venueId: venue.id, requestId: "ops:devices-check" },
      (c) => hardwareEvidence(c, venue.id),
    );
    process.stdout.write(hardwareReport(slug, evidence));
    if (!evidence.ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
