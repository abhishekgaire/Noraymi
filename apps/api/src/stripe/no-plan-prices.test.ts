import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_PROMO_CODE } from "./fake/index.js";

/**
 * O-04 · "No price or promo code is written in our code or settings" (D94,
 * D114): the plans' amounts and the promotion codes live only in Stripe. This
 * reads every source file of the apps and packages (tests and the fake Stripe
 * aside, which make their own fixtures) for the blueprint's proposed amounts,
 * a Stripe promotion code id, and the fake's test code.
 */
const ROOT = resolve(import.meta.dirname, "../../../..");
const DIRS = ["apps", "packages"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".next", ".next-e2e", "build", "release"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|json)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("plan prices and promo codes live only in Stripe (O-04)", () => {
  it("no source file names a plan amount, a promotion code id or the fake's code", () => {
    const files = DIRS.flatMap((d) => sources(join(ROOT, d))).filter(
      (f) => !f.includes(`${join("stripe", "fake")}`) && f.includes(`${join("", "src", "")}`),
    );
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    const pattern = new RegExp(
      String.raw`\$(149|249|349)\b|\b(14900|24900|34900)\b|\bpromo_1[A-Za-z0-9]{6,}|${FAKE_PROMO_CODE}`,
    );
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (pattern.test(text)) found.push(f.slice(ROOT.length + 1));
    }
    expect(found).toEqual([]);
  });
});
