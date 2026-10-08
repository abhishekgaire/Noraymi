import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { databaseUrl } from "./config.js";
import { checkMapping } from "./import/mapping.js";
import { prepareImport, ImportRefused } from "./import/prepare.js";
import { formatReport, ImportInvalid, resolveVenue, runImport } from "./import/load.js";
import { ACCOUNTS, journalCsv, type Account } from "@west4/rules";

/** The accounts' plain names for the opening journal's file; the accountant maps them in QuickBooks. */
const OPENING_ACCOUNT_NAMES = Object.fromEntries(
  ACCOUNTS.map((a) => [
    a,
    a === "customer_deposits"
      ? "Customer deposits"
      : a === "legacy_deposits"
        ? "Deposits held by the old system"
        : a,
  ]),
) as Record<Account, string>;

/**
 * pnpm db:import -- --venue <slug|id> --mapping <file.json> [--dry-run] [--out <dir>] [--batch <n>]
 *                   [--cutover-date <YYYY-MM-DD>] [--links-out <file.csv>] [--link-base <url>]
 *
 * Reads the files a venue exported from its old system with that system's
 * own tools, through a mapping file (docs/runbooks/import.md), and loads them
 * into the venue as the audited migration role. --dry-run rehearses the whole
 * import and rolls it back, keeping only the report. Exits non-zero when a
 * file is refused, a row has a problem, or the result doesn't reconcile.
 *
 * Imported bookings still to come get a manage link (M9-02). The link is a
 * secret: it's printed nowhere and stored only as a hash. --links-out writes
 * them (legacy ref, link) to a file only the operator can read, for the
 * cutover texts; without it they can't be recovered, and a manager reissues
 * a guest's link instead.
 */
const log = (line: string) => process.stdout.write(`${line}\n`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const venueRef = arg("venue");
  const mappingPath = arg("mapping");
  if (!venueRef || !mappingPath) {
    log(
      "usage: pnpm db:import -- --venue <slug|id> --mapping <file.json> [--dry-run] [--out <dir>] [--batch <n>] [--cutover-date <YYYY-MM-DD>] [--links-out <file.csv>] [--link-base <url>]",
    );
    return 2;
  }
  const dryRun = process.argv.includes("--dry-run");
  const { mapping, problems } = checkMapping(JSON.parse(readFileSync(mappingPath, "utf8")));
  if (!mapping) {
    for (const p of problems) log(`${mappingPath}: ${p}`);
    return 1;
  }
  const dir = dirname(resolve(mappingPath));
  const pool = new pg.Pool({
    connectionString: databaseUrl(),
    max: 2,
    application_name: "west4-import",
  });
  try {
    const owner = await pool.connect();
    const venue = await resolveVenue(owner, venueRef).finally(() => owner.release());
    const prepared = prepareImport(
      mapping,
      (f) => readFileSync(join(dir, f), "utf8"),
      venue.timeZone,
    );
    const batch = arg("batch");
    const cutoverDate = arg("cutover-date");
    if (cutoverDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(cutoverDate)) {
      log("--cutover-date is YYYY-MM-DD");
      return 2;
    }
    const { manage_links: links, ...report } = await runImport({
      pool,
      venue,
      prepared,
      dryRun,
      ...(batch ? { batchSize: Number(batch) } : {}),
      ...(cutoverDate ? { cutoverDate } : {}),
      log,
    });
    for (const line of formatReport(report)) log(line);
    const linksOut = arg("links-out");
    if (linksOut && links.length > 0) {
      const base = (arg("link-base") ?? "").replace(/\/$/, "");
      const rows = ["legacy_ref,link", ...links.map((l) => `${l.legacy_ref},${base}/b/${l.token}`)];
      mkdirSync(dirname(resolve(linksOut)), { recursive: true });
      writeFileSync(linksOut, rows.join("\n") + "\n", { mode: 0o600 });
      log(
        `${links.length} manage link(s) written to ${linksOut} (keep it private; delete it after the cutover texts)`,
      );
    }
    const out = arg("out");
    if (out) {
      mkdirSync(out, { recursive: true });
      const file = join(out, `import-${report.mode}-${report.run_id}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      log(`report written to ${file}`);
      if (report.kinds.bookings) {
        const journal = join(out, `opening-journal-${report.run_id}.csv`);
        writeFileSync(journal, journalCsv([report.opening_journal], {}, OPENING_ACCOUNT_NAMES));
        log(`opening journal written to ${journal}`);
      }
    }
    return report.reconciles ? 0 : 1;
  } catch (e) {
    if (e instanceof ImportRefused || e instanceof ImportInvalid) {
      log(e.message);
      return 1;
    }
    throw e;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
