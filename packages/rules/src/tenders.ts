/**
 * Tender totals for Close the night (F-10; D126; spec 07 · Outside card machine): Stripe's cards,
 * cash, and the venue's own outside card machine, each with its tips. The outside machine's tips
 * are neither Stripe's card tips nor cash tips, and its total is given by person (amount and tip),
 * so the manager can match it against the machine's own batch report. Integer cents throughout.
 */
export interface TenderPayment {
  readonly method: string;
  readonly amount_cents: number;
  readonly tip_cents: number;
  readonly surcharge_cents: number;
  /** Who recorded it (a person's id or name); only the outside machine is broken down by it. */
  readonly taken_by: string | null;
}

export interface TenderTotals {
  readonly card_total_cents: number;
  readonly card_tips_cents: number;
  readonly cash_cents: number;
  readonly cash_tips_cents: number;
  readonly outside_card_cents: number;
  readonly outside_card_tips_cents: number;
  readonly outside_card_total_cents: number;
  readonly outside_card_by_person: Readonly<Record<string, number>>;
}

const STRIPE_CARDS = new Set(["card_present", "card_on_file", "card_online"]);

export function tenderTotals(payments: readonly TenderPayment[]): TenderTotals {
  let card = 0;
  let cardTips = 0;
  let cash = 0;
  let cashTips = 0;
  let outside = 0;
  let outsideTips = 0;
  const byPerson: Record<string, number> = {};
  for (const p of payments) {
    if (STRIPE_CARDS.has(p.method)) {
      card += p.amount_cents + p.tip_cents + p.surcharge_cents;
      cardTips += p.tip_cents;
    } else if (p.method === "cash") {
      cash += p.amount_cents;
      cashTips += p.tip_cents;
    } else if (p.method === "outside_card") {
      outside += p.amount_cents;
      outsideTips += p.tip_cents;
      const who = p.taken_by ?? "unknown";
      byPerson[who] = (byPerson[who] ?? 0) + p.amount_cents + p.tip_cents;
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(byPerson).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    card_total_cents: card,
    card_tips_cents: cardTips,
    cash_cents: cash,
    cash_tips_cents: cashTips,
    outside_card_cents: outside,
    outside_card_tips_cents: outsideTips,
    outside_card_total_cents: outside + outsideTips,
    outside_card_by_person: sorted,
  };
}

/**
 * The outside machine's note (D126): a last 4 or an approval code, at most 40 characters; never a
 * card number. Any run of 13 or more digits, even with spaces or dashes between them, is refused,
 * so a full card number can't reach our servers or logs. Empty is fine.
 */
export const OUTSIDE_NOTE_MAX = 40;

export function outsideCardNoteOk(note: string | null | undefined): boolean {
  if (note === null || note === undefined || note === "") return true;
  if (note.length > OUTSIDE_NOTE_MAX) return false;
  return !/\d(?:[ -]?\d){12,}/.test(note);
}
