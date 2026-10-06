import { isNightClosed, readSetting, type Queryable } from "@west4/db";
import { poolMinutes, poolShares, type PoolMethod, type PoolWorker } from "@west4/rules";
import { Temporal, type PaySettings } from "@west4/shared";
import { venueClock } from "../rooms/assignment.js";

/**
 * A night's tip pool (M7-09; Money rules 1 and 9; spec 04 · tip_pools,
 * tip_shares). While the night runs the pool is worked out live from the tip
 * ledger and the shifts; `closePool` (Close the night, M7-12) writes the
 * shares once and closes it, and a closed pool reads what was written.
 *
 * Each person counts with their eligibility and occupation as they stood when
 * the business date started (a later change in Admin → Team starts the next
 * night: the audit row holds the value before it). Late tips posted to this
 * date that point at an earlier night are split by that night's people and
 * minutes, and recorded in this date's pool. A gratuity refunded after its
 * night closed is absorbed by the house (`pay.refundedGratuity`, the cautious
 * default) and listed, so it never comes off staff.
 */
export interface ShareView {
  readonly for_business_date: string;
  readonly user_id: string;
  readonly name: string;
  readonly duty: string;
  readonly minutes: number;
  readonly gratuity_cents: number;
  readonly card_tip_cents: number;
  readonly cash_tip_cents: number;
  readonly total_cents: number;
}

export interface NightTips {
  readonly business_date: string;
  readonly pool: {
    readonly id: string | null;
    readonly method: PoolMethod;
    readonly status: "open" | "closed" | "exported";
  };
  readonly sources: {
    readonly gratuity_cents: number;
    readonly card_tip_cents: number;
    readonly cash_tip_cents: number;
    readonly total_cents: number;
  };
  readonly shares: readonly ShareView[];
  readonly left_out: readonly {
    readonly name: string;
    readonly reason: "manager" | "not_eligible";
  }[];
  /** Ledger money no eligible person worked to share. */
  readonly unshared_cents: number;
  /** Gratuity refunded after its night closed, absorbed by the house. */
  readonly house_absorbed: readonly { readonly check_id: string; readonly cents: number }[];
}

interface PoolRow {
  readonly id: string;
  readonly method: PoolMethod;
  readonly status: "open" | "closed" | "exported";
}

async function payAt(c: Queryable, venueId: string, date: string) {
  return (await readSetting(c, venueId, "pay", Temporal.PlainDate.from(date)))?.value as
    PaySettings | undefined;
}

/** The night's pool row, opened with the method in force at its start; null for a closed night that had none. */
export async function poolOf(c: Queryable, venueId: string, date: string): Promise<PoolRow | null> {
  const found = await c.query<PoolRow>(
    "select id, method, status from tip_pools where venue_id = $1 and business_date = $2::date",
    [venueId, date],
  );
  if (found.rows[0]) return found.rows[0];
  if (await isNightClosed(c, venueId, date)) return null;
  const pay = await payAt(c, venueId, date);
  const made = await c.query<PoolRow>(
    `insert into tip_pools (venue_id, business_date, method) values ($1, $2::date, $3)
     on conflict (venue_id, business_date) do update set status = tip_pools.status
     returning id, method, status`,
    [venueId, date, pay?.pool ?? "hours"],
  );
  const pool = made.rows[0]!;
  for (const o of pay?.occupations ?? [])
    await c.query(
      `insert into tip_pool_occupations (venue_id, pool_id, occupation, share_pct) values ($1, $2, $3, $4)
       on conflict do nothing`,
      [venueId, pool.id, o.code, o.sharePct],
    );
  return pool;
}

/** When a business date starts: its date at the venue's cutover, in the venue's zone. */
async function dateStart(c: Queryable, venueId: string, date: string): Promise<Temporal.Instant> {
  const v = await venueClock(c, venueId);
  return Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone: v.timeZone, plainTime: Temporal.PlainTime.from(v.dayCutover) })
    .toInstant();
}

/**
 * Each membership's tip eligibility and occupation as they stood at `start`:
 * the current value, walked back through the audit rows of changes saved after it.
 */
