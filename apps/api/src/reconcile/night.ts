import { isNightClosed, nightClose, type Queryable } from "@west4/db";
import { drawerTotals, isBalanced, salesReport, type Journal } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { nightLines, type NightReport } from "../nights/report.js";
import { nightTips } from "../tips/pool.js";

/**
 * The reconcile script (M7-19; milestones · M7 Done when): after each close
 * and each payout, every figure is checked against the rows it came from, and
 * any cent off is a difference naming the night, the check and the rule.
 *   z_report      the Z report stored at the close equals the night's lines by category, tax and gratuity
 *   drawers       each session's expected cash equals its moves; its count differs only by its over or short
 *   tip_ledger    the ledger's tips equal the tips on the night's payments; its gratuity equals the gratuity
 *                 lines of the night's paid checks (refunded shares included)
 *   tip_pool      the closed pool's shares add up to its sources, source by source
 *   payouts       each payout's lines add up to the payout
 *   journals      the night's journal and each payout's balance
 *   practice      no practice check, payment or tip reaches any of them
 */
export interface Difference {
  readonly rule: string;
  readonly night: string;
  readonly check?: string;
  readonly detail: string;
}

export interface NightReconcile {
  readonly night: string;
  readonly ok: boolean;
  readonly checked: readonly string[];
  readonly differences: readonly Difference[];
}

const n = (v: string | number | null | undefined) => Number(v ?? 0);

