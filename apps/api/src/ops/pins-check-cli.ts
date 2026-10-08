import pg from "pg";
import { databaseUrl, withVenue } from "@west4/db";
import { loadAuthConfig, type West4Env } from "../config.js";
import { pinEvidence, pinReport } from "./pins-check.js";

/**
 * The production PIN check (M9-08; docs/runbooks/pins-and-badges.md):
 *   pnpm --filter @west4/api pins:check -- [--venue west4karaoke]
 * Needs the same AUTH_SECRET_KEY the API runs with (outside local it refuses to run without
 * it). Prints who has a demo PIN or a PIN they didn't set themselves, never a PIN, and exits
 * non-zero while anyone does. Read-only.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--venue");
  const slug = i >= 0 ? args[i + 1]! : "west4karaoke";
  const env = (process.env["WEST4_ENV"] ?? "local") as West4Env;
  const { secretKey } = loadAuthConfig(env, process.env);
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const venue = (
      await pool.query<{ id: string }>("select id from venues where slug = $1", [slug])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const evidence = await withVenue(
      pool,
      { venueId: venue.id, requestId: "ops:pins-check" },
      (c) => pinEvidence(c, venue.id, secretKey),
    );
    process.stdout.write(pinReport(slug, evidence));
    if (!evidence.ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
