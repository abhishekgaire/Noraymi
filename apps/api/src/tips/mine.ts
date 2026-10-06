import type { Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { nightTips } from "./pool.js";

/**
 * My tips (M7-10; spec 08 · Time clock `GET /me/tips`; NY Labor Law
 * 146-2.17 records, GA-M2): only the caller's own records for the dates asked
 * for. Their shifts; the tips they collected by shift (ledger rows, declared
 * cash included); their share of each night's pool, gratuity and tips apart
 * (a closed pool as written, tonight's worked out live); each pool's
 * occupations and shares; and late tips with the night they belong to.
 */
export interface MyTips {
  readonly from: string;
  readonly to: string;
  /** Owners and managers never share in the pool. */
  readonly never_shares: boolean;
  readonly shifts: readonly {
    readonly id: string;
    readonly business_date: string;
    readonly duty: string;
    readonly started_at: string;
    readonly ended_at: string | null;
    readonly break_minutes: number;
  }[];
  readonly collected: readonly {
    readonly business_date: string;
    readonly adjusts_business_date: string | null;
    readonly shift_id: string | null;
    readonly source: "gratuity" | "card_tip" | "cash_tip";
    readonly amount_cents: number;
  }[];
  readonly shares: readonly {
    readonly posted_on: string;
    readonly for_business_date: string;
    readonly duty: string;
    readonly minutes: number;
    readonly gratuity_cents: number;
    readonly card_tip_cents: number;
    readonly cash_tip_cents: number;
    readonly final: boolean;
  }[];
  readonly occupations: readonly {
    readonly business_date: string;
    readonly occupation: string;
    readonly share_pct: number;
  }[];
}

export async function myTips(
  c: Queryable,
  venueId: string,
  input: { userId: string; role: string; from: string; to: string; now: Temporal.Instant },
): Promise<MyTips> {
  const range = [venueId, input.userId, input.from, input.to];
  const shifts = await c.query<MyTips["shifts"][number]>(
    `select s.id, s.business_date::text, s.duty, to_json(s.started_at) #>> '{}' as started_at,
            to_json(s.ended_at) #>> '{}' as ended_at, s.break_minutes
       from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
      where s.venue_id = $1 and m.user_id = $2 and s.business_date between $3::date and $4::date
      order by s.started_at`,
    range,
  );
  const collected = await c.query<MyTips["collected"][number]>(
    `select business_date::text, adjusts_business_date::text, shift_id, source, amount_cents::int as amount_cents
       from tip_ledger
      where venue_id = $1 and user_id = $2 and business_date between $3::date and $4::date
      order by business_date, created_at`,
    range,
  );
  const stored = await c.query<MyTips["shares"][number]>(
    `select p.business_date::text as posted_on, t.for_business_date::text, t.duty, t.minutes,
            t.gratuity_cents::int as gratuity_cents, t.card_tip_cents::int as card_tip_cents,
            t.cash_tip_cents::int as cash_tip_cents, true as final
       from tip_shares t join tip_pools p on p.venue_id = t.venue_id and p.id = t.pool_id
      where t.venue_id = $1 and t.user_id = $2 and p.business_date between $3::date and $4::date
      order by p.business_date, t.for_business_date`,
    range,
  );
  // Pools still open (tonight's): worked out live, the caller's rows only.
  const open = await c.query<{ business_date: string }>(
    `select business_date::text from tip_pools
      where venue_id = $1 and status = 'open' and business_date between $2::date and $3::date
      order by business_date`,
    [venueId, input.from, input.to],
  );
  const live: MyTips["shares"][number][] = [];
  for (const p of open.rows)
    for (const s of (await nightTips(c, venueId, p.business_date, input.now)).shares)
      if (s.user_id === input.userId)
        live.push({
          posted_on: p.business_date,
          for_business_date: s.for_business_date,
          duty: s.duty,
          minutes: s.minutes,
          gratuity_cents: s.gratuity_cents,
          card_tip_cents: s.card_tip_cents,
          cash_tip_cents: s.cash_tip_cents,
          final: false,
        });
  const occupations = await c.query<{
    business_date: string;
    occupation: string;
    share_pct: string;
  }>(
    `select p.business_date::text, o.occupation, o.share_pct::text
       from tip_pool_occupations o join tip_pools p on p.venue_id = o.venue_id and p.id = o.pool_id
      where o.venue_id = $1 and p.business_date between $2::date and $3::date
      order by p.business_date, o.occupation`,
    [venueId, input.from, input.to],
  );
  return {
    from: input.from,
    to: input.to,
    never_shares: input.role === "owner" || input.role === "manager",
    shifts: shifts.rows,
    collected: collected.rows,
    shares: [...stored.rows, ...live],
    occupations: occupations.rows.map((o) => ({ ...o, share_pct: Number(o.share_pct) })),
  };
}
