import { describe, expect, it } from "vitest";
import {
  MONTH_FIGURES,
  decimal,
  monthCsv,
  nightFigures,
  sumFigures,
  type MonthReport,
} from "./month.js";
import type { NightReport } from "./report.js";

/** A stored Z report with only what the month reads; an older one may lack the outside machine. */
const zReport = (over: {
  room?: number;
  drinks?: number;
  tax?: number;
  gratuity?: number;
  cash?: number;
  tap?: number;
  outside?: number;
}): NightReport =>
  ({
    sales: {
      room_time_cents: over.room ?? 0,
      drinks_room_checks_cents: over.drinks ?? 0,
      drinks_bar_tabs_cents: 0,
      food_cents: 0,
      packages_cents: 0,
      songs_cents: 0,
      damage_cents: 0,
      kept_deposits_cents: 0,
      min_spend_cents: 0,
      card_surcharge_cents: 0,
      fees_cents: 0,
      comps_cents: -500,
      voids_cents: 0,
      discounts_cents: -1,
      refunds_cents: 0,
      net_cents: (over.room ?? 0) + (over.drinks ?? 0) - 501,
    },
    tax_cents: over.tax ?? 0,
    gratuity: { total_cents: over.gratuity ?? 0 },
    payments: {
      card_present_cents: over.tap ?? 0,
      card_on_file_cents: 1,
      card_online_cents: 2,
      cash_cents: over.cash ?? 0,
      card_tips_cents: 333,
      cash_tips_cents: 7,
      refunds_cents: 0,
      ...(over.outside === undefined
        ? {}
        : { outside_card_cents: over.outside, outside_card_tips_cents: 99 }),
    },
  }) as unknown as NightReport;

describe("the month", () => {
  it("takes Room 9's night from its Z report: $322.00 room time, $42.60 tax, $96.00 gratuity", () => {
    const f = nightFigures(
      zReport({ room: 32200, drinks: 15800, tax: 4260, gratuity: 9600, tap: 49860 }),
      161,
    );
    expect(f).toMatchObject({
      room_time_cents: 32200,
      drinks_room_checks_cents: 15800,
      tax_cents: 4260,
      gratuity_cents: 9600,
      card_cents: 49863,
      card_tips_cents: 333,
      outside_card_cents: 0,
      outside_card_tips_cents: 0,
      room_minutes: 161,
    });
  });

  it("sums every figure over its nights to the cent", () => {
    const a = nightFigures(zReport({ room: 32200, tax: 4260, cash: 12345, outside: 5000 }), 161);
    const b = nightFigures(zReport({ room: 1, tax: 3, cash: 1, outside: 1 }), 59);
    const t = sumFigures([a, b]);
    for (const k of MONTH_FIGURES) expect(t[k]).toBe(a[k] + b[k]);
    expect(t.room_time_cents).toBe(32201);
    expect(t.room_minutes).toBe(220);
    expect(sumFigures([])).toEqual(Object.fromEntries(MONTH_FIGURES.map((k) => [k, 0])));
  });

  it("writes dollars without floats and marks a month in progress", () => {
    expect([decimal(0), decimal(5), decimal(-1205), decimal(61860)]).toEqual([
      "0.00",
      "0.05",
      "-12.05",
      "618.60",
    ]);
    const night = {
      business_date: "2026-09-25",
      z_number: 2,
      ...nightFigures(zReport({ room: 32200 }), 161),
    };
    const r: MonthReport = {
      month: "2026-09",
      from: "2026-09-01",
      to: "2026-09-30",
      in_progress: true,
      not_closed: [],
      nights: [night],
      totals: sumFigures([night]),
    };
    const rows = monthCsv(r).trim().split("\n");
    expect(rows[0]!.startsWith("Business date,Z,Room time,")).toBe(true);
    expect(rows[0]!.endsWith(",Room minutes")).toBe(true);
    expect(rows[1]!.startsWith("2026-09-25,2,322.00,")).toBe(true);
    expect(rows[1]!.endsWith(",161")).toBe(true);
    expect(rows[2]!.startsWith("Total 2026-09 (in progress),,322.00,")).toBe(true);
    expect(rows).toHaveLength(3);
  });
});
