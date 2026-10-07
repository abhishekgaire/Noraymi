import type { Queryable } from "@west4/db";

/**
 * The outage drill's evidence (M8-07; docs/runbooks/outage-drill.md), read from one venue's
 * night after the four drills: what the screens were told (the connection events), what the
 * bar computer queued and how replay landed it, and the break-glass Tap to Pay payments and
 * whether each was matched. `findings` names everything that fails the drill's checks; an
 * empty list is a pass for the parts a machine can check. Read-only, inside withVenue.
 */
export interface OutageEvidence {
  readonly date: string;
  readonly events: readonly { at: string; type: string; device: string | null }[];
  readonly replays: {
    readonly queued: number;
    readonly held: number;
    readonly failed: number;
    readonly failedReasons: Readonly<Record<string, number>>;
    readonly orders: Readonly<Record<string, number>>;
    readonly cashPosted: number;
    readonly cashWaiting: number;
  };
  readonly breakGlass: readonly {
    id: string;
    at: string;
    amountCents: number;
    card: string | null;
    matchedTo: string | null;
    refunded: boolean;
  }[];
  readonly findings: readonly string[];
}

const EVENT_TYPES = [
  "venue.backup_internet",
  "venue.offline",
  "venue.online",
  "device.offline",
  "device.online",
  "vendor.health",
  "offline.replay_failed",
  "payment.unmatched",
];

