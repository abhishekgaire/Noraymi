import type { FastifyInstance } from "fastify";
import type { Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { monthCsv, nightFigures, sumFigures, type MonthReport } from "../nights/month.js";
import type { NightReport } from "../nights/report.js";

/**
 * The month (P-07; Money rules 16; spec 08 · Reports and exports
 * `/reports/month`): `GET /v1/venues/{v}/reports/month?month=YYYY-MM` (this
 * business date's month when left out) lists the month's closed nights from
 * their stored Z reports and totals them; `&format=csv` exports it and asks
 * for the passkey again, as every export does. Owners and managers, under
 * Reports & accounting; the 5-second statement limit of every report.
 */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function monthReport(
  c: Queryable,
  venueId: string,
  month: string,
  today: Temporal.PlainDate,
): Promise<MonthReport> {
  const ym = Temporal.PlainYearMonth.from(month);
  const from = ym.toPlainDate({ day: 1 });
  const to = ym.toPlainDate({ day: ym.daysInMonth });
  const closes = (
    await c.query<{ business_date: string; z_number: string; report: NightReport | null }>(
      `select business_date::text, z_number::text, totals -> 'report' as report from night_closes
        where venue_id = $1 and business_date between $2::date and $3::date order by business_date`,
      [venueId, from.toString(), to.toString()],
    )
  ).rows;
  const dates = closes.map((x) => x.business_date);
  // Room hours: each closed night's billed (unpaused) segment minutes, practice left out.
  const minutes = new Map(
    (
      await c.query<{ business_date: string; minutes: string }>(
        `select s.business_date::text,
                coalesce(sum(round(extract(epoch from (coalesce(g.ended_at, s.ended_at) - g.started_at)) / 60)), 0)::bigint::text as minutes
           from session_segments g join room_sessions s on s.venue_id = g.venue_id and s.id = g.session_id
          where g.venue_id = $1 and s.business_date = any($2::date[]) and not s.training
            and not g.paused and coalesce(g.ended_at, s.ended_at) is not null
          group by s.business_date`,
        [venueId, dates],
      )
    ).rows.map((r) => [r.business_date, Number(r.minutes)]),
  );
  const nights = closes
    .filter((x) => x.report !== null)
    .map((x) => ({
      business_date: x.business_date,
      z_number: Number(x.z_number),
      ...nightFigures(x.report!, minutes.get(x.business_date) ?? 0),
    }));
  // Past nights in the month with sales or payments and no close: named, never counted.
  const lastPast = Temporal.PlainDate.compare(to, today) < 0 ? to : today.subtract({ days: 1 });
  const notClosed =
    Temporal.PlainDate.compare(lastPast, from) < 0
      ? []
      : (
          await c.query<{ d: string }>(
            `select d::date::text as d from generate_series($2::date, $3::date, interval '1 day') d
              where not exists (select 1 from night_closes n where n.venue_id = $1 and n.business_date = d::date)
                and (exists (select 1 from live_check_lines l where l.venue_id = $1 and l.business_date = d::date)
                  or exists (select 1 from live_payments p where p.venue_id = $1 and p.business_date = d::date))
              order by 1`,
            [venueId, from.toString(), lastPast.toString()],
          )
        ).rows.map((r) => r.d);
  return {
    month: ym.toString(),
    from: from.toString(),
    to: to.toString(),
    in_progress: Temporal.PlainDate.compare(to, today) >= 0,
    not_closed: notClosed,
    nights,
    totals: sumFigures(nights),
  };
}

export function monthReportRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string }; Querystring: { month?: string; format?: string } }>(
    "/v1/venues/:venueId/reports/month",
    { config: route({ principals: ["owner_manager"], module: "reports", action: "admin.access" }) },
    async (request) => {
      const venueId = request.venueId!;
      if (request.query.month !== undefined && !MONTH.test(request.query.month))
        throw new ApiError("invalid_request", "send ?month=YYYY-MM");
      // Exporting asks for the passkey again (spec 02).
      if (request.query.format === "csv") await request.server.consumeStepUp!(request);
      return request.inReports(async (c) => {
        await c.query("set local statement_timeout = 5000");
        const v = await venueClock(c, venueId);
        const today = businessDate(options.clock.now(), v.timeZone, v.dayCutover).businessDate;
        const month = request.query.month ?? today.toString().slice(0, 7);
        const report = await monthReport(c, venueId, month, today);
        return request.query.format === "csv"
          ? { filename: `west4-month-${report.month}.csv`, file: monthCsv(report) }
          : report;
      });
    },
  );
}
