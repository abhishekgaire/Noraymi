/**
 * The payroll export (M7-16; Data model · tip_shares: gratuity is paid as
 * wages, tips are tips). Per person and shift: the hours. Per person and
 * night: the gratuity share in a wages column and card and cash tips in tips
 * columns. Totals at the end. A shift whose tips per hour fall under the rule
 * pack's tip credit is flagged "check tip credit with payroll", a flag only
 * with no wage math (the cautious default while the lawyer answers).
 */
export interface PayrollShift {
  readonly name: string;
  readonly role: string;
  readonly duty: string;
  readonly business_date: string;
  readonly clock_in: string;
  readonly clock_out: string | null;
  readonly break_minutes: number;
  readonly minutes: number;
  /** The person's share of the night's pool, if they're in it. */
  readonly share: {
    readonly gratuity_cents: number;
    readonly card_tip_cents: number;
    readonly cash_tip_cents: number;
  } | null;
}

export interface PayrollRow {
  readonly name: string;
  readonly role: string;
  readonly duty: string;
  readonly business_date: string;
  readonly clock_in: string;
  readonly clock_out: string;
  readonly break_minutes: number;
  readonly hours: string;
  readonly wages_gratuity_cents: number;
  readonly card_tips_cents: number;
  readonly cash_tips_cents: number;
  readonly flag: string;
}

const hours = (minutes: number) =>
  `${Math.floor(minutes / 60)}.${String(Math.round(((minutes % 60) * 100) / 60)).padStart(2, "0")}`;

export function payrollRows(shifts: readonly PayrollShift[], tipCreditCents: number): PayrollRow[] {
  // A night's share sits on the person's first shift of that night, so it's counted once.
  const seen = new Set<string>();
  return shifts.map((s) => {
    const key = `${s.name}|${s.business_date}`;
    const share = s.share && !seen.has(key) ? s.share : null;
    if (s.share) seen.add(key);
    const tips = share ? share.card_tip_cents + share.cash_tip_cents : 0;
    const perHour = s.minutes > 0 ? (tips * 60) / s.minutes : 0;
    return {
      name: s.name,
      role: s.role,
      duty: s.duty,
      business_date: s.business_date,
      clock_in: s.clock_in,
      clock_out: s.clock_out ?? "",
      break_minutes: s.break_minutes,
      hours: hours(s.minutes),
      wages_gratuity_cents: share?.gratuity_cents ?? 0,
      card_tips_cents: share?.card_tip_cents ?? 0,
      cash_tips_cents: share?.cash_tip_cents ?? 0,
      flag:
        share && s.minutes > 0 && perHour < tipCreditCents ? "check tip credit with payroll" : "",
    };
  });
}

export function payrollCsv(rows: readonly PayrollRow[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const m = (c: number) => (c / 100).toFixed(2);
  const out = [
    "Name,Role,Duty,Business date,Clock in,Clock out,Break minutes,Hours,Wages (gratuity),Card tips,Cash tips,Note",
  ];
  for (const r of rows)
    out.push(
      [
        q(r.name),
        r.role,
        r.duty,
        r.business_date,
        r.clock_in,
        r.clock_out,
        String(r.break_minutes),
        r.hours,
        m(r.wages_gratuity_cents),
        m(r.card_tips_cents),
        m(r.cash_tips_cents),
        q(r.flag),
      ].join(","),
    );
  const sum = (k: "wages_gratuity_cents" | "card_tips_cents" | "cash_tips_cents") =>
    rows.reduce((s, r) => s + r[k], 0);
  out.push(
    [
      "Total",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      m(sum("wages_gratuity_cents")),
      m(sum("card_tips_cents")),
      m(sum("cash_tips_cents")),
      "",
    ].join(","),
  );
  return `${out.join("\n")}\n`;
}