export async function outageEvidence(
  c: Queryable,
  venueId: string,
  date: string,
): Promise<OutageEvidence> {
  // The night runs from the cutover on its business date to the next cutover, venue time.
  const events = await c.query<{ at: string; type: string; device: string | null }>(
    `select to_char(e.at at time zone v.time_zone, 'YYYY-MM-DD HH24:MI:SS') as at, e.type,
            (select d.name from devices d where d.venue_id = e.venue_id and d.id::text = e.entity_id) as device
       from venue_events e join venues v on v.id = e.venue_id
      where e.venue_id = $1 and e.type = any($3::text[])
        and e.at >= ($2::date + v.day_cutover) at time zone v.time_zone
        and e.at < ($2::date + 1 + v.day_cutover) at time zone v.time_zone
      order by e.at, e.type`,
    [venueId, date, EVENT_TYPES],
  );
  const replays = await c.query<{
    client_order_id: string;
    outcome: string;
    reason: string | null;
    order_status: string | null;
    landed: number;
    cash_note: string | null;
    cash_payment_id: string | null;
  }>(
    `select r.client_order_id, r.outcome, r.reason, o.status as order_status, r.cash_note, r.cash_payment_id,
            (select count(*)::int from orders x where x.venue_id = r.venue_id and x.client_order_id = r.client_order_id) as landed
       from offline_replays r
       left join orders o on o.venue_id = r.venue_id and o.id = r.order_id
      where r.venue_id = $1 and (r.queued_on = $2::date or r.replayed_on = $2::date)
      order by r.queued_at, r.id`,
    [venueId, date],
  );
  // Break-glass card payments: Tap to Pay in Stripe's Dashboard app lands as an external payment.
  const glass = await c.query<{
    id: string;
    at: string;
    amount_cents: number;
    card: string | null;
    matched_to: string | null;
    refunded: boolean;
  }>(
    `select p.id, to_char(p.created_at at time zone v.time_zone, 'YYYY-MM-DD HH24:MI:SS') as at,
            p.amount_cents::int as amount_cents,
            case when p.card_last4 is null then null else coalesce(p.card_brand, 'card') || ' ' || p.card_last4 end as card,
            (select string_agg('check #' || k.number, ', ' order by k.number) from payment_allocations a
               join checks k on k.venue_id = a.venue_id and k.id = a.check_id
              where a.venue_id = p.venue_id and a.payment_id = p.id) as matched_to,
            exists (select 1 from refunds r where r.venue_id = p.venue_id and r.payment_id = p.id) as refunded
       from payments p join venues v on v.id = p.venue_id
      where p.venue_id = $1 and p.method = 'external' and p.status in ('captured', 'refunded', 'partly_refunded')
        and (p.business_date = $2::date or p.adjusts_business_date = $2::date)
      order by p.created_at, p.id`,
    [venueId, date],
  );

  const findings: string[] = [];
  const count = (pick: (r: (typeof replays.rows)[number]) => string | null) => {
    const out: Record<string, number> = {};
    for (const r of replays.rows) {
      const k = pick(r);
      if (k) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  for (const r of replays.rows) {
    if (r.landed > 1)
      findings.push(`offline order ${r.client_order_id} landed ${r.landed} times (charged twice)`);
    if (r.outcome === "held" && r.order_status === "held")
      findings.push(
        `offline order ${r.client_order_id} is still waiting on Confirm replayed orders`,
      );
  }
  const cashWaiting = replays.rows.filter((r) => r.cash_note && !r.cash_payment_id).length;
  if (cashWaiting)
    findings.push(`${cashWaiting} offline cash note(s) not yet posted from Review after outage`);
  for (const g of glass.rows)
    if (!g.matched_to)
      findings.push(`break-glass payment ${g.id} (${g.at}) is still in Unmatched payments`);

  return {
    date,
    events: events.rows,
    replays: {
      queued: replays.rows.length,
      held: replays.rows.filter((r) => r.outcome === "held").length,
      failed: replays.rows.filter((r) => r.outcome === "failed").length,
      failedReasons: count((r) => r.reason),
      orders: count((r) => r.order_status),
      cashPosted: replays.rows.filter((r) => r.cash_payment_id).length,
      cashWaiting,
    },
    breakGlass: glass.rows.map((g) => ({
      id: g.id,
      at: g.at,
      amountCents: g.amount_cents,
      card: g.card,
      matchedTo: g.matched_to,
      refunded: g.refunded,
    })),
    findings,
  };
}

const money = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/** The drill report as Markdown: the four drills for people to fill in, then the evidence. */
export function outageReport(slug: string, e: OutageEvidence): string {
  const drill = (n: number, title: string, banner: string, extra: string[]) => [
    `## Drill ${n}: ${title}`,
    "",
    `Started _(time)_ · back to normal _(time)_ · expected banner: ${banner}`,
    "",
    "| Screen or device | What it showed | When | Screenshot |",
    "| --- | --- | --- | --- |",
    "| Bar computer | | | |",
    "| Staff phone on Wi-Fi | | | |",
    ...extra,
    "",
    "Passed: _(yes / no, and why)_",
    "",
  ];
  const readerRows = [
    "| Bar S710: kept taking cards? moved to cellular? how long? | | | |",
    "| Front desk S710: kept taking cards? moved to cellular? how long? | | | |",
  ];
  const r = e.replays;
  return [
    `# Outage drill · ${slug} · night of ${e.date}`,
    "",
    "Ran by: _(name)_ · Witnessed by: _(name)_ · Closed hours, practice checks in device training",
    "",
    ...drill(1, "the internet down with the Wi-Fi up", "amber, On backup internet", [
      ...readerRows,
      "",
      "**Open Stripe question:** with the Wi-Fi up and the internet behind it down, did each reader switch to cellular? _(yes / no / only after N s, per reader)_",
    ]),
    ...drill(2, "the access point off", "each Wi-Fi screen's own offline banner", [
      ...readerRows,
      "| Room tablets: offline, manager alerted? | | | |",
    ]),
    ...drill(3, "the router's LTE off too", "pink, Offline · read-only", [
      "| Queue mode opened with an offline code? | | | |",
      "| Reader taps driven from a staff phone on cellular | | | |",
      "| After reconnect: Confirm replayed orders (N) | | | |",
    ]),
    ...drill(4, "our cloud down", "pink, Offline · read-only", [
      "| Break-glass Tap to Pay on Andy's phone | | | |",
      "| Break-glass Tap to Pay on Abhishek's phone | | | |",
    ]),
    "## What the system recorded",
    "",
    "Connection events that night (venue time):",
    "",
    "| When | Event | Device |",
    "| --- | --- | --- |",
    ...e.events.map((v) => `| ${v.at} | ${v.type} | ${v.device ?? ""} |`),
    "",
    `Queued offline: ${r.queued} · landed as asked to wait: ${r.held} · on Review after outage: ${r.failed}` +
      (r.failed
        ? ` (${Object.entries(r.failedReasons)
            .map(([k, n]) => `${k} ${n}`)
            .join(", ")})`
        : ""),
    `Replayed orders now: ${
      Object.entries(r.orders)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ") || "none"
    } · offline cash posted: ${r.cashPosted}, waiting: ${r.cashWaiting}`,
    "",
    "Break-glass payments (Tap to Pay in Stripe's Dashboard app):",
    "",
    "| When | Amount | Card | Matched to | Refunded | Whose phone |",
    "| --- | --- | --- | --- | --- | --- |",
    ...e.breakGlass.map(
      (g) =>
        `| ${g.at} | ${money(g.amountCents)} | ${g.card ?? ""} | ${g.matchedTo ?? "**unmatched**"} | ${g.refunded ? "yes" : "no"} | _(name)_ |`,
    ),
    "",
    e.findings.length
      ? `**Findings (${e.findings.length}):**\n\n${e.findings.map((f) => `- ${f}`).join("\n")}`
      : "**Findings:** none. Every offline order landed once and was decided, and every break-glass payment is matched.",
    "",
  ].join("\n");
}
