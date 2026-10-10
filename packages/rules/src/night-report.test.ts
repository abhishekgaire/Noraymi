import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cents, percentOf } from "@west4/shared";
import { salesReport, type ReportLine } from "./night-report.js";

const here = path.dirname(fileURLToPath(import.meta.url));
interface ZCase {
  id: string;
  function: string;
  inputs: {
    room_checks: {
      id: string;
      room_time_cents: number;
      drinks_cents: number;
      comps_cents?: number;
    }[];
    bar_tabs: { id: string; drinks_cents: number }[];
    training_checks: { id: string; room_time_cents: number; drinks_cents: number }[];
  };
  expected: {
    room_check_gratuity_lines_cents: Record<string, number>;
    z_gratuity_cents: number;
    bar_tab_gratuity_cents: number;
    drinks_room_checks_cents: number;
    drinks_bar_tabs_cents: number;
    wrong_20pct_of_all_sales_cents: number;
    excluded_training_checks: string[];
  };
}
const cases = (
  JSON.parse(readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8")) as {
    cases: ZCase[];
  }
).cases.filter((c) => c.function === "z_report_gratuity");

const line = (
  check_id: string,
  check_kind: ReportLine["check_kind"],
  kind: string,
  amount: number,
): ReportLine => ({
  check_id,
  check_kind,
  kind,
  amount_cents: amount,
  tax_category: null,
  jurisdiction_code: null,
  tax_rate: null,
  taxable_base_cents: null,
  description: kind,
});

/** The case's checks as their lines, each room check's gratuity line written as finalizing writes it (20%, half up). */
function linesOf(c: ZCase): ReportLine[] {
  const out: ReportLine[] = [];
  for (const r of c.inputs.room_checks) {
    out.push(line(r.id, "room", "room_time", r.room_time_cents));
    out.push(line(r.id, "room", "item", r.drinks_cents));
    if (r.comps_cents) out.push(line(r.id, "room", "comp", -r.comps_cents));
    const base = r.room_time_cents + r.drinks_cents - (r.comps_cents ?? 0);
    out.push(line(r.id, "room", "gratuity", percentOf(cents(base), 20, 100)));
  }
  for (const b of c.inputs.bar_tabs) out.push(line(b.id, "bar", "item", b.drinks_cents));
  // Practice checks are read from the live views, so they never reach the report: left out here too.
  return out;
}

describe("the night's report", () => {
  it.each(cases.map((c) => [c.id, c] as const))(
    "money case %s through the report function",
    (_id, c) => {
      const r = salesReport(linesOf(c));
      expect(r.gratuity.by_check).toEqual(c.expected.room_check_gratuity_lines_cents);
      expect(r.gratuity.total_cents).toBe(c.expected.z_gratuity_cents);
      expect(r.gratuity.bar_tabs_cents).toBe(c.expected.bar_tab_gratuity_cents);
      expect(r.sales.drinks_room_checks_cents).toBe(c.expected.drinks_room_checks_cents);
      expect(r.sales.drinks_bar_tabs_cents).toBe(c.expected.drinks_bar_tabs_cents);
      for (const t of c.expected.excluded_training_checks)
        expect(r.gratuity.by_check).not.toHaveProperty(t);
      if (c.expected.wrong_20pct_of_all_sales_cents !== c.expected.z_gratuity_cents)
        expect(r.gratuity.total_cents).not.toBe(c.expected.wrong_20pct_of_all_sales_cents);
      expect(r.counts).toEqual({
        rooms: c.inputs.room_checks.length,
        bar_tabs: c.inputs.bar_tabs.length,
      });
    },
  );

  it("groups tax by jurisdiction and rate with its base, and counts a refund's gratuity share against the gratuity", () => {
    const tax = (amount: number, base: number): ReportLine => ({
      ...line("c1", "room", "tax", amount),
      jurisdiction_code: "NY-NYC",
      tax_rate: "0.08875",
      taxable_base_cents: base,
    });
    const r = salesReport([
      line("c1", "room", "room_time", 32200),
      line("c1", "room", "item", 15800),
      tax(2858, 32200),
      tax(1402, 15800),
      line("c1", "room", "gratuity", 9600),
      { ...line("c1", "room", "refund", -240), description: "Refund · Gratuity" },
      line("c1", "room", "refund", -1200),
      line("c1", "room", "transfer_in", 1200),
    ]);
    expect(r.tax).toEqual([
      { jurisdiction: "NY-NYC", rate: "0.08875", taxable_base_cents: 48000, tax_cents: 4260 },
    ]);
    expect(r.gratuity).toMatchObject({ total_cents: 9360, refunded_cents: -240 });
    expect(r.sales).toMatchObject({ refunds_cents: -1200, net_cents: 48000 - 1200 });
  });
});

describe("food on its own line (K-10)", () => {
  const food = (id: string, kind: ReportLine["check_kind"], cents: number): ReportLine => ({
    ...line(id, kind, "item", cents),
    tax_category: "food",
  });
  it("puts food sales on their own line, out of drinks; a package's food stays under Packages", () => {
    const r = salesReport([
      line("r1", "room", "room_time", 10000),
      { ...line("r1", "room", "item", 2400), tax_category: "drink" },
      food("r1", "room", 1800),
      food("t1", "bar", 1599),
      { ...food("r1", "room", 600), is_package: true },
      { ...line("t1", "bar", "void", -500), tax_category: "food" },
    ]);
    expect(r.sales).toMatchObject({
      food_cents: 1800 + 1599,
      drinks_room_checks_cents: 2400,
      drinks_bar_tabs_cents: 0,
      packages_cents: 600,
      voids_cents: -500,
      net_cents: 10000 + 2400 + 1800 + 1599 + 600 - 500,
    });
  });
});