export async function reconcileNight(
  c: Queryable,
  venueId: string,
  date: string,
  now: Temporal.Instant,
): Promise<NightReconcile> {
  const diffs: Difference[] = [];
  const checked: string[] = [];
  const off = (rule: string, detail: string, check?: string) =>
    diffs.push({ rule, night: date, ...(check ? { check } : {}), detail });

  // The Z report as stored, against the lines worked out again.
  const closed = await nightClose(c, venueId, date);
  if (!closed) off("closed", "the night isn't closed: there's no Z report to check");
  else {
    checked.push("z_report");
    const z = closed.totals["report"] as NightReport | undefined;
    const now_ = salesReport(await nightLines(c, venueId, date));
    if (!z) off("z_report", "the close stored no Z report");
    else {
      for (const [k, v] of Object.entries(now_.sales))
        if ((z.sales as Record<string, number>)[k] !== v)
          off(
            "z_report",
            `${k}: Z ${(z.sales as Record<string, number>)[k]} but the lines say ${v}`,
          );
      if (z.tax_cents !== now_.tax_cents)
        off("z_report", `tax: Z ${z.tax_cents} but the lines say ${now_.tax_cents}`);
      if (z.gratuity.total_cents !== now_.gratuity.total_cents)
        off(
          "z_report",
          `gratuity: Z ${z.gratuity.total_cents} but the lines say ${now_.gratuity.total_cents}`,
        );
      for (const [check, cents] of Object.entries(now_.gratuity.by_check))
        if (z.gratuity.by_check[check] !== cents)
          off("z_report", `gratuity line ${z.gratuity.by_check[check]} vs ${cents}`, check);
    }
  }

  // Drawers: expected from the moves, count against it.
  checked.push("drawers");
  const sessions = await c.query<{
    id: string;
    opening: string;
    expected: string | null;
    counted: string | null;
    over_short: string | null;
    state: string;
  }>(
    `select id, opening_cents::text as opening, expected_cents::text as expected, counted_cents::text as counted,
            over_short_cents::text as over_short, state
       from drawer_sessions where venue_id = $1 and business_date = $2::date`,
    [venueId, date],
  );
  for (const s of sessions.rows) {
    const moves = await c.query<{
      kind: "sale" | "refund" | "paid_out" | "drop" | "no_sale" | "tip_out";
      cents: string;
    }>(
      "select kind, amount_cents::text as cents from drawer_moves where venue_id = $1 and drawer_session_id = $2",
      [venueId, s.id],
    );
    const t = drawerTotals(
      n(s.opening),
      moves.rows.map((m) => ({ kind: m.kind, amountCents: n(m.cents) })),
    );
    if (s.state === "open" || s.state === "pulled")
      off("drawers", `session ${s.id} was never counted`);
    else {
      if (n(s.expected) !== t.expectedCents)
        off(
          "drawers",
          `session ${s.id}: stored expected ${s.expected} but its moves give ${t.expectedCents}`,
        );
      if (n(s.counted) - t.expectedCents !== n(s.over_short))
        off(
          "drawers",
          `session ${s.id}: counted ${s.counted} − expected ${t.expectedCents} isn't its over or short ${s.over_short}`,
        );
    }
  }

  // The tip ledger against the money.
  checked.push("tip_ledger");
  const tips = (
    await c.query<{ ledger: string; payments: string }>(
      `select
         (select coalesce(sum(amount_cents), 0) from tip_ledger
           where venue_id = $1 and business_date = $2::date and adjusts_business_date is null
             and source in ('card_tip', 'cash_tip') and payment_id is not null)::text as ledger,
         (select coalesce(sum(p.tip_cents), 0) from live_payments p
           where p.venue_id = $1 and p.business_date = $2::date and p.adjusts_business_date is null
             and p.status in ('captured', 'partly_refunded', 'refunded'))::text as payments`,
      [venueId, date],
    )
  ).rows[0]!;
  const refundedTips = (
    await c.query<{ cents: string }>(
      `select coalesce(sum(amount_cents), 0)::text as cents from tip_ledger
        where venue_id = $1 and business_date = $2::date and refund_id is not null and source <> 'gratuity'`,
      [venueId, date],
    )
  ).rows[0]!.cents;
  if (n(tips.ledger) - n(refundedTips) !== n(tips.payments))
    off(
      "tip_ledger",
      `tips: the ledger has ${n(tips.ledger) - n(refundedTips)} but the night's payments carry ${tips.payments}`,
    );
  const gratuity = (
    await c.query<{ ledger: string; lines: string }>(
      `select
         (select coalesce(sum(amount_cents), 0) from tip_ledger
           where venue_id = $1 and business_date = $2::date and adjusts_business_date is null
             and source = 'gratuity')::text as ledger,
         (select coalesce(sum(l.amount_cents), 0) from live_check_lines l join live_checks k on k.venue_id = l.venue_id and k.id = l.check_id
           where k.venue_id = $1 and k.status = 'paid'
             and ((l.kind = 'gratuity' and k.business_date = $2::date)
               or (l.kind = 'refund' and l.description = 'Refund · Gratuity' and l.business_date = $2::date
                   and l.adjusts_business_date is null)))::text as lines`,
      [venueId, date],
    )
  ).rows[0]!;
  if (n(gratuity.ledger) !== n(gratuity.lines))
    off(
      "tip_ledger",
      `gratuity: the ledger has ${gratuity.ledger} but the paid checks' lines have ${gratuity.lines}`,
    );

  // The closed pool's shares, source by source.
  checked.push("tip_pool");
  const pool = await c.query<{ id: string; status: string }>(
    "select id, status from tip_pools where venue_id = $1 and business_date = $2::date",
    [venueId, date],
  );
  if (pool.rows[0] && pool.rows[0].status !== "open") {
    const t = await nightTips(c, venueId, date, now);
    const sum = (k: "gratuity_cents" | "card_tip_cents" | "cash_tip_cents") =>
      t.shares.reduce((s, x) => s + x[k], 0);
    const unshared = t.unshared_cents;
    const sharedTotal = sum("gratuity_cents") + sum("card_tip_cents") + sum("cash_tip_cents");
    if (sharedTotal + unshared !== t.sources.total_cents)
      off(
        "tip_pool",
        `the shares add up to ${sharedTotal} (and ${unshared} unshared) but the pool holds ${t.sources.total_cents}`,
      );
  }

  // Payouts that arrived on this date, and every journal.
  checked.push("payouts");
  const payouts = await c.query<{
    id: string;
    stripe_payout_id: string;
    amount: string;
    net: string;
  }>(
    `select o.id, o.stripe_payout_id, o.amount_cents::text as amount,
            (select coalesce(sum(l.net_cents), 0) from payout_lines l where l.venue_id = o.venue_id and l.payout_id = o.id)::text as net
       from payouts o where o.venue_id = $1 and o.arrival_date = $2::date`,
    [venueId, date],
  );
  for (const p of payouts.rows)
    if (n(p.amount) !== n(p.net))
      off("payouts", `payout ${p.stripe_payout_id}: lines ${p.net} but the payout is ${p.amount}`);
  checked.push("journals");
  const exportRow = await c.query<{ journals: Journal[] }>(
    "select journals from exports where venue_id = $1 and kind = 'accounting' and business_date = $2::date",
    [venueId, date],
  );
  if (closed && !exportRow.rows[0]) off("journals", "the close posted no journal");
  for (const j of exportRow.rows[0]?.journals ?? [])
    if (!isBalanced(j)) off("journals", `${j.ref} doesn't balance`);

  // Practice reaches nothing.
  checked.push("practice");
  const practice = await c.query<{ id: string }>(
    "select id from checks where venue_id = $1 and business_date = $2::date and training",
    [venueId, date],
  );
  const z = closed?.totals["report"] as NightReport | undefined;
  for (const p of practice.rows)
    if (z && Object.prototype.hasOwnProperty.call(z.gratuity.by_check, p.id))
      off("practice", "a practice check is in the Z report's gratuity", p.id);
  const practiceTips = await c.query(
    `select 1 from tip_ledger t join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and p.training and t.business_date = $2::date`,
    [venueId, date],
  );
  if ((practiceTips.rowCount ?? 0) > 0)
    off("practice", "a practice payment's tip is in the tip ledger");

  if (!(await isNightClosed(c, venueId, date))) checked.length = 0;
  return { night: date, ok: diffs.length === 0, checked, differences: diffs };
}
