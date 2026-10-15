import type { Queryable } from "@west4/db";

/**
 * Staff actions (M7-18, P-09; Money rules · Close the night and reports): for a
 * range of business dates, per person, the count and dollars of each kind of
 * action, and each action's own row: when, where, what, why, how much and who
 * approved it. Every amount is the one on the action's own row (the audit
 * log's new values), signed as stored: comps, voids and discounts negative,
 * over/short as counted. Practice is left out (the live views).
 *
 *   void, comp     the check lines (a meal with its parts, K-12, is one action at its whole amount),
 *                  by who added them, approved by the line's approver
 *   discount       a whole-check discount (P-02) still standing, by who gave it, at what it came off
 *                  the check (its discount lines; what it counted when given if none yet)
 *   refund         a refund asked (not failed or canceled), by who asked, approved by its approver
 *   no_sale,
 *   paid_out       the drawer or staff bank moves, by who took them
 *   over_short     a drawer counted over or short (not exactly), by who counted it
 *   punch_edit     a time punch edited, by who edited it, on the punch's own business date ("where"
 *                  is the punch's kind, clock_in and so on; "what" is whose punch it is)
 *   cut_off        a tab cut off, by who cut it off
 */
export const STAFF_ACTION_KINDS = [
  "void",
  "comp",
  "discount",
  "refund",
  "no_sale",
  "paid_out",
  "over_short",
  "punch_edit",
  "cut_off",
] as const;
export type StaffActionKind = (typeof STAFF_ACTION_KINDS)[number];

export interface StaffActionRow {
  readonly user_id: string;
  readonly name: string;
  readonly kind: StaffActionKind;
  readonly at: string;
  readonly business_date: string;
  readonly where: string | null;
  readonly what: string | null;
  readonly why: string | null;
  readonly cents: number;
  readonly approved_by: string | null;
}

export interface StaffActionEntry {
  readonly kind: StaffActionKind;
  readonly at: string;
  readonly business_date: string;
  readonly where: string | null;
  readonly what: string | null;
  readonly why: string | null;
  readonly amount_cents: number;
  readonly approved_by: string | null;
}

export interface StaffActionPerson {
  readonly user_id: string;
  readonly name: string;
  readonly actions: Partial<Record<StaffActionKind, { count: number; cents: number }>>;
  readonly entries: readonly StaffActionEntry[];
}

/** The rows grouped by person (by name, then id), each person's counts and dollars as the sum of their rows. */
export function groupStaffActions(rows: readonly StaffActionRow[]): StaffActionPerson[] {
  const people = new Map<
    string,
    {
      user_id: string;
      name: string;
      actions: Partial<Record<StaffActionKind, { count: number; cents: number }>>;
      entries: StaffActionEntry[];
    }
  >();
  const sorted = [...rows].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
  for (const r of sorted) {
    const p = people.get(r.user_id) ?? {
      user_id: r.user_id,
      name: r.name,
      actions: {},
      entries: [],
    };
    const a = p.actions[r.kind] ?? { count: 0, cents: 0 };
    p.actions[r.kind] = { count: a.count + 1, cents: a.cents + r.cents };
    p.entries.push({
      kind: r.kind,
      at: r.at,
      business_date: r.business_date,
      where: r.where,
      what: r.what,
      why: r.why,
      amount_cents: r.cents,
      approved_by: r.approved_by,
    });
    people.set(r.user_id, p);
  }
  return [...people.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.user_id < b.user_id ? -1 : 1,
  );
}

/** Where a check sits: its room, its tab's name, or its number. */
const WHERE = `coalesce((select r.name from room_sessions rs join rooms r on r.venue_id = rs.venue_id and r.id = rs.room_id
                          where rs.venue_id = k.venue_id and rs.id = k.room_session_id),
                        (select t.name from tabs t where t.venue_id = k.venue_id and t.check_id = k.id), '#' || k.number)`;