async function eligibilityAt(c: Queryable, venueId: string, start: Temporal.Instant) {
  const now = await c.query<{ id: string; tip_eligible: boolean; occupation_code: string | null }>(
    "select id, tip_eligible, occupation_code from memberships where venue_id = $1",
    [venueId],
  );
  const out = new Map(
    now.rows.map((m) => [m.id, { eligible: m.tip_eligible, occupation: m.occupation_code }]),
  );
  const changes = await c.query<{
    target: string;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
  }>(
    `select target, old_values, new_values from audit_log
      where venue_id = $1 and target like 'memberships/%'
        and (changed_fields && array['tip_eligible', 'occupation_code'])
      order by id desc`,
    [venueId],
  );
  for (const ch of changes.rows) {
    // A delete has no new values, and an insert no old ones: neither changes what stood at the start.
    if (!ch.new_values || !ch.old_values) continue;
    const setAt = ch.new_values["eligibility_set_at"];
    if (
      typeof setAt !== "string" ||
      Temporal.Instant.compare(Temporal.Instant.from(setAt), start) <= 0
    )
      continue;
    const id = ch.target.slice("memberships/".length);
    const cur = out.get(id);
    if (!cur) continue;
    out.set(id, {
      eligible:
        "tip_eligible" in ch.old_values ? Boolean(ch.old_values["tip_eligible"]) : cur.eligible,
      occupation:
        "occupation_code" in ch.old_values
          ? ((ch.old_values["occupation_code"] as string | null) ?? null)
          : cur.occupation,
    });
  }
  return out;
}

/** The people who worked a business date, one row per shift, with their minutes in the pool. */
async function workersOf(c: Queryable, venueId: string, date: string, now: Temporal.Instant) {
  const shifts = await c.query<{
    user_id: string;
    name: string;
    membership_id: string;
    role: PoolWorker["role"];
    duty: PoolWorker["duty"];
    started_at: Date;
    ended_at: Date | null;
    break_minutes: number;
  }>(
    `select m.user_id, u.name, m.id as membership_id, m.role, s.duty, s.started_at, s.ended_at, s.break_minutes
       from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
       join users u on u.id = m.user_id
      where s.venue_id = $1 and s.business_date = $2::date and not m.training
      order by s.started_at, s.id`,
    [venueId, date],
  );
  const eligibility = await eligibilityAt(c, venueId, await dateStart(c, venueId, date));
  const names = new Map(shifts.rows.map((s) => [s.user_id, s.name]));
  const workers: PoolWorker[] = shifts.rows.map((s) => ({
    userId: s.user_id,
    role: s.role,
    duty: s.duty,
    minutes: poolMinutes(
      s.started_at.getTime(),
      s.ended_at ? s.ended_at.getTime() : now.epochMilliseconds,
      s.break_minutes,
    ),
    eligible: eligibility.get(s.membership_id)?.eligible ?? false,
    occupation: eligibility.get(s.membership_id)?.occupation ?? null,
  }));
  return { workers, names };
}

interface LedgerSum {
  gratuity: number;
  cardTip: number;
  cashTip: number;
}

/** The ledger posted to `date`, grouped by the night it was earned (itself, or the earlier night a late tip points at). */
async function ledgerOf(c: Queryable, venueId: string, date: string, houseAbsorbs: boolean) {
  const rows = await c.query<{
    source: "gratuity" | "card_tip" | "cash_tip";
    amount: string;
    earned: string;
    check_id: string | null;
    refund_id: string | null;
    check_date: string | null;
  }>(
    `select l.source, l.amount_cents::text as amount,
            coalesce(l.adjusts_business_date, l.business_date)::text as earned,
            l.check_id, l.refund_id, k.business_date::text as check_date
       from tip_ledger l left join checks k on k.venue_id = l.venue_id and k.id = l.check_id
      where l.venue_id = $1 and l.business_date = $2::date`,
    [venueId, date],
  );
  const groups = new Map<string, LedgerSum>();
  const absorbed: { check_id: string; cents: number }[] = [];
  for (const r of rows.rows) {
    const cents = Number(r.amount);
    // A gratuity refunded after its check's night closed: the house absorbs it, by default.
    if (
      houseAbsorbs &&
      r.source === "gratuity" &&
      r.refund_id &&
      cents < 0 &&
      r.check_date &&
      r.check_date < date &&
      (await isNightClosed(c, venueId, r.check_date))
    ) {
      absorbed.push({ check_id: r.check_id!, cents });
      continue;
    }
    const g = groups.get(r.earned) ?? { gratuity: 0, cardTip: 0, cashTip: 0 };
    if (r.source === "gratuity") g.gratuity += cents;
    else if (r.source === "card_tip") g.cardTip += cents;
    else g.cashTip += cents;
    groups.set(r.earned, g);
  }
  if (!groups.has(date)) groups.set(date, { gratuity: 0, cardTip: 0, cashTip: 0 });
  return { groups, absorbed };
}

