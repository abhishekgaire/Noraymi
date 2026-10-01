#!/usr/bin/env node
// pnpm i18n:check (M1-21): every staff string exists in English and Spanish,
// with the same {placeholders}. Runs in CI before the build, reads the catalog
// sources directly, and names each missing key so the fix is one line.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(new URL(".", import.meta.url).pathname, "../packages/shared/src/i18n");
const languages = ["en", "es"];
const pattern = /"([^"\n]+)":\s*\n?\s*"((?:[^"\\]|\\.)*)"/g;

const catalogs = new Map();
for (const lang of languages) {
  const source = readFileSync(resolve(dir, `${lang}.ts`), "utf8");
  const entries = new Map();
  for (const m of source.matchAll(pattern)) entries.set(m[1], m[2]);
  catalogs.set(lang, entries);
}

const holes = (text) =>
  [...text.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");
const problems = [];
const en = catalogs.get("en");
for (const lang of languages) {
  const other = catalogs.get(lang);
  for (const [key, text] of en) {
    if (!other.has(key)) problems.push(`Missing in ${lang}: ${key}`);
    else if (holes(other.get(key)) !== holes(text))
      problems.push(`Placeholders differ in ${lang}: ${key}`);
    else if (other.get(key).trim() === "") problems.push(`Empty in ${lang}: ${key}`);
  }
  for (const key of other.keys()) if (!en.has(key)) problems.push(`Missing in en: ${key}`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`i18n ok: ${en.size} keys in ${languages.join(", ")}`);
