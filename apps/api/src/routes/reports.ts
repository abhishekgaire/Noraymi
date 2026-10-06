import type { FastifyInstance, FastifyRequest } from "fastify";
import { templates, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Reports (M7-18; spec 08 · Reports and exports, Conventions: reports on a
 * read replica with a 5-second limit; screens DeskReports, Reports, N38):
 *   GET /v1/venues/{v}/reports/sales?to=          nights' sales before tax and gratuity; weeks Fri to Thu;
 *                                                 8-week trends; the average by weekday; best sellers
 *   GET /v1/venues/{v}/reports/occupancy?date=    rooms in use by hour, of the venue's rooms
 *   GET /v1/venues/{v}/reports/bookings?to=       online, walk-ins seated, big parties, stayed past booked
 *                                                 time, no-shows with the deposit kept, the no-show rate by week
 *   GET /v1/venues/{v}/reports/staff-actions?date= per person: comps, voids, refunds asked and approved,
 *                                                 cut-offs, no-sales, paid-outs, drawers over or short, punch edits
 *   GET /v1/venues/{v}/reports/exceptions?date=   every comp, void and refund, approved or not
 * Owners and managers; all under Reports & accounting, which answers 404
 * module_off when it's off (the Z report stays on Night). Every query runs
 * with a 5-second statement limit; practice is left out (live views). Weeks
 * before go-live come from `legacy_nightly_totals`.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function today(c: Queryable, venueId: string, now: Temporal.Instant) {
  const v = await venueClock(c, venueId);
  return businessDate(now, v.timeZone, v.dayCutover).businessDate;
}

/** Fri to Thu: the Friday a business date's week starts on. */
const weekStart = (d: Temporal.PlainDate) => d.subtract({ days: (d.dayOfWeek - 5 + 7) % 7 });

export function reportRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const config = route({
    principals: ["owner_manager"],
    module: "reports",
    action: "admin.access",
  });
  /** A report's queries, with the 5-second limit (spec 08 · Conventions). */
  const run = <T>(request: FastifyRequest, work: (c: Queryable) => Promise<T>) =>
    request.inVenue(async (c) => {
      await c.query("set local statement_timeout = 5000");
      return work(c);
    });
  const dateOf = async (c: Queryable, request: FastifyRequest, raw: string | undefined) => {
    if (raw !== undefined && !DATE.test(raw))
      throw new ApiError("invalid_request", "dates are YYYY-MM-DD");
    return raw ? Temporal.PlainDate.from(raw) : today(c, request.venueId!, options.clock.now());
  };

  app.get<{ Params: { venueId: string }; Querystring: { to?: string } }>(
    "/v1/venues/:venueId/reports/sales",
    { config },
    async (request) =>
      run(request, async (c) => {
        const venueId = request.venueId!;
        const to = await dateOf(c, request, request.query.to);
        const from = weekStart(to).subtract({ weeks: 7 });
        const nights = (
          await c.query<{ date: string; net: string; rooms: string; bar: string; legacy: boolean }>(
            `with live as (
               select l.business_date as d,
                      sum(l.amount_cents) filter (where l.kind not in ('tax', 'gratuity')) as net,
                      sum(l.amount_cents) filter (where l.kind not in ('tax', 'gratuity') and k.kind = 'room') as rooms,
                      sum(l.amount_cents) filter (where l.kind not in ('tax', 'gratuity') and k.kind in ('bar', 'quick')) as bar
                 from live_check_lines l join live_checks k on k.venue_id = l.venue_id and k.id = l.check_id
                where l.venue_id = $1 and l.business_date between $2::date and $3::date
                group by l.business_date)
             select coalesce(live.d, g.business_date)::text as date,
                    coalesce(live.net, g.net_sales_cents, 0)::text as net,
                    coalesce(live.rooms, g.rooms_cents, 0)::text as rooms,
                    coalesce(live.bar, g.bar_cents, 0)::text as bar,
                    live.d is null as legacy
               from live full join (select * from legacy_nightly_totals
                                     where venue_id = $1 and business_date between $2::date and $3::date) g
                 on g.business_date = live.d
              order by 1`,
            [venueId, from.toString(), to.toString()],
          )
        ).rows.map((r) => ({
          date: r.date,
          net_cents: Number(r.net),
          rooms_cents: Number(r.rooms),
          bar_cents: Number(r.bar),
          legacy: r.legacy,
        }));
        const weeks = Array.from({ length: 8 }, (_, i) => {
          const start = weekStart(to).subtract({ weeks: 7 - i });
          const end = start.add({ days: 6 });
          const inWeek = nights.filter(
            (n) => n.date >= start.toString() && n.date <= end.toString(),
          );
          return {
            start: start.toString(),
            end: end.toString(),
            net_cents: inWeek.reduce((s, n) => s + n.net_cents, 0),
            nights: inWeek.length,
          };
        });
        const byWeekday = [1, 2, 3, 4, 5, 6, 7].map((dow) => {
          const days = nights.filter((n) => Temporal.PlainDate.from(n.date).dayOfWeek === dow);
          return {
            weekday: dow,
            average_cents:
              days.length === 0
                ? 0
                : Math.round(days.reduce((s, n) => s + n.net_cents, 0) / days.length),
          };
        });
        const best = (
          await c.query<{ kind: string; what: string; qty: string; cents: string }>(
            `select case when k.kind = 'room' then 'rooms' else 'bar' end as kind, l.description as what,
                    sum(l.qty)::text as qty, sum(l.amount_cents)::text as cents
               from live_check_lines l join live_checks k on k.venue_id = l.venue_id and k.id = l.check_id
              where l.venue_id = $1 and l.kind = 'item' and l.business_date between $2::date and $3::date
              group by 1, 2 order by 1, sum(l.amount_cents) desc`,
            [venueId, weekStart(to).toString(), to.toString()],
          )
        ).rows;
        const top = (kind: string) =>
          best
            .filter((b) => b.kind === kind)
            .slice(0, 5)
            .map((b) => ({ what: b.what, qty: Number(b.qty), cents: Number(b.cents) }));
        const reviewAsk = (await templates(c, venueId)).find((t) => t.key === "review_ask");
        return {
          to: to.toString(),
          this_week: weeks[7],
          nights: nights.filter((n) => n.date >= weekStart(to).toString()),
          weeks,
          by_weekday: byWeekday,
          best_sellers: { rooms: top("rooms"), bar: top("bar") },
          // "Reviews from the morning text": Off while the Review ask text is off.
          reviews: { review_ask_on: reviewAsk?.on ?? false },
        };
      }),
  );

  app.get<{ Params: { venueId: string }; Querystring: { date?: string } }>(
    "/v1/venues/:venueId/reports/occupancy",
    { config },
    async (request) =>
      run(request, async (c) => {
        const venueId = request.venueId!;
        const date = await dateOf(c, request, request.query.date);
        const v = await venueClock(c, venueId);
        const start = date
          .toZonedDateTime({
            timeZone: v.timeZone,
            plainTime: Temporal.PlainTime.from(v.dayCutover),
          })
          .toInstant();
        const rooms = Number(
          (
            await c.query<{ n: string }>(
              "select count(*)::text as n from rooms where venue_id = $1 and archived_at is null",
              [venueId],
            )
          ).rows[0]!.n,
        );
        const sessions = (
          await c.query<{ s: Date; e: Date | null }>(
            "select started_at as s, ended_at as e from room_sessions where venue_id = $1 and business_date = $2::date and not training",
            [venueId, date.toString()],
          )
        ).rows;
        const now = options.clock.now().epochMilliseconds;
        const hours = Array.from({ length: 24 }, (_, i) => {
          const a = start.add({ hours: i }).epochMilliseconds;
          const b = a + 3_600_000;
          return {
            hour: start.add({ hours: i }).toZonedDateTimeISO(v.timeZone).hour,
            in_use: sessions.filter((x) => x.s.getTime() < b && (x.e ? x.e.getTime() : now) > a)
              .length,
          };
        });
        return { date: date.toString(), rooms, hours };
      }),
  );

  app.get<{ Params: { venueId: string }; Querystring: { to?: string } }>(
    "/v1/venues/:venueId/reports/bookings",
    { config },
    async (request) =>
      run(request, async (c) => {
        const venueId = request.venueId!;
        const to = await dateOf(c, request, request.query.to);
        const from = weekStart(to).subtract({ weeks: 7 });
        const r = await c.query<{
          week: string;
          online: string;
          walk_ins: string;
          big: string;
          past_time: string;
          no_shows: string;
          kept: string;
          booked: string;
        }>(
          `with b as (
             select business_date, source, party_size, status, deposit_cents from bookings
              where venue_id = $1 and business_date between $2::date and $3::date),
           s as (
             select business_date, booking_id, booked_end_at, ended_at from room_sessions
              where venue_id = $1 and business_date between $2::date and $3::date and not training)
           select w::date::text as week,
                  (select count(*) from b where b.business_date between w::date and w::date + 6 and b.source = 'web')::text as online,
                  (select count(*) from s where s.business_date between w::date and w::date + 6 and s.booking_id is null)::text as walk_ins,
                  (select count(*) from b where b.business_date between w::date and w::date + 6 and b.party_size >= 20)::text as big,
                  (select count(*) from s where s.business_date between w::date and w::date + 6
                      and s.booked_end_at is not null and s.ended_at > s.booked_end_at)::text as past_time,
                  (select count(*) from b where b.business_date between w::date and w::date + 6 and b.status = 'no_show')::text as no_shows,
                  (select coalesce(sum(deposit_cents), 0) from b where b.business_date between w::date and w::date + 6
                      and b.status = 'no_show')::text as kept,
                  (select count(*) from b where b.business_date between w::date and w::date + 6)::text as booked
             from generate_series($2::date, $3::date, interval '7 days') w order by 1`,
          [venueId, from.toString(), weekStart(to).toString()],
        );
        return {
          to: to.toString(),
          weeks: r.rows.map((w) => ({
            start: w.week,
            booked_online: Number(w.online),
            walk_ins_seated: Number(w.walk_ins),
            big_parties: Number(w.big),
            stayed_past_booked_time: Number(w.past_time),
            no_shows: Number(w.no_shows),
            no_show_deposits_kept_cents: Number(w.kept),
            no_show_rate_pct:
              Number(w.booked) === 0
                ? 0
                : Math.round((Number(w.no_shows) * 1000) / Number(w.booked)) / 10,
          })),
        };
      }),
  );

  app.get<{ Params: { venueId: string }; Querystring: { date?: string } }>(
    "/v1/venues/:venueId/reports/staff-actions",
    { config },
    async (request) =>
      run(request, async (c) => {
        const venueId = request.venueId!;
        const date = (await dateOf(c, request, request.query.date)).toString();
        const r = await c.query<{ name: string; what: string; n: string; cents: string }>(
          `select u.name, x.what, count(*)::text as n, coalesce(sum(x.cents), 0)::text as cents from (
              select l.added_by as who, l.kind as what, l.amount_cents as cents from live_check_lines l
               where l.venue_id = $1 and l.business_date = $2::date and l.kind in ('comp', 'void')
              union all
              select f.requested_by, 'refund_asked', f.amount_cents from refunds f
               where f.venue_id = $1 and f.business_date = $2::date
              union all
              select f.approved_by, 'refund_approved', f.amount_cents from refunds f
               where f.venue_id = $1 and f.business_date = $2::date and f.approved_by is not null
              union all
              select t.cut_off_by, 'cut_off', 0 from tabs t join live_checks k on k.venue_id = t.venue_id and k.id = t.check_id
               where t.venue_id = $1 and k.business_date = $2::date and t.cut_off_by is not null
              union all
              select m.taken_by, m.kind, m.amount_cents from drawer_moves m join drawer_sessions s on s.venue_id = m.venue_id and s.id = m.drawer_session_id
               where m.venue_id = $1 and s.business_date = $2::date and m.kind in ('no_sale', 'paid_out')
              union all
              select s.counted_by, 'over_short', s.over_short_cents from drawer_sessions s
               where s.venue_id = $1 and s.business_date = $2::date and s.counted_by is not null
              union all
              select p.edited_by, 'punch_edit', 0 from time_punches p join shifts sh on sh.venue_id = p.venue_id
                and sh.membership_id = p.membership_id and p.at >= sh.started_at and (sh.ended_at is null or p.at <= sh.ended_at)
               where p.venue_id = $1 and sh.business_date = $2::date and p.edited_by is not null
            ) x join users u on u.id = x.who
           group by u.name, x.what order by u.name, x.what`,
          [venueId, date],
        );
        const people = new Map<string, Record<string, { count: number; cents: number }>>();
        for (const row of r.rows) {
          const p = people.get(row.name) ?? {};
          p[row.what] = { count: Number(row.n), cents: Number(row.cents) };
          people.set(row.name, p);
        }
        return { date, people: [...people].map(([name, actions]) => ({ name, actions })) };
      }),
  );

  app.get<{ Params: { venueId: string }; Querystring: { date?: string } }>(
    "/v1/venues/:venueId/reports/exceptions",
    { config },
    async (request) =>
      run(request, async (c) => {
        const venueId = request.venueId!;
        const date = (await dateOf(c, request, request.query.date)).toString();
        const where = `coalesce((select r.name from room_sessions rs join rooms r on r.venue_id = rs.venue_id and r.id = rs.room_id
                                  where rs.venue_id = k.venue_id and rs.id = k.room_session_id),
                                (select t.name from tabs t where t.venue_id = k.venue_id and t.check_id = k.id), '#' || k.number)`;
        // Done: comps and voids on the night's checks, with the approval behind any over the limit.
        const done = await c.query<{
          at: string;
          kind: string;
          where: string;
          what: string;
          why: string | null;
          asked: string | null;
          approved: string | null;
          cents: string;
        }>(
          `select to_json(l.added_at) #>> '{}' as at, l.kind, ${where} as where, l.description as what, l.reason as why,
                  au.name as asked,
                  (select pu.name from approvals a join users pu on pu.id = a.approver_id
                    where a.venue_id = l.venue_id and a.kind = l.kind and a.status = 'approved'
                      and a.target_id = l.check_id and a.amount_cents = abs(l.amount_cents) limit 1) as approved,
                  l.amount_cents::text as cents
             from live_check_lines l join live_checks k on k.venue_id = l.venue_id and k.id = l.check_id
             left join users au on au.id = l.added_by
            where l.venue_id = $1 and l.business_date = $2::date and l.kind in ('comp', 'void')`,
          [venueId, date],
        );
        // Asked and not done: comps, voids and refunds still waiting, or declined.
        const asked = await c.query<{
          at: string;
          kind: string;
          status: string;
          where: string;
          why: string;
          asked: string | null;
          routed: string | null;
          cents: string | null;
        }>(
          `select to_json(a.requested_at) #>> '{}' as at, a.kind, a.status, coalesce(${where}, '') as where, a.reason as why,
                  ru.name as asked, tu.name as routed, a.amount_cents::text as cents
             from approvals a
             left join live_checks k on k.venue_id = a.venue_id and k.id = a.target_id
             left join users ru on ru.id = a.requested_by
             left join users tu on tu.id = a.routed_to
            where a.venue_id = $1 and a.kind in ('comp', 'void', 'refund') and a.status in ('pending', 'declined')
              and (k.business_date = $2::date or k.id is null)`,
          [venueId, date],
        );
        const refunds = await c.query<{
          at: string;
          where: string;
          why: string;
          asked: string | null;
          approved: string | null;
          cents: string;
        }>(
          `select to_json(f.requested_at) #>> '{}' as at, coalesce(${where}, 'Deposit') as where, f.reason as why,
                  ru.name as asked, au.name as approved, f.amount_cents::text as cents
             from refunds f join live_payments p on p.venue_id = f.venue_id and p.id = f.payment_id
             left join live_checks k on k.venue_id = f.venue_id and k.id = f.check_id
             left join users ru on ru.id = f.requested_by
             left join users au on au.id = f.approved_by
            where f.venue_id = $1 and f.business_date = $2::date and f.status not in ('failed', 'canceled')`,
          [venueId, date],
        );
        const rows = [
          ...done.rows.map((x) => ({
            at: x.at,
            kind: x.kind,
            status: "done",
            where: x.where,
            what: x.what,
            why: x.why,
            asked_by: x.asked,
            approved_by: x.approved,
            amount_cents: Math.abs(Number(x.cents)),
          })),
          ...asked.rows.map((x) => ({
            at: x.at,
            kind: x.kind,
            status: x.status,
            where: x.where,
            what: x.kind,
            why: x.why,
            asked_by: x.asked,
            approved_by: x.status === "pending" ? null : x.routed,
            waiting_for: x.status === "pending" ? x.routed : null,
            amount_cents: Number(x.cents ?? 0),
          })),
          ...refunds.rows.map((x) => ({
            at: x.at,
            kind: "refund",
            status: "done",
            where: x.where,
            what: "Refund",
            why: x.why,
            asked_by: x.asked,
            approved_by: x.approved,
            amount_cents: Number(x.cents),
          })),
        ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
        return { date, exceptions: rows };
      }),
  );
}
