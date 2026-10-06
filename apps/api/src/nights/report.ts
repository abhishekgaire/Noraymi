import { nightClose, type Queryable } from "@west4/db";
import { drawerTotals, salesReport, type ReportLine, type SalesReport } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { venueClock } from "../rooms/assignment.js";
import { nightTips, type NightTips } from "../tips/pool.js";

/**
 * The night's report (M7-13; Money rules 8, 9, 11, 15 and 16; spec 08 ·
 * Night close `GET /nights/{date}/report`): a running X report until the
 * close, then the Z report stored with the close and never worked out again.
 * Everything is read from the live views, so practice checks and payments
 * never reach a figure. Sales, tax and gratuity come from the night's check
 * lines (`salesReport`); then payments, the drawers, the tip pool, every
 * comp, void and refund, late money posted here for earlier nights, and the
 * night's log, each time with EDT or EST.
 */
export interface NightReport extends SalesReport {
  readonly kind: "x" | "z";
  readonly business_date: string;
  readonly time_zone: string;
  readonly generated_at: string;
  readonly closed: {
    readonly z_number: number;
    readonly closed_at: string;
    readonly closed_by: string | null;
  } | null;
  readonly payments: {
    readonly card_present_cents: number;
    readonly card_on_file_cents: number;
    readonly card_online_cents: number;
    readonly cash_cents: number;
    readonly prepaid_cents: number;
    readonly card_tips_cents: number;
    readonly cash_tips_cents: number;
    readonly refunds_cents: number;
    readonly card_total_cents: number;
    readonly deposits_taken_cents: number;
    readonly deposits_allocated_cents: number;
  };
  readonly drawers: readonly {
    readonly drawer: string;
    readonly owner: string | null;
    readonly state: string;
    readonly opening_cents: number;
    readonly cash_taken_cents: number;
    readonly paid_outs_cents: number;
    readonly drops_cents: number;
    readonly tip_outs_cents: number;
    readonly refunds_cents: number;
    readonly counted_cents: number | null;
    readonly over_short_cents: number | null;
    readonly note: string | null;
  }[];
  readonly tips: NightTips;
  readonly exceptions: readonly {
    readonly at: string;
    readonly time: string;
    readonly kind: "comp" | "void" | "refund";
    readonly where: string;
    readonly what: string;
    readonly why: string | null;
    readonly asked_by: string | null;
    readonly approved_by: string | null;
    readonly amount_cents: number;
  }[];
  readonly adjustments: readonly {
    readonly what: "line" | "payment" | "refund" | "tip";
    readonly description: string;
    readonly for_business_date: string;
    readonly amount_cents: number;
  }[];
  readonly log: readonly { readonly at: string; readonly time: string; readonly what: string }[];
}

/** "1:30 AM EDT": the venue's time with its zone, so both daylight-saving nights read right. */
export function timeLabel(at: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(typeof at === "string" ? new Date(at) : at);
}

const n = (v: string | number | null | undefined) => Number(v ?? 0);

/** The report as it stands: the Z report if the night closed (as written then), the running X report otherwise. */
export async function nightReport(
  c: Queryable,
  venueId: string,
  date: string,
  now: Temporal.Instant,
): Promise<NightReport> {
  const closed = await nightClose(c, venueId, date);
  const stored = closed?.totals["report"] as NightReport | undefined;
  if (closed && stored)
    return { ...stored, kind: "z", closed: { ...stored.closed!, z_number: closed.z_number } };
  return computeReport(c, venueId, date, now, "x");
}

/** The night's check lines from the live views, dated to it (late lines for earlier nights left out). */
export async function nightLines(
  c: Queryable,
  venueId: string,
  date: string,
): Promise<ReportLine[]> {
  return (
    await c.query<ReportLine & { amount_cents: string; taxable_base_cents: string | null }>(
      `select l.check_id, k.kind as check_kind, l.kind, l.amount_cents::text, l.tax_category, l.jurisdiction_code,
              l.tax_rate::text, l.taxable_base_cents::text, l.description,
              exists (select 1 from packages p where p.venue_id = l.venue_id and p.id = l.source_id) as is_package
         from live_check_lines l join live_checks k on k.venue_id = l.venue_id and k.id = l.check_id
        where l.venue_id = $1 and l.business_date = $2::date and l.adjusts_business_date is null`,
      [venueId, date],
    )
  ).rows.map((l) => ({
    ...l,
    amount_cents: n(l.amount_cents),
    taxable_base_cents: l.taxable_base_cents === null ? null : n(l.taxable_base_cents),
  }));
}