/** Every staff action from `from` to `to` (business dates, both included), one row each. */
export async function staffActionRows(
  c: Queryable,
  venueId: string,
  from: string,
  to: string,
): Promise<StaffActionRow[]> {
  const r = await c.query<{
    who: string;
    name: string;
    kind: StaffActionKind;
    at: string;
    business_date: string;
    where: string | null;
    what: string | null;
    why: string | null;
    cents: string;
    approver: string | null;
  }>(
    `select x.who, u.name, x.kind, to_json(x.at) #>> '{}' as at, x.business_date::text as business_date,
            x.where, x.what, x.why, x.cents::text as cents, au.name as approver
       from (
         select l.added_by as who, l.kind, l.added_at as at, l.business_date, ${WHERE} as where,
                l.description as what, l.reason as why,
                l.amount_cents + coalesce((select sum(p.amount_cents) from live_check_lines p
                                            where p.venue_id = l.venue_id and p.part_of_id = l.id), 0) as cents,
                l.approved_by as approver
           from live_check_lines l join live_checks k on k.venue_id = l.venue_id and k.id = l.check_id
          where l.venue_id = $1 and l.business_date between $2::date and $3::date
            and l.kind in ('comp', 'void') and l.part_of_id is null
         union all
         select d.added_by, 'discount', d.added_at, d.business_date, ${WHERE},
                case when d.mode = 'pct' then trim_scale(d.pct)::text || '%' else null end, d.reason,
                coalesce(nullif((select sum(l.amount_cents) from live_check_lines l
                                  where l.venue_id = d.venue_id and l.check_id = d.check_id and l.kind = 'discount'), 0),
                         -d.counted_cents),
                d.approved_by
           from check_discounts d join live_checks k on k.venue_id = d.venue_id and k.id = d.check_id
          where d.venue_id = $1 and d.business_date between $2::date and $3::date and d.removed_at is null
         union all
         select f.requested_by, 'refund', f.requested_at, f.business_date,
                case when k.id is null then null else ${WHERE} end, null, f.reason, f.amount_cents, f.approved_by
           from refunds f join live_payments pay on pay.venue_id = f.venue_id and pay.id = f.payment_id
           left join live_checks k on k.venue_id = f.venue_id and k.id = f.check_id
          where f.venue_id = $1 and f.business_date between $2::date and $3::date
            and f.status not in ('failed', 'canceled')
         union all
         select m.taken_by, m.kind, m.at, coalesce(s.business_date, b.business_date),
                coalesce(cd.name, bu.name), null, m.reason, m.amount_cents, m.approved_by
           from drawer_moves m
           left join drawer_sessions s on s.venue_id = m.venue_id and s.id = m.drawer_session_id
           left join cash_drawers cd on cd.venue_id = s.venue_id and cd.id = s.drawer_id
           left join staff_banks b on b.venue_id = m.venue_id and b.id = m.staff_bank_id
           left join users bu on bu.id = b.user_id
          where m.venue_id = $1 and m.kind in ('no_sale', 'paid_out')
            and coalesce(s.business_date, b.business_date) between $2::date and $3::date
         union all
         select s.counted_by, 'over_short', s.counted_at, s.business_date, cd.name, null, s.note,
                s.over_short_cents, s.approved_by
           from drawer_sessions s join cash_drawers cd on cd.venue_id = s.venue_id and cd.id = s.drawer_id
          where s.venue_id = $1 and s.business_date between $2::date and $3::date
            and s.counted_by is not null and coalesce(s.over_short_cents, 0) <> 0
         union all
         -- A punch's night is its own business date (local time less the cutover), wherever it was moved to.
         select p.edited_by, 'punch_edit', p.at,
                ((p.at at time zone v.time_zone) - v.day_cutover::interval)::date, p.kind,
                pu.name, p.reason, 0, null
           from time_punches p
           join venues v on v.id = p.venue_id
           join memberships pm on pm.venue_id = p.venue_id and pm.id = p.membership_id
           join users pu on pu.id = pm.user_id
          where p.venue_id = $1 and p.edited_by is not null
            and p.at >= ($2::date + v.day_cutover) at time zone v.time_zone
            and p.at < ($3::date + 1 + v.day_cutover) at time zone v.time_zone
         union all
         select t.cut_off_by, 'cut_off', t.cut_off_at, k.business_date, t.name, null, t.cut_off_reason, 0, null
           from tabs t join live_checks k on k.venue_id = t.venue_id and k.id = t.check_id
          where t.venue_id = $1 and k.business_date between $2::date and $3::date and t.cut_off_by is not null
       ) x
       join users u on u.id = x.who
       left join users au on au.id = x.approver`,
    [venueId, from, to],
  );
  return r.rows.map((x) => ({
    user_id: x.who,
    name: x.name,
    kind: x.kind,
    at: x.at,
    business_date: x.business_date,
    where: x.where,
    what: x.what,
    why: x.why,
    cents: Number(x.cents),
    approved_by: x.approver,
  }));
}
