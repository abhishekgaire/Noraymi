import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Money is an integer number of cents, never a float (CLAUDE.md; Money rules 1). U-06 found a tip
 * typed at the reader read as `Math.round(Number(tip) * 100)`; every money field now goes through
 * the shared `parseDollars` and `dollarsText` in @west4/shared. This test keeps the pattern out of
 * the screens' sources: a line that really isn't money (a percent, a bar's width) says so with
 * `money-float-ok: <why>` on the same line or the line above.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const DIRS = [
  "apps/staff/src",
  "apps/console/src",
  "apps/desktop/src",
  "apps/guest/app",
  "apps/guest/lib",
  "apps/guest/components",
];
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "parseFloat", re: /\bparseFloat\(/ },
  { name: "Number(…) * 100", re: /\bNumber\([^)]*\)\s*\*\s*100\b/ },
  { name: "Math.round(… * 100)", re: /\bMath\.round\([^;]*\*\s*100\s*\)/ },
  { name: "toFixed", re: /\.toFixed\(/ },
  { name: "cents / 100", re: /\b\w*(?:[Cc]ents|amount|Amount)\w*\s*\/\s*100\b(?!\s*\))/ },
  { name: "(cents / 100)", re: /\(\s*\w*(?:[Cc]ents|amount|Amount)\w*\s*\/\s*100\s*\)(?!\s*%)/ },
];
const EXCEPTION = "money-float-ok:";

function sources(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

export function floatMoneyLines(text: string): { line: number; pattern: string }[] {
  const lines = text.split("\n");
  const out: { line: number; pattern: string }[] = [];
  lines.forEach((line, i) => {
    if (line.includes(EXCEPTION) || (lines[i - 1] ?? "").includes(EXCEPTION)) return;
    for (const p of PATTERNS) if (p.re.test(line)) out.push({ line: i + 1, pattern: p.name });
  });
  return out;
}

describe("no money through floats in the apps (U-06)", () => {
  it("catches the pattern the review found, and lets a marked exception through", () => {
    expect(floatMoneyLines('const tipCents = Math.round(Number(tip || "0") * 100);')).not.toEqual(
      [],
    );
    expect(floatMoneyLines("const x = (dueCents / 100).toFixed(2);")).not.toEqual([]);
    expect(floatMoneyLines("const d = parseFloat(text);")).not.toEqual([]);
    expect(floatMoneyLines("// money-float-ok: a percent\nconst p = n / 100;")).toEqual([]);
    expect(floatMoneyLines("const tipCents = parseDollars(tip);")).toEqual([]);
  });

  it("finds none in the staff, guest, console and desktop sources", () => {
    const found = DIRS.flatMap((d) =>
      sources(path.join(root, d)).flatMap((file) =>
        floatMoneyLines(readFileSync(file, "utf8")).map(
          (f) => `${path.relative(root, file)}:${f.line} ${f.pattern}`,
        ),
      ),
    );
    expect(found).toEqual([]);
  });
});
