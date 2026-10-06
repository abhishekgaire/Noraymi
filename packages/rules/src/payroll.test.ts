import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { payrollCsv, payrollRows, type PayrollShift } from "./payroll.js";

const shift = (name: string, extra: Partial<PayrollShift> = {}): PayrollShift => ({
  name,
  role: "bartender",
  duty: "bar",
  business_date: "2026-09-25",
  clock_in: "2026-09-25T16:00:00-04:00",
  clock_out: "2026-09-26T04:30:00-04:00",
  break_minutes: 30,
  minutes: 720,
  share: null,
  ...extra,
});

describe("the payroll export", () => {
  it("puts gratuity in wages and tips in tips, gives managers hours and no share, and totals (golden)", () => {
    const rows = payrollRows(
      [
        shift("Maya S.", {
          share: { gratuity_cents: 30600, card_tip_cents: 6000, cash_tip_cents: 1500 },
        }),
        shift("Diego R.", {
          role: "front_desk",
          duty: "front_desk",
          clock_in: "2026-09-25T19:00:00-04:00",
          minutes: 540,
          share: { gratuity_cents: 20400, card_tip_cents: 1000, cash_tip_cents: 0 },
        }),
        shift("Andy C.", {
          role: "manager",
          duty: "manager",
          clock_in: "2026-09-25T18:00:00-04:00",
          minutes: 630,
        }),
      ],
      565,
    );
    expect(payrollCsv(rows)).toBe(
      [
        "Name,Role,Duty,Business date,Clock in,Clock out,Break minutes,Hours,Wages (gratuity),Card tips,Cash tips,Note",
        "Maya S.,bartender,bar,2026-09-25,2026-09-25T16:00:00-04:00,2026-09-26T04:30:00-04:00,30,12.00,306.00,60.00,15.00,",
        "Diego R.,front_desk,front_desk,2026-09-25,2026-09-25T19:00:00-04:00,2026-09-26T04:30:00-04:00,30,9.00,204.00,10.00,0.00,check tip credit with payroll",
        "Andy C.,manager,manager,2026-09-25,2026-09-25T18:00:00-04:00,2026-09-26T04:30:00-04:00,30,10.50,0.00,0.00,0.00,",
        "Total,,,,,,,,510.00,70.00,15.00,",
        "",
      ].join("\n"),
    );
  });

  it("adds each share once, so the columns add up to the pools", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            g: fc.integer({ min: 0, max: 100_000 }),
            c: fc.integer({ min: 0, max: 50_000 }),
            k: fc.integer({ min: 0, max: 50_000 }),
            shifts: fc.integer({ min: 1, max: 3 }),
          }),
          { maxLength: 8 },
        ),
        (people) => {
          const shifts = people.flatMap((p, i) =>
            Array.from({ length: p.shifts }, () =>
              shift(`p${i}`, {
                share: { gratuity_cents: p.g, card_tip_cents: p.c, cash_tip_cents: p.k },
              }),
            ),
          );
          const rows = payrollRows(shifts, 565);
          const sum = (key: "wages_gratuity_cents" | "card_tips_cents" | "cash_tips_cents") =>
            rows.reduce((s, r) => s + r[key], 0);
          expect(sum("wages_gratuity_cents")).toBe(people.reduce((s, p) => s + p.g, 0));
          expect(sum("card_tips_cents")).toBe(people.reduce((s, p) => s + p.c, 0));
          expect(sum("cash_tips_cents")).toBe(people.reduce((s, p) => s + p.k, 0));
        },
      ),
    );
  });
});