/** The night's tips: its sources, each person's share, who's left out, and what the house absorbed. */
export async function nightTips(
  c: Queryable,
  venueId: string,
  date: string,
  now: Temporal.Instant,
): Promise<NightTips> {
  const pool = await poolOf(c, venueId, date);
  const pay = await payAt(c, venueId, date);
  const { groups, absorbed } = await ledgerOf(
    c,
    venueId,
    date,
    (pay?.refundedGratuity ?? "house") === "house",
  );
  const total = [...groups.values()].reduce(
    (s, g) => ({
      gratuity: s.gratuity + g.gratuity,
      cardTip: s.cardTip + g.cardTip,
      cashTip: s.cashTip + g.cashTip,
    }),
    { gratuity: 0, cardTip: 0, cashTip: 0 },
  );
  const sources = {
    gratuity_cents: total.gratuity,
    card_tip_cents: total.cardTip,
    cash_tip_cents: total.cashTip,
    total_cents: total.gratuity + total.cardTip + total.cashTip,
  };
  const leftOut = new Map<string, "manager" | "not_eligible">();
  let unshared = 0;
  let shares: ShareView[];
  if (pool && pool.status !== "open") shares = await storedShares(c, venueId, pool.id);
  else {
    shares = [];
    for (const [earned, sum] of [...groups].sort(([a], [b]) => (a < b ? 1 : -1))) {
      // Each night's money is split by that night's people, method and occupation shares.
      const own = earned === date ? pool : await poolOf(c, venueId, earned);
      const occupations = own
        ? (
            await c.query<{ occupation: string; share_pct: string }>(
              "select occupation, share_pct::text from tip_pool_occupations where venue_id = $1 and pool_id = $2 order by occupation",
              [venueId, own.id],
            )
          ).rows.map((o) => ({ code: o.occupation, sharePct: Number(o.share_pct) }))
        : ((await payAt(c, venueId, earned))?.occupations ?? []);
      const { workers, names } = await workersOf(c, venueId, earned, now);
      const r = poolShares({
        method: own?.method ?? (await payAt(c, venueId, earned))?.pool ?? "hours",
        workers,
        gratuityCents: sum.gratuity,
        cardTipCents: sum.cardTip,
        cashTipCents: sum.cashTip,
        occupations,
      });
      unshared += r.unshared.gratuityCents + r.unshared.cardTipCents + r.unshared.cashTipCents;
      if (earned === date)
        for (const l of r.leftOut) leftOut.set(names.get(l.userId) ?? "", l.reason);
      for (const s of r.shares)
        shares.push({
          for_business_date: earned,
          user_id: s.userId,
          name: names.get(s.userId) ?? "",
          duty: s.duty,
          minutes: s.minutes,
          gratuity_cents: s.gratuityCents,
          card_tip_cents: s.cardTipCents,
          cash_tip_cents: s.cashTipCents,
          total_cents: s.gratuityCents + s.cardTipCents + s.cashTipCents,
        });
    }
  }
  // The newest night first, then the most minutes, so the live and the stored pool read the same.
  shares.sort(
    (a, b) =>
      (a.for_business_date < b.for_business_date
        ? 1
        : a.for_business_date > b.for_business_date
          ? -1
          : 0) ||
      b.minutes - a.minutes ||
      a.name.localeCompare(b.name),
  );
  return {
    business_date: date,
    pool: {
      id: pool?.id ?? null,
      method: pool?.method ?? pay?.pool ?? "hours",
      status: pool?.status ?? "closed",
    },
    sources,
    shares,
    left_out: [...leftOut].map(([name, reason]) => ({ name, reason })),
    unshared_cents: unshared,
    house_absorbed: absorbed,
  };
}

async function storedShares(c: Queryable, venueId: string, poolId: string): Promise<ShareView[]> {
  const r = await c.query<ShareView>(
    `select t.for_business_date::text, t.user_id, u.name, t.duty, t.minutes,
            t.gratuity_cents::int as gratuity_cents, t.card_tip_cents::int as card_tip_cents,
            t.cash_tip_cents::int as cash_tip_cents,
            (t.gratuity_cents + t.card_tip_cents + t.cash_tip_cents)::int as total_cents
       from tip_shares t join users u on u.id = t.user_id
      where t.venue_id = $1 and t.pool_id = $2
      order by t.for_business_date desc, t.id`,
    [venueId, poolId],
  );
  return r.rows;
}

/** Close the night's pool (Close the night, M7-12): its shares are written once and never change. */
export async function closePool(
  c: Queryable,
  venueId: string,
  date: string,
  now: Temporal.Instant,
): Promise<NightTips> {
  const tips = await nightTips(c, venueId, date, now);
  if (!tips.pool.id || tips.pool.status !== "open") return tips;
  for (const s of tips.shares)
    await c.query(
      `insert into tip_shares (venue_id, pool_id, for_business_date, user_id, duty, minutes, gratuity_cents,
         card_tip_cents, cash_tip_cents)
       values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)`,
      [
        venueId,
        tips.pool.id,
        s.for_business_date,
        s.user_id,
        s.duty,
        s.minutes,
        s.gratuity_cents,
        s.card_tip_cents,
        s.cash_tip_cents,
      ],
    );
  await c.query("update tip_pools set status = 'closed' where venue_id = $1 and id = $2", [
    venueId,
    tips.pool.id,
  ]);
  return { ...tips, pool: { ...tips.pool, status: "closed" } };
}
