import { Temporal } from "@west4/shared";

/**
 * New York's sales-tax quarters (M7-17; Money rules 2 and 8): Mar–May,
 * Jun–Aug, Sep–Nov and Dec–Feb, by business date. A quarter's last night is
 * Nov 30, Feb 28 or 29, May 31 or Aug 31; its sales from midnight to the 6:00
 * AM cutover fall on the next calendar day and show on their own line.
 */
export interface TaxQuarter {
  /** "2026-Q3" is Sep–Nov 2026; Dec–Feb is named for the December's year ("2026-Q4" runs to Feb 2027). */
  readonly label: string;
  readonly start: string;
  readonly end: string;
}

export function taxQuarterOf(businessDate: string): TaxQuarter {
  const d = Temporal.PlainDate.from(businessDate);
  // Months 3–5 → Q1, 6–8 → Q2, 9–11 → Q3, 12 and 1–2 → Q4 (named for December's year).
  const q =
    d.month >= 3 && d.month <= 5
      ? 1
      : d.month >= 6 && d.month <= 8
        ? 2
        : d.month >= 9 && d.month <= 11
          ? 3
          : 4;
  const year = q === 4 && d.month <= 2 ? d.year - 1 : d.year;
  const firstMonth = [3, 6, 9, 12][q - 1]!;
  const start = Temporal.PlainDate.from({ year, month: firstMonth, day: 1 });
  const end = start.add({ months: 3 }).subtract({ days: 1 });
  return { label: `${year}-Q${q}`, start: start.toString(), end: end.toString() };
}
