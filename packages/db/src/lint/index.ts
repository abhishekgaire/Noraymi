import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { emptyCatalog, lintMigration } from "./rules.js";
import type { Catalog, Finding } from "./rules.js";

export { lintMigration, emptyCatalog } from "./rules.js";
export type { Catalog, Finding, RuleId } from "./rules.js";
export * from "./config.js";

/** Lint every .sql file in a folder, in name order, threading the catalog through. */
export async function lintDirectory(
  dir: string,
  catalog: Catalog = emptyCatalog(),
): Promise<Finding[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return lintFiles(
    files.map((f) => path.join(dir, f)),
    catalog,
  );
}

export async function lintFiles(
  files: readonly string[],
  catalog: Catalog = emptyCatalog(),
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    findings.push(...lintMigration(file, source, catalog));
  }
  return findings;
}

export function formatFinding(f: Finding): string {
  return `${f.file}:${f.line}: ${f.rule}: ${f.message}`;
}
