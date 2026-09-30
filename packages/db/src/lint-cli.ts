import path from "node:path";
import { migrationsDir } from "./config.js";
import { formatFinding, lintDirectory, lintFiles } from "./lint/index.js";

// pnpm db:lint [files...] · lints packages/db/migrations by default.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const findings =
    args.length === 0
      ? await lintDirectory(migrationsDir)
      : await lintFiles(args.map((a) => path.resolve(a)));
  for (const finding of findings) {
    process.stderr.write(
      `${formatFinding({ ...finding, file: path.relative(process.cwd(), finding.file) })}\n`,
    );
  }
  if (findings.length > 0) {
    process.stderr.write(`${findings.length} migration lint finding(s)\n`);
    process.exit(1);
  }
  process.stdout.write("migrations pass the linter\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
