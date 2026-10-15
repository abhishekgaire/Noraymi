import type { NightReport } from "./report.js";

/**
 * The month (P-07; Money rules 16): a month's closed nights, each read from
 * the Z report stored at its close and never worked out again, and the month's
 * totals as the plain sum of those nights, so the month equals its Z reports to
 * the cent. Nights not closed yet are left out, and the month in progress says
 * so. Room hours aren't on the Z report: they're the billed (unpaused) minutes
 * of the night's room sessions, practice left out.
 */
export const MONTH_FIGURES = [
  // Sales by category, as the Z report has them.
  "room_time_cents",
  "drinks_room_checks_cents",
  "drinks_bar_tabs_cents",
  "food_cents",
  "packages_cents",
  "songs_cents",
  "damage_cents",
  "kept_deposits_cents",
  "min_spend_cents",
  "card_surcharge_cents",
  "fees_cents",
  "comps_cents",
  "voids_cents",
  "discounts_cents",
  "refunds_cents",
  "net_cents",
  "tax_cents",
  "gratuity_cents",
  // Tips, apart from the gratuity.
  "card_tips_cents",
  "cash_tips_cents",
  "outside_card_tips_cents",
  // How it was paid.
  "cash_cents",
  "card_cents",
  "outside_card_cents",
  "payment_refunds_cents",
  "room_minutes",
] as const;
export type MonthFigure = (typeof MONTH_FIGURES)[number];
export type MonthFigures = Readonly<Record<MonthFigure, number>>;

export interface MonthNight extends MonthFigures {
  readonly business_date: string;
  readonly z_number: number;
}

export interface MonthReport {
  readonly month: string;
  readonly from: string;
  readonly to: string;
  /** The month isn't over (or hasn't started): more nights may still close into it. */
  readonly in_progress: boolean;
  /** Past nights in the month with sales or payments that haven't been closed, so aren't counted. */
  readonly not_closed: readonly string[];
  readonly nights: readonly MonthNight[];
  readonly totals: MonthFigures;
}

const z = (v: number | undefined | null) => v ?? 0;

/** One night's figures from its stored Z report; a figure an older Z report didn't have counts as zero. */
export function nightFigures(r: NightReport, roomMinutes: number): MonthFigures {
  const s = r.sales;
  const p = r.payments;
  return {
    room_time_cents: z(s.room_time_cents),
    drinks_room_checks_cents: z(s.drinks_room_checks_cents),
    drinks_bar_tabs_cents: z(s.drinks_bar_tabs_cents),
    food_cents: z(s.food_cents),
    packages_cents: z(s.packages_cents),
    songs_cents: z(s.songs_cents),
    damage_cents: z(s.damage_cents),
    kept_deposits_cents: z(s.kept_deposits_cents),
    min_spend_cents: z(s.min_spend_cents),
    card_surcharge_cents: z(s.card_surcharge_cents),
    fees_cents: z(s.fees_cents),
    comps_cents: z(s.comps_cents),
    voids_cents: z(s.voids_cents),
    discounts_cents: z(s.discounts_cents),
    refunds_cents: z(s.refunds_cents),
    net_cents: z(s.net_cents),
    tax_cents: z(r.tax_cents),
    gratuity_cents: z(r.gratuity?.total_cents),
    card_tips_cents: z(p?.card_tips_cents),
    cash_tips_cents: z(p?.cash_tips_cents),
    outside_card_tips_cents: z(p?.outside_card_tips_cents),
    cash_cents: z(p?.cash_cents),
    card_cents: z(p?.card_present_cents) + z(p?.card_on_file_cents) + z(p?.card_online_cents),
    outside_card_cents: z(p?.outside_card_cents),
    payment_refunds_cents: z(p?.refunds_cents),
    room_minutes: roomMinutes,
  };
}

/** The month's totals: each figure summed over its nights, integers only. */
export function sumFigures(nights: readonly MonthFigures[]): MonthFigures {
  const out = Object.fromEntries(MONTH_FIGURES.map((k) => [k, 0])) as Record<MonthFigure, number>;
  for (const night of nights) for (const k of MONTH_FIGURES) out[k] += night[k];
  return out;
}

/** Cents as a plain decimal for a spreadsheet ("-12.05"), worked in integers. */
export function decimal(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const LABELS: Record<MonthFigure, string> = {
  room_time_cents: "Room time",
  drinks_room_checks_cents: "Drinks (room checks)",
  drinks_bar_tabs_cents: "Drinks (bar tabs)",
  food_cents: "Food",
  packages_cents: "Packages",
  songs_cents: "Songs",
  damage_cents: "Damage fees",
  kept_deposits_cents: "Deposits kept",
  min_spend_cents: "Minimum spend",
  card_surcharge_cents: "Card fee",
  fees_cents: "Fees",
  comps_cents: "Comps",
  voids_cents: "Voids",
  discounts_cents: "Discounts",
  refunds_cents: "Refunds (sales)",
  net_cents: "Net sales",
  tax_cents: "Sales tax",
  gratuity_cents: "Gratuity",
  card_tips_cents: "Card tips",
  cash_tips_cents: "Cash tips",
  outside_card_tips_cents: "Outside machine tips",
  cash_cents: "Cash",
  card_cents: "Cards",
  outside_card_cents: "Outside card machine",
  payment_refunds_cents: "Refunds (payments)",
  room_minutes: "Room minutes",
};

/** The month as a CSV: one row per closed night, then the total; amounts in dollars, room time in minutes. */
export function monthCsv(r: MonthReport): string {
  const cell = (k: MonthFigure, v: number) => (k === "room_minutes" ? String(v) : decimal(v));
  const out = [["Business date", "Z", ...MONTH_FIGURES.map((k) => LABELS[k])].join(",")];
  for (const night of r.nights)
    out.push(
      [
        night.business_date,
        String(night.z_number),
        ...MONTH_FIGURES.map((k) => cell(k, night[k])),
      ].join(","),
    );
  out.push(
    [
      r.in_progress ? `Total ${r.month} (in progress)` : `Total ${r.month}`,
      "",
      ...MONTH_FIGURES.map((k) => cell(k, r.totals[k])),
    ].join(","),
  );
  return `${out.join("\n")}\n`;
}
