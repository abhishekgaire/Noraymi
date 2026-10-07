import pg from "pg";
import { databaseUrl, withVenue } from "@west4/db";
import { outageEvidence, outageReport } from "./outage-drill.js";

/**
 * The outage drill's report (M8-07; docs/runbooks/outage-drill.md):
 *   pnpm --filter @west4/api outage:record -- --date 2026-10-13 [--venue west4karaoke]
 * prints the report as Markdown: a table per drill for the people running it to fill in (times,
 * banners, what each reader did, screenshots), then what the system recorded that night (the
 * connection events, the offline queue and its replay, the break-glass payments and their
 * matches) and the findings. Exits non-zero while any finding is open. Read-only, as the table
 * owner like the other ops scripts. Paste the output into docs/drills/<date>-outage.md.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const date = arg("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("usage: outage:record -- --date YYYY-MM-DD [--venue slug]");
  const slug = arg("venue") ?? "west4karaoke";
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const venue = (
      await pool.query<{ id: string }>("select id from venues where slug = $1", [slug])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const evidence = await withVenue(
      pool,
      { venueId: venue.id, requestId: "ops:outage-record" },
      (c) => outageEvidence(c, venue.id, date),
    );
    process.stdout.write(outageReport(slug, evidence));
    if (evidence.findings.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
