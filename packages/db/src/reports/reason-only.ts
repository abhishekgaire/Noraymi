import type { Queryable } from "../tenancy.js";

/*
 * Report code (M7-03): every query here reads the live views (live_checks,
 * live_check_lines, live_payments), never the base tables, so a practice
 * check from training mode never reaches a total. The lint rule
 * west4/live-views-only fails a read of the base tables in this folder.
 */

/**
 * A person's reason-only comps and voids so far (M2-14; spec 02): their comp
 * and void lines with a reason and no approver, from every screen, on live
 * checks only: a practice check from training mode never counts (M7-03). Since M7-01 the
 * window is their open shift; with no open shift it's the business date,
 * which can only make the limit stricter.
 */
export async function reasonOnlyUsed(
  c: Queryable,
  venueId: string,
  userId: string,
  businessDate: string,
): Promise<number> {
  const r = await c.query<{ used: string }>(
    `with shift as (
       select s.started_at from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
        where s.venue_id = $1 and m.user_id = $2 and s.ended_at is null)
     select coalesce(sum(abs(l.amount_cents)), 0)::text as used
       from live_check_lines l
      where l.venue_id = $1 and l.added_by = $2
        and l.kind in ('comp', 'void') and l.approved_by is null
        -- Food removed before it was sent to the kitchen needs no reason or approval (K-05).
        and not (l.kind = 'void' and exists (
              select 1 from live_check_lines r join order_items oi on oi.venue_id = r.venue_id and oi.id = r.source_id
               where r.venue_id = l.venue_id and r.id = l.reverses_id
                 and oi.station = 'kitchen' and oi.kitchen_sent_at is null
                 and exists (select 1 from orders o where o.venue_id = oi.venue_id and o.id = oi.order_id
                               and o.source = 'staff')))
        and case when exists (select 1 from shift) then l.added_at >= (select started_at from shift)
                 else l.business_date = $3 end`,
    [venueId, userId, businessDate],
  );
  return Number(r.rows[0]!.used);
}
