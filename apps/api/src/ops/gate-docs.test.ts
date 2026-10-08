import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/** The body rows of the first markdown table after `heading`, as trimmed cells. */
function tableRows(md: string, heading: string): string[][] {
  const start = md.indexOf(heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const lines = md.slice(start).split("\n");
  const first = lines.findIndex((l) => l.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  }
  return rows;
}

describe("gate item 2: the advisers' sign-offs register (M9-13)", () => {
  const spec = read("docs/spec/14-open-questions.md");
  const register = read("docs/gate/sign-offs.md");
  const decisions = read("docs/decisions.md");
  const rows = tableRows(register, "## The register");

  const gateQuestions = spec
    .split("\n")
    .filter((l) => l.startsWith("| "))
    .map((l) =>
      l
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    )
    .filter(
      ([, , who, blocks]) =>
        /· gate/.test(blocks ?? "") && /^(Accountant|Lawyer|PCI assessor)/.test(who ?? ""),
    )
    .map(([q]) => q);

  it("lists exactly the spec's ten adviser questions marked gate, word for word", () => {
    expect(gateQuestions).toHaveLength(10);
    expect(rows.map((r) => r[1]).sort()).toEqual([...gateQuestions].sort());
    expect(rows.map((r) => r[0])).toEqual(rows.map((_, i) => `S${i + 1}`));
  });

  it("every row names a cautious default and how an answer is applied", () => {
    for (const r of rows) {
      expect(r[3], r[0]).not.toBe("");
      expect(r[4], r[0]).not.toBe("");
      expect(["not sent", "sent", "answered", "applied"], r[0]).toContain(r[5]);
    }
  });

  it("a row is answered only with a date and a decision row that exists", () => {
    for (const r of rows) {
      if (r[5] !== "answered" && r[5] !== "applied") {
        expect(r[6], `${r[0]} has a date but no answer`).toBe("");
        continue;
      }
      expect(r[6], r[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r[7], r[0]).toMatch(/^D\d+$/);
      expect(decisions, `${r[0]} → ${r[7]}`).toContain(`| ${r[7]} |`);
    }
  });

  it("gate item 2 is marked met only when all ten are applied", () => {
    const met = /\*\*Gate item 2:\*\* met/.test(register);
    expect(met).toBe(rows.every((r) => r[5] === "applied"));
  });

  it("every question has a request ready to send", () => {
    const requests = read("docs/gate/sign-off-requests.md");
    for (const r of rows) expect(requests, r[0]).toContain(`**${r[0]}.**`);
  });
});

describe("gate items 1 and 4: the must-fix tracker (M9-14)", () => {
  const tracker = read("docs/gate/must-fix.md");
  const sections = tracker.split(/\n(?=## GA-M\d+ )/).slice(1);
  const field = (s: string, name: string): string =>
    (new RegExp(`- \\*\\*${name}:\\*\\* (.*)`).exec(s)?.[1] ?? "").trim();

  it("has GA-M1 to GA-M11 in order, each with its milestone, status and evidence", () => {
    expect(sections.map((s) => /^## (GA-M\d+)/.exec(s)?.[1])).toEqual(
      Array.from({ length: 11 }, (_, i) => `GA-M${i + 1}`),
    );
    for (const s of sections) {
      expect(field(s, "Closed by"), s.slice(0, 12)).toMatch(/^M\d/);
      expect(["open", "closed"]).toContain(field(s, "Status"));
      expect(field(s, "Proven locally"), s.slice(0, 12)).toMatch(/\]\(/);
    }
  });

  it("every evidence link resolves to a file in the repo", () => {
    const links = [...tracker.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(30);
    for (const link of links) {
      if (/^https?:/.test(link)) continue;
      expect(existsSync(join(ROOT, "docs/gate", link)), link).toBe(true);
    }
  });

  it("a row is closed only with a date and nothing left waiting", () => {
    for (const s of sections) {
      const closed = field(s, "Status") === "closed";
      expect(/^\d{4}-\d{2}-\d{2}$/.test(field(s, "Closed on")), s.slice(0, 12)).toBe(closed);
      if (closed) expect(field(s, "Waiting on"), s.slice(0, 12)).toBe("nothing");
    }
  });

  it("gate item 1 is met only when all eleven are closed", () => {
    const met = /\*\*Gate item 1 \([^)]*\):\*\* met/.test(tracker);
    expect(met).toBe(sections.every((s) => field(s, "Status") === "closed"));
  });

  it("gate item 4 is met only with M8-07's drill report linked", () => {
    const met = /\*\*Gate item 4 \([^)]*\):\*\* met/.test(tracker);
    const report = /\]\((\.\.\/drills\/\d{4}-\d{2}-\d{2}-outage\.md)\)/.exec(tracker);
    expect(met).toBe(report !== null);
  });
});
