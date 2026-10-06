import type { ReportLine } from "./night-report.js";

/**
 * The nightly accounting journal and each payout's (M7-15; Money rules 11 and
 * 16; Stripe setup 8 and 9). Posted at the close from the same lines as the Z
 * report to named accounts; debits always equal credits to the cent.
 *
 * Cautious defaults the accountant confirms: money in Unmatched payments sits
 * in a suspense liability until it's matched; dispute withdrawals and fees go
 * to a disputes account; voids net against their category's sales; comps and
 * discounts post to comps; what a closed night's checks still owe sits in
 * "due from guests".
 */
export const ACCOUNTS = [
  "sales_room_time",
  "sales_drinks",
  "sales_packages",
  "sales_songs",
  "sales_damage",
  "sales_deposits_kept",
  "sales_min_spend",
  "sales_card_surcharge",
  "sales_fees",
  "comps",
  "refunds",
  "sales_tax_payable",
  "gratuity_payable",
  "tips_payable",
  "customer_deposits",
  "prepaid_value",
  "stripe_clearing",
  "cash",
  "cash_over_short",
  "unmatched_suspense",
  "due_from_guests",
  "bank",
  "stripe_fees",
  "disputes",
] as const;
export type Account = (typeof ACCOUNTS)[number];

export interface JournalLine {
  readonly account: Account;
  /** Sales tax payable is kept by jurisdiction. */
  readonly jurisdiction?: string;
  readonly debit_cents: number;
  readonly credit_cents: number;
  readonly memo?: string;
}

export interface Journal {
  readonly kind: "night" | "payout";
  readonly date: string;
  readonly ref: string;
  readonly lines: readonly JournalLine[];
}

/** Money that paid the night's checks: the way it came in, its amount and its tip. */
export interface NightMoney {
  readonly way: "card" | "cash" | "prepaid" | "deposit";
  readonly amount_cents: number;
  readonly tip_cents: number;
}

export interface NightJournalInput {
  readonly date: string;
  readonly lines: readonly ReportLine[];
  readonly money: readonly NightMoney[];
  /** Deposits taken tonight for later bookings, still held for the guest. */
  readonly deposits_taken_cents: number;
  /** Stripe activity tonight with no check yet. */
  readonly unmatched_cents: number;
  /** The drawers' over (positive) or short (negative), all sessions together. */
  readonly over_short_cents: number;
  /** Late money posted tonight for earlier nights. */
  readonly adjustments: readonly {
    readonly what: "line" | "payment" | "refund" | "tip";
    readonly for_business_date: string;
    readonly amount_cents: number;
  }[];
}

const GRATUITY_REFUND = "Refund · Gratuity";

/** Which sales account a line's category belongs to (voids net against it). */
function salesAccount(l: ReportLine): Account {
  switch (l.kind) {
    case "room_time":
      return "sales_room_time";
    case "item":
    case "transfer_in":
    case "transfer_out":
      return l.is_package ? "sales_packages" : "sales_drinks";
    case "song":
      return "sales_songs";
    case "damage":
      return "sales_damage";
    case "forfeit":
      return "sales_deposits_kept";
    case "fee":
      return l.check_kind === "fee" ? "sales_deposits_kept" : "sales_fees";
    case "min_spend":
      return "sales_min_spend";
    case "card_surcharge":
      return "sales_card_surcharge";
    case "void":
      switch (l.tax_category) {
        case "room_time":
          return "sales_room_time";
        case "song":
          return "sales_songs";
        case "damage":
          return "sales_damage";
        case "drink":
        case "food":
          return "sales_drinks";
        default:
          return "sales_fees";
      }
    default:
      return "sales_fees";
  }
}

class Builder {
  private readonly totals = new Map<
    string,
    { account: Account; jurisdiction?: string; memo?: string; net: number }
  >();
  /** Positive is a credit, negative a debit. */
  credit(account: Account, cents: number, extra: { jurisdiction?: string; memo?: string } = {}) {
    if (cents === 0) return;
    const key = `${account}|${extra.jurisdiction ?? ""}|${extra.memo ?? ""}`;
    const t = this.totals.get(key) ?? { account, ...extra, net: 0 };
    t.net += cents;
    this.totals.set(key, t);
  }
  debit(account: Account, cents: number, extra: { jurisdiction?: string; memo?: string } = {}) {
    this.credit(account, -cents, extra);
  }
  balance(): number {
    return [...this.totals.values()].reduce((s, t) => s + t.net, 0);
  }
  lines(): JournalLine[] {
    return [...this.totals.values()]
      .filter((t) => t.net !== 0)
      .map((t) => ({
        account: t.account,
        ...(t.jurisdiction ? { jurisdiction: t.jurisdiction } : {}),
        debit_cents: t.net < 0 ? -t.net : 0,
        credit_cents: t.net > 0 ? t.net : 0,
        ...(t.memo ? { memo: t.memo } : {}),
      }))
      .sort(
        (a, b) =>
          ACCOUNTS.indexOf(a.account) - ACCOUNTS.indexOf(b.account) ||
          (a.memo ?? "").localeCompare(b.memo ?? ""),
      );
  }
}