export async function computeReport(
  c: Queryable,
  venueId: string,
  date: string,
  now: Temporal.Instant,
  kind: "x" | "z",
): Promise<NightReport> {
  const { timeZone } = await venueClock(c, venueId);
  const lines = await nightLines(c, venueId, date);
  const sales = salesReport(lines);

  const pay = (
    await c.query<Record<string, string>>(
      `select
         coalesce(sum(amount_cents) filter (where method = 'card_present'), 0)::text as card_present,
         coalesce(sum(amount_cents) filter (where method = 'card_on_file'), 0)::text as card_on_file,
         coalesce(sum(amount_cents) filter (where method = 'card_online'), 0)::text as card_online,
         coalesce(sum(amount_cents) filter (where method = 'cash'), 0)::text as cash,
         coalesce(sum(amount_cents) filter (where method = 'prepaid'), 0)::text as prepaid,
         coalesce(sum(tip_cents) filter (where method <> 'cash'), 0)::text as card_tips,
         coalesce(sum(tip_cents) filter (where method = 'cash'), 0)::text as cash_tips,
         coalesce(sum(amount_cents + tip_cents + surcharge_cents)
           filter (where method in ('card_present', 'card_on_file', 'card_online')), 0)::text as card_total,
         coalesce(sum(amount_cents) filter (where booking_id is not null), 0)::text as deposits_taken
       from live_payments
      where venue_id = $1 and business_date = $2::date and adjusts_business_date is null
        and status in ('captured', 'partly_refunded', 'refunded')`,
      [venueId, date],
    )
  ).rows[0]!;
  const refunds = (
    await c.query<{ cents: string }>(
      `select coalesce(sum(f.amount_cents), 0)::text as cents from refunds f
         join live_payments p on p.venue_id = f.venue_id and p.id = f.payment_id
        where f.venue_id = $1 and f.business_date = $2::date and f.status not in ('failed', 'canceled')`,
      [venueId, date],
    )
  ).rows[0]!.cents;
  const allocated = (
    await c.query<{ cents: string }>(
      `select coalesce(sum(a.amount_cents), 0)::text as cents from payment_allocations a
         join live_payments p on p.venue_id = a.venue_id and p.id = a.payment_id and p.booking_id is not null
         join live_checks k on k.venue_id = a.venue_id and k.id = a.check_id
        where a.venue_id = $1 and k.business_date = $2::date and a.state = 'captured'`,
      [venueId, date],
    )
  ).rows[0]!.cents;

  const sessions = await c.query<{
    id: string;
    drawer: string;
    owner: string | null;
    state: string;
    opening_cents: string;
    counted_cents: string | null;
    over_short_cents: string | null;
    note: string | null;
  }>(
    `select s.id, d.name as drawer, u.name as owner, s.state, s.opening_cents::text, s.counted_cents::text,
            s.over_short_cents::text, s.note
       from drawer_sessions s join cash_drawers d on d.venue_id = s.venue_id and d.id = s.drawer_id
       left join users u on u.id = s.owner_id
      where s.venue_id = $1 and s.business_date = $2::date order by d.name, s.opened_at`,
    [venueId, date],
  );
  const drawers = [];
  for (const s of sessions.rows) {
    const moves = await c.query<{
      kind: "sale" | "refund" | "paid_out" | "drop" | "no_sale" | "tip_out";
      cents: string;
    }>(
      "select kind, amount_cents::text as cents from drawer_moves where venue_id = $1 and drawer_session_id = $2",
      [venueId, s.id],
    );
    const t = drawerTotals(
      n(s.opening_cents),
      moves.rows.map((m) => ({ kind: m.kind, amountCents: n(m.cents) })),
    );
    drawers.push({
      drawer: s.drawer,
      owner: s.owner,
      state: s.state,
      opening_cents: t.openingCents,
      cash_taken_cents: t.cashTakenCents,
      paid_outs_cents: t.paidOutsCents,
      drops_cents: t.dropsCents,
      tip_outs_cents: t.tipOutsCents,
      refunds_cents: t.refundsCents,
      counted_cents: s.counted_cents === null ? null : n(s.counted_cents),
      over_short_cents: s.over_short_cents === null ? null : n(s.over_short_cents),
      note: s.note,
    });
  }

  const where = `coalesce((select r.name from room_sessions rs join rooms r on r.venue_id = rs.venue_id and r.id = rs.room_id
                            where rs.venue_id = k.venue_id and rs.id = k.room_session_id),
                          (select t.name from tabs t where t.venue_id = k.venue_id and t.check_id = k.id), '#' || k.number)`;
  const fixes = await c.query<{
    at: Date;
    kind: "comp" | "void";
    where: string;
    what: string;
    why: string | null;
    asked_by: string | null;
    cents: string;
  }>(
    `select l.added_at as at, l.kind, ${where} as where, l.description as what, l.reason as why,
            u.name as asked_by, l.amount_cents::text as cents
       from live_check_lines l join live_checks k on k.venue_id = l.venue_id and k.id = l.check_id
       left join users u on u.id = l.added_by
      where l.venue_id = $1 and l.business_date = $2::date and l.kind in ('comp', 'void')
      order by l.added_at, l.id`,
    [venueId, date],
  );
  const refundRows = await c.query<{
    at: Date;
    where: string;
    why: string;
    asked_by: string | null;
    approved_by: string | null;
    cents: string;
  }>(
    `select f.requested_at as at, coalesce(${where}, 'Deposit') as where, f.reason as why,
            ru.name as asked_by, au.name as approved_by, f.amount_cents::text as cents
       from refunds f join live_payments p on p.venue_id = f.venue_id and p.id = f.payment_id
       left join live_checks k on k.venue_id = f.venue_id and k.id = f.check_id
       left join users ru on ru.id = f.requested_by
       left join users au on au.id = f.approved_by
      where f.venue_id = $1 and f.business_date = $2::date and f.status not in ('failed', 'canceled')
      order by f.requested_at`,
    [venueId, date],
  );
  const exceptions = [
    ...fixes.rows.map((x) => ({
      at: x.at.toISOString(),
      time: timeLabel(x.at, timeZone),
      kind: x.kind,
      where: x.where,
      what: x.what,
      why: x.why,
      asked_by: x.asked_by,
      approved_by: null,
      amount_cents: n(x.cents),
    })),
    ...refundRows.rows.map((x) => ({
      at: x.at.toISOString(),
      time: timeLabel(x.at, timeZone),
      kind: "refund" as const,
      where: x.where,
      what: "Refund",
      why: x.why,
      asked_by: x.asked_by,
      approved_by: x.approved_by,
      amount_cents: -n(x.cents),
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  // Late money posted to this date for earlier nights (M7-02).
  const adjustments = (
    await c.query<{
      what: "line" | "payment" | "refund" | "tip";
      description: string;
      for_date: string;
      cents: string;
    }>(
      `select 'line' as what, l.description, l.adjusts_business_date::text as for_date, l.amount_cents::text as cents
         from live_check_lines l where l.venue_id = $1 and l.business_date = $2::date and l.adjusts_business_date is not null
       union all
       select 'payment', p.method, p.adjusts_business_date::text, (p.amount_cents + p.tip_cents)::text
         from live_payments p where p.venue_id = $1 and p.business_date = $2::date and p.adjusts_business_date is not null
       union all
       select 'refund', f.reason, f.adjusts_business_date::text, (-f.amount_cents)::text
         from refunds f where f.venue_id = $1 and f.business_date = $2::date and f.adjusts_business_date is not null
       union all
       select 'tip', t.source, t.adjusts_business_date::text, t.amount_cents::text
         from tip_ledger t where t.venue_id = $1 and t.business_date = $2::date and t.adjusts_business_date is not null
       order by 3, 1`,
      [venueId, date],
    )
  ).rows.map((a) => ({
    what: a.what,
    description: a.description,
    for_business_date: a.for_date,
    amount_cents: n(a.cents),
  }));

  // The night's log, in time order and plain words: rooms starting and ending, rooms out of service, the close.
  const log = (
    await c.query<{ at: Date; what: string }>(
      `select s.started_at as at, r.name || ' · session started' as what
         from room_sessions s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
        where s.venue_id = $1 and s.business_date = $2::date and not s.training
       union all
       select s.ended_at, r.name || ' · session ended'
         from room_sessions s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
        where s.venue_id = $1 and s.business_date = $2::date and not s.training and s.ended_at is not null
       union all
       select st.since, r.name || ' · out of service' || coalesce(' · ' || st.reason, '')
         from room_states st join rooms r on r.venue_id = st.venue_id and r.id = st.room_id
        where st.venue_id = $1 and st.state = 'out_of_service'
       order by 1`,
      [venueId, date],
    )
  ).rows.map((l) => ({ at: l.at.toISOString(), time: timeLabel(l.at, timeZone), what: l.what }));

  return {
    ...sales,
    kind,
    business_date: date,
    time_zone: timeZone,
    generated_at: now.toString(),
    closed: null,
    payments: {
      card_present_cents: n(pay["card_present"]),
      card_on_file_cents: n(pay["card_on_file"]),
      card_online_cents: n(pay["card_online"]),
      cash_cents: n(pay["cash"]),
      prepaid_cents: n(pay["prepaid"]),
      card_tips_cents: n(pay["card_tips"]),
      cash_tips_cents: n(pay["cash_tips"]),
      refunds_cents: n(refunds),
      card_total_cents: n(pay["card_total"]),
      deposits_taken_cents: n(pay["deposits_taken"]),
      deposits_allocated_cents: n(allocated),
    },
    drawers,
    tips: await nightTips(c, venueId, date, now),
    exceptions,
    adjustments,
    log,
  };
}

/** The report as printed lines on the front-desk receipt printer: label and amount, 32 wide. */
export function reportPrintLines(r: NightReport, money: (cents: number) => string): string[] {
  const out: string[] = [];
  const amt = (label: string, cents: number) => out.push(`${label}  ${money(cents)}`);
  out.push(r.kind === "z" ? `Z REPORT ${r.closed?.z_number ?? ""}` : "X REPORT (RUNNING)");
  out.push(`Business date ${r.business_date}`);
  if (r.closed)
    out.push(`Closed ${timeLabel(r.closed.closed_at, r.time_zone)} by ${r.closed.closed_by ?? ""}`);
  else out.push(`Printed ${timeLabel(r.generated_at, r.time_zone)}`);
  out.push(`Rooms ${r.counts.rooms} · Bar tabs ${r.counts.bar_tabs}`);
  out.push("SALES");
  amt("Room time", r.sales.room_time_cents);
  amt("Drinks · room checks", r.sales.drinks_room_checks_cents);
  amt("Drinks · bar tabs", r.sales.drinks_bar_tabs_cents);
  amt("Packages", r.sales.packages_cents);
  amt("Songs", r.sales.songs_cents);
  amt("Damage fees", r.sales.damage_cents);
  amt("Deposits kept", r.sales.kept_deposits_cents);
  amt("Comps", r.sales.comps_cents);
  amt("Voids", r.sales.voids_cents);
  amt("Refunds", r.sales.refunds_cents);
  amt("Net sales", r.sales.net_cents);
  out.push("TAX");
  for (const t of r.tax) amt(`${t.jurisdiction} ${t.rate}`, t.tax_cents);
  amt("Tax", r.tax_cents);
  amt("Gratuity", r.gratuity.total_cents);
  out.push("PAYMENTS");
  amt("Cards · tap", r.payments.card_present_cents);
  amt("Cards · on file", r.payments.card_on_file_cents);
  amt("Cards · online", r.payments.card_online_cents);
  amt("Cash", r.payments.cash_cents);
  amt("Card tips", r.payments.card_tips_cents);
  amt("Cash tips", r.payments.cash_tips_cents);
  amt("Refunds", -r.payments.refunds_cents);
  out.push("DRAWERS");
  for (const d of r.drawers) {
    out.push(d.owner ? `${d.drawer} · ${d.owner}` : d.drawer);
    amt("Opened with", d.opening_cents);
    amt("Cash taken", d.cash_taken_cents);
    if (d.counted_cents !== null) amt("Counted", d.counted_cents);
    if (d.over_short_cents !== null) amt("Over or short", d.over_short_cents);
  }
  amt("Tip pool", r.tips.sources.total_cents);
  return out;
}
