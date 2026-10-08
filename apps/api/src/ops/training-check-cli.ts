import pg from "pg";
import { databaseUrl, withVenue } from "@west4/db";
import { trainingEvidence, trainingReport } from "./training-check.js";

/**
 * The training check before the first live night (M9-10; docs/trial/training-checklists.md):
 *   pnpm --filter @west4/api training:check -- [--venue west4karaoke] [--allow-device "<name>"]…
 * Prints who and which device is still in training mode and exits non-zero while any is,
 * except devices named with --allow-device (a new hire's phone on purpose). Read-only.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--venue");
  const slug = i >= 0 ? args[i + 1]! : "west4karaoke";
  const allow = args.flatMap((a, j) =>
    a === "--allow-device" && args[j + 1] ? [args[j + 1]!] : [],
  );
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const venue = (
      await pool.query<{ id: string }>("select id from venues where slug = $1", [slug])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const evidence = await withVenue(
      pool,
      { venueId: venue.id, requestId: "ops:training-check" },
      (c) => trainingEvidence(c, venue.id, allow),
    );
    process.stdout.write(trainingReport(slug, evidence));
    if (!evidence.ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