export function nightJournal(input: NightJournalInput): Journal {
  const j = new Builder();
  for (const l of input.lines) {
    const a = l.amount_cents;
    switch (l.kind) {
      case "tax":
        j.credit("sales_tax_payable", a, { jurisdiction: l.jurisdiction_code ?? "" });
        break;
      case "gratuity":
        j.credit("gratuity_payable", a);
        break;
      case "comp":
      case "discount":
      case "cash_discount":
        j.debit("comps", -a);
        break;
      case "refund":
        if (l.description === GRATUITY_REFUND) j.debit("gratuity_payable", -a);
        else j.debit("refunds", -a);
        break;
      default:
        j.credit(salesAccount(l), a);
    }
  }
  // The money that paid the night's checks, and the tips on it.
  for (const m of input.money) {
    const into: Account =
      m.way === "card"
        ? "stripe_clearing"
        : m.way === "cash"
          ? "cash"
          : m.way === "prepaid"
            ? "prepaid_value"
            : "customer_deposits";
    j.debit(into, m.amount_cents);
    if (m.tip_cents !== 0) {
      j.debit(m.way === "cash" ? "cash" : "stripe_clearing", m.tip_cents);
      j.credit("tips_payable", m.tip_cents);
    }
  }
  j.debit("stripe_clearing", input.deposits_taken_cents);
  j.credit("customer_deposits", input.deposits_taken_cents);
  j.debit("stripe_clearing", input.unmatched_cents);
  j.credit("unmatched_suspense", input.unmatched_cents);
  // Over adds cash; short takes it away.
  j.debit("cash", input.over_short_cents);
  j.credit("cash_over_short", input.over_short_cents);
  // Late money for earlier nights posts tonight, with a memo naming its night.
  for (const a of input.adjustments) {
    const memo = `for ${a.for_business_date}`;
    if (a.what === "tip") {
      j.debit("stripe_clearing", a.amount_cents, { memo });
      j.credit("tips_payable", a.amount_cents, { memo });
    } else if (a.what === "payment") {
      j.debit("stripe_clearing", a.amount_cents, { memo });
      j.credit("due_from_guests", a.amount_cents, { memo });
    } else if (a.what === "refund") {
      j.debit("refunds", -a.amount_cents, { memo });
      j.credit("stripe_clearing", -a.amount_cents, { memo });
    } else {
      j.credit("sales_fees", a.amount_cents, { memo });
      j.debit("due_from_guests", a.amount_cents, { memo });
    }
  }
  // Whatever the night's checks still owe.
  const left = j.balance();
  j.debit("due_from_guests", left);
  return { kind: "night", date: input.date, ref: `Night ${input.date}`, lines: j.lines() };
}

/** A payout's journal: the bank gets the net, Stripe's fees are expensed, and the clearing account empties by the gross. */
export function payoutJournal(input: {
  readonly date: string;
  readonly payout_id: string;
  readonly lines: readonly {
    readonly type: "charge" | "refund" | "fee" | "unmatched" | "other" | "dispute";
    readonly gross_cents: number;
    readonly fee_cents: number;
    readonly net_cents: number;
  }[];
}): Journal {
  const j = new Builder();
  for (const l of input.lines) {
    j.debit("bank", l.net_cents);
    if (l.type === "fee") j.debit("stripe_fees", -l.gross_cents);
    else if (l.type === "dispute") {
      j.debit("disputes", -l.gross_cents);
      j.debit("stripe_fees", l.fee_cents);
    } else {
      j.debit("stripe_fees", l.fee_cents);
      j.credit("stripe_clearing", l.gross_cents);
    }
  }
  return { kind: "payout", date: input.date, ref: `Payout ${input.payout_id}`, lines: j.lines() };
}

export function isBalanced(j: Journal): boolean {
  const d = j.lines.reduce((s, l) => s + l.debit_cents, 0);
  const c = j.lines.reduce((s, l) => s + l.credit_cents, 0);
  return d === c;
}

/** QuickBooks Online's journal-entry import: one row per line, the journal number shared by its rows. */
export function journalCsv(
  journals: readonly Journal[],
  names: Readonly<Partial<Record<Account, string>>>,
  defaults: Readonly<Record<Account, string>>,
): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const money = (c: number) => (c === 0 ? "" : (c / 100).toFixed(2));
  const rows = ["Journal No,Journal Date,Account,Debits,Credits,Description,Memo"];
  journals.forEach((jn, i) => {
    for (const l of jn.lines) {
      const account = names[l.account] || defaults[l.account];
      rows.push(
        [
          String(i + 1),
          jn.date,
          q(l.jurisdiction ? `${account} · ${l.jurisdiction}` : account),
          money(l.debit_cents),
          money(l.credit_cents),
          q(jn.ref),
          q(l.memo ?? ""),
        ].join(","),
      );
    }
  });
  return `${rows.join("\n")}\n`;
}
