import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { databaseUrl } from "./config.js";
import { checkMapping } from "./import/mapping.js";
import { prepareImport, ImportRefused } from "./import/prepare.js";
import { formatReport, ImportInvalid, resolveVenue, runImport } from "./import/load.js";

/**
 * pnpm db:import -- --venue <slug|id> --mapping <file.json> [--dry-run] [--out <dir>] [--batch <n>]
 *
 * Reads the files a venue exported from its old system with that system's
 * own tools, through a mapping file (docs/runbooks/import.md), and loads them
 * into the venue as the audited migration role. --dry-run rehearses the whole
 * import and rolls it back, keeping only the report. Exits non-zero when a
 * file is refused, a row has a problem, or the result doesn't reconcile.
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
      "usage: pnpm db:import -- --venue <slug|id> --mapping <file.json> [--dry-run] [--out <dir>] [--batch <n>]",
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
    const report = await runImport({
      pool,
      venue,
      prepared,
      dryRun,
      ...(batch ? { batchSize: Number(batch) } : {}),
      log,
    });
    for (const line of formatReport(report)) log(line);
    const out = arg("out");
    if (out) {
      mkdirSync(out, { recursive: true });
      const file = join(out, `import-${report.mode}-${report.run_id}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      log(`report written to ${file}`);
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
