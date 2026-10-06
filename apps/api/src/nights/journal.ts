import { readSetting, type Queryable } from "@west4/db";
import {
  ACCOUNTS,
  journalCsv,
  nightJournal,
  payoutJournal,
  type Account,
  type Journal,
  type NightMoney,
} from "@west4/rules";
import { Temporal, type PaySettings } from "@west4/shared";
import { nightLines, type NightReport } from "./report.js";

/**
 * The nightly accounting journal and Export for QuickBooks (M7-15). The
 * night's journal is posted at the close from the same lines as the Z report,
 * with the money that paid the night's checks (deposits from customer
 * deposits, cards into Stripe clearing, cash, prepaid value), deposits taken
 * for later nights, Unmatched payments in suspense, the drawers' over or
 * short, and late money for earlier nights with a memo. Each payout gets its
 * own journal. Practice checks and payments never appear (live views only).
 */
export const ACCOUNT_NAMES: Readonly<Record<Account, string>> = {
  sales_room_time: "Sales · Room time",
  sales_drinks: "Sales · Drinks",
  sales_packages: "Sales · Packages",
  sales_songs: "Sales · Songs",
  sales_damage: "Sales · Damage fees",
  sales_deposits_kept: "Sales · Deposits kept",
  sales_min_spend: "Sales · Minimum spend",
  sales_card_surcharge: "Sales · Card surcharge",
  sales_fees: "Sales · Fees",
  comps: "Comps",
  refunds: "Refunds",
  sales_tax_payable: "Sales tax payable",
  gratuity_payable: "Gratuity payable",
  tips_payable: "Tips payable",
  customer_deposits: "Customer deposits",
  prepaid_value: "Prepaid value",
  stripe_clearing: "Stripe clearing",
  cash: "Cash",
  cash_over_short: "Cash over and short",
  unmatched_suspense: "Unmatched payments (suspense)",
  due_from_guests: "Due from guests",
  bank: "Bank",
  stripe_fees: "Stripe fees",
  disputes: "Disputes",
};

export async function buildNightJournal(
  c: Queryable,
  venueId: string,
  date: string,
  report: Pick<NightReport, "adjustments">,
): Promise<Journal> {
  const lines = await nightLines(c, venueId, date);
  // The money that paid the night's checks, one row per payment: a booking's deposit, a card, cash or prepaid.
  const money = (
    await c.query<{ method: string; deposit: boolean; amount: string; tip: string }>(
      `select p.method, p.booking_id is not null as deposit, sum(a.amount_cents)::text as amount,
              p.tip_cents::text as tip
         from payment_allocations a
         join live_payments p on p.venue_id = a.venue_id and p.id = a.payment_id
         join live_checks k on k.venue_id = a.venue_id and k.id = a.check_id
        where a.venue_id = $1 and k.business_date = $2::date and a.state = 'captured'
        group by p.id, p.method, p.booking_id, p.tip_cents`,
      [venueId, date],
    )
  ).rows.map((m): NightMoney => ({
    way: m.deposit
      ? "deposit"
      : m.method === "cash"
        ? "cash"
        : m.method === "prepaid"
          ? "prepaid"
          : "card",
    amount_cents: Number(m.amount),
    tip_cents: m.deposit ? 0 : Number(m.tip),
  }));
  const sums = (
    await c.query<{ taken: string; unmatched: string; over_short: string }>(
      `select
         (select coalesce(sum(amount_cents), 0) from live_payments
           where venue_id = $1 and business_date = $2::date and booking_id is not null
             and status in ('captured', 'partly_refunded', 'refunded'))::text as taken,
         (select coalesce(sum(p.amount_cents), 0) from live_payments p
           where p.venue_id = $1 and p.business_date = $2::date and p.method = 'external' and p.status = 'captured'
             and not exists (select 1 from payment_allocations a where a.venue_id = p.venue_id and a.payment_id = p.id))::text as unmatched,
         (select coalesce(sum(over_short_cents), 0) from drawer_sessions
           where venue_id = $1 and business_date = $2::date and over_short_cents is not null)::text as over_short`,
      [venueId, date],
    )
  ).rows[0]!;
  return nightJournal({
    date,
    lines,
    money,
    deposits_taken_cents: Number(sums.taken),
    unmatched_cents: Number(sums.unmatched),
    over_short_cents: Number(sums.over_short),
    adjustments: report.adjustments,
  });
}

/** The journals of the payouts that arrived on a date. */
export async function payoutJournals(
  c: Queryable,
  venueId: string,
  date: string,
): Promise<Journal[]> {
  const payouts = await c.query<{ id: string; stripe_payout_id: string }>(
    "select id, stripe_payout_id from payouts where venue_id = $1 and arrival_date = $2::date order by created_at",
    [venueId, date],
  );
  const out: Journal[] = [];
  for (const p of payouts.rows) {
    const lines = await c.query<{
      type: "charge" | "refund" | "fee" | "unmatched" | "other";
      gross: string;
      fee: string;
      net: string;
    }>(
      "select type, gross_cents::text as gross, fee_cents::text as fee, net_cents::text as net from payout_lines where venue_id = $1 and payout_id = $2",
      [venueId, p.id],
    );
    out.push(
      payoutJournal({
        date,
        payout_id: p.stripe_payout_id,
        lines: lines.rows.map((l) => ({
          type: l.type,
          gross_cents: Number(l.gross),
          fee_cents: Number(l.fee),
          net_cents: Number(l.net),
        })),
      }),
    );
  }
  return out;
}

/** The file for QuickBooks: the venue's own account names where the owner mapped them. */
export async function exportFile(
  c: Queryable,
  venueId: string,
  date: string,
  journals: readonly Journal[],
) {
  const pay = (await readSetting(c, venueId, "pay", Temporal.PlainDate.from(date)))?.value as
    PaySettings | undefined;
  const names = Object.fromEntries(
    Object.entries(pay?.accounting?.accounts ?? {}).filter(([k]) =>
      (ACCOUNTS as readonly string[]).includes(k),
    ),
  ) as Partial<Record<Account, string>>;
  return journalCsv(journals, names, ACCOUNT_NAMES);
}

/** Posted at the close: the night's journal and its file, kept with the close. */
export async function postNightExport(
  c: Queryable,
  venueId: string,
  input: { date: string; report: Pick<NightReport, "adjustments">; userId: string },
): Promise<string> {
  const night = await buildNightJournal(c, venueId, input.date, input.report);
  const journals = [night, ...(await payoutJournals(c, venueId, input.date))];
  const r = await c.query<{ id: string }>(
    `insert into exports (venue_id, kind, business_date, journals, file, created_by)
     values ($1, 'accounting', $2::date, $3, $4, $5) returning id`,
    [
      venueId,
      input.date,
      JSON.stringify(journals),
      await exportFile(c, venueId, input.date, journals),
      input.userId,
    ],
  );
  return r.rows[0]!.id;
}
