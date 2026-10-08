import { writeFileSync } from "node:fs";
import pg from "pg";
import { databaseUrl, withVenue } from "@west4/db";
import { summarize, trialEvidence, trialReport } from "./trial.js";

/**
 * The timed staff trial's results (M9-11; docs/trial/rush-script.md):
 *   pnpm --filter @west4/api trial:report -- --from <ISO time> --to <ISO time>
 *     [--venue west4karaoke] [--title "before go-live"] [--out docs/gate/staff-trial-<date>.md]
 * Reads the practice capture and the rush's room orders in the window and prints the table
 * against the targets. Exits non-zero when a target is missed. Read-only.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = opt("--from");
  const to = opt("--to");
  if (!from || !to)
    throw new Error(
      "usage: trial:report -- --from <ISO> --to <ISO> [--venue slug] [--title t] [--out file]",
    );
  const slug = opt("--venue") ?? "west4karaoke";
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const venue = (
      await pool.query<{ id: string }>("select id from venues where slug = $1", [slug])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const { samples, orders } = await withVenue(
      pool,
      { venueId: venue.id, requestId: "ops:trial-report" },
      (c) => trialEvidence(c, venue.id, new Date(from), new Date(to)),
    );
    const rows = summarize(samples, orders);
    const md = trialReport(
      opt("--title") ?? `${from} to ${to}`,
      rows,
      samples,
      orders.filter((o) => o.acceptedAt === null).length,
    );
    const out = opt("--out");
    if (out) writeFileSync(out, md);
    process.stdout.write(md);
    if (rows.some((r) => r.met === "no")) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
