import type { FastifyInstance, FastifyRequest } from "fastify";
import { readSetting, rulePackFor } from "@west4/db";
import { Temporal, type Clock, type PaySettings } from "@west4/shared";
import { z } from "zod";
import type { EmailSettings } from "../email/settings.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { enqueueEmail } from "../jobs/send-email.js";
import { exportFile, payoutJournals } from "../nights/journal.js";
import {
  payrollCsv,
  payrollRows,
  poolMinutes,
  type Journal,
  type PayrollShift,
} from "@west4/rules";

/**
 * Export for QuickBooks (M7-15; spec 08 · Reports and exports; spec 02 ·
 * exports ask for the passkey again):
 *   GET  /v1/venues/{v}/exports/accounting?date=   the night's journal and the payouts that arrived that
 *                                                  day, in QuickBooks Online's journal import layout
 *   POST /v1/venues/{v}/exports/{e}/email          to the addresses the owner set
 * A night's journal exists once the night has closed; practice money never appears.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function exportRoutes(
  app: FastifyInstance,
  options: { clock: Clock; email: () => Pick<EmailSettings, "allowList"> },
): void {
  const config = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
    stepUp: true,
    idempotency: "optional",
  });

  app.get<{ Params: { venueId: string }; Querystring: { date?: string } }>(
    "/v1/venues/:venueId/exports/accounting",
    { config },
    async (request) => {
      const date = request.query.date ?? "";
      if (!DATE.test(date)) throw new ApiError("invalid_request", "send ?date=YYYY-MM-DD");
      // An export asks for the passkey again, download included (spec 02): the step-up is checked on reads too.
      await request.server.consumeStepUp!(request);
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const row = (
          await c.query<{ id: string; journals: Journal[] }>(
            "select id, journals from exports where venue_id = $1 and kind = 'accounting' and business_date = $2::date",
            [venueId, date],
          )
        ).rows[0];
        if (!row)
          throw new ApiError(
            "not_found",
            "that night hasn't closed: its journal posts at the close",
          );
        // The night's journal as posted, and every payout that arrived that day (they never change).
        const journals = [
          row.journals.find((j) => j.kind === "night")!,
          ...(await payoutJournals(c, venueId, date)),
        ];
        return {
          export_id: row.id,
          business_date: date,
          filename: `west4-${date}.csv`,
          file: await exportFile(c, venueId, date, journals),
          journals,
        };
      });
    },
  );

  const emailBody = z.object({}).strict();
  app.post<{ Params: { venueId: string; e: string }; Body: unknown }>(
    "/v1/venues/:venueId/exports/:e/email",
    { config },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.e).success)
        throw new ApiError("not_found", "no such export");
      if (!emailBody.safeParse(request.body ?? {}).success)
        throw new ApiError("invalid_request", "send {}");
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const row = (
          await c.query<{ business_date: string; journals: Journal[] }>(
            "select business_date::text, journals from exports where venue_id = $1 and id = $2",
            [venueId, request.params.e],
          )
        ).rows[0];
        if (!row) throw new ApiError("not_found", "no such export");
        const pay = (
          await readSetting(c, venueId, "pay", Temporal.PlainDate.from(row.business_date))
        )?.value as PaySettings | undefined;
        const to = pay?.accounting?.emailTo ?? [];
        if (to.length === 0)
          throw new ApiError(
            "invalid_request",
            "set where the nightly file goes in Admin → Connections",
            {
              details: { reason: "no_address" },
            },
          );
        const venue = (
          await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
        ).rows[0]!;
        const journals = [
          row.journals.find((j) => j.kind === "night")!,
          ...(await payoutJournals(c, venueId, row.business_date)),
        ];
        const file = await exportFile(c, venueId, row.business_date, journals);
        for (const address of to)
          await enqueueEmail(c, options.email(), {
            venueId,
            template: "accounting_export",
            to: address,
            locale: "en",
            data: { venueName: venue.name, date: row.business_date, file },
            runAt: now,
            dedupeKey: `accounting:${request.params.e}:${address}:${now.toString()}`,
          });
        await c.query(
          "update exports set emailed_at = $3, emailed_to = $4 where venue_id = $1 and id = $2",
          [venueId, request.params.e, now.toString(), to],
        );
        return { export_id: request.params.e, emailed_to: to };
      });
    },
  );

  /**
   * Payroll (M7-16): per person and shift the hours; per person and night the gratuity share in a wages
   * column and card and cash tips apart; totals. Only closed pools are in it, and each one included is
   * marked exported (locked). Asks for the passkey again, like every export.
   */
  const payroll = async (request: FastifyRequest, from: string, to: string) => {
    if (!DATE.test(from) || !DATE.test(to) || from > to)
      throw new ApiError("invalid_request", "send ?from=YYYY-MM-DD&to=YYYY-MM-DD");
    if (Temporal.PlainDate.from(from).until(to).days > 62)
      throw new ApiError("invalid_request", "two months at most per file");
    const venueId = request.venueId!;
    const now = options.clock.now();
    return request.inVenue(async (c) => {
      const shifts = await c.query<{
        user_id: string;
        name: string;
        role: string;
        duty: string;
        business_date: string;
        started_at: Date;
        ended_at: Date | null;
        break_minutes: number;
      }>(
        `select m.user_id, u.name, m.role, s.duty, s.business_date::text, s.started_at, s.ended_at, s.break_minutes
           from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
           join users u on u.id = m.user_id
          where s.venue_id = $1 and s.business_date between $2::date and $3::date
          order by s.business_date, s.started_at`,
        [venueId, from, to],
      );
      const shares = await c.query<{
        user_id: string;
        name: string;
        duty: string;
        night: string;
        gratuity: string;
        card: string;
        cash: string;
      }>(
        `select t.user_id, u.name, min(t.duty) as duty, p.business_date::text as night,
                sum(t.gratuity_cents)::text as gratuity, sum(t.card_tip_cents)::text as card, sum(t.cash_tip_cents)::text as cash
           from tip_shares t join tip_pools p on p.venue_id = t.venue_id and p.id = t.pool_id
           join users u on u.id = t.user_id
          where t.venue_id = $1 and p.business_date between $2::date and $3::date and p.status in ('closed', 'exported')
          group by t.user_id, u.name, p.business_date`,
        [venueId, from, to],
      );
      const shareOf = new Map(
        shares.rows.map((x) => [
          `${x.user_id}|${x.night}`,
          {
            gratuity_cents: Number(x.gratuity),
            card_tip_cents: Number(x.card),
            cash_tip_cents: Number(x.cash),
          },
        ]),
      );
      const rows: PayrollShift[] = shifts.rows.map((x) => ({
        name: x.name,
        role: x.role,
        duty: x.duty,
        business_date: x.business_date,
        clock_in: x.started_at.toISOString(),
        clock_out: x.ended_at?.toISOString() ?? null,
        break_minutes: x.break_minutes,
        minutes: poolMinutes(
          x.started_at.getTime(),
          (x.ended_at ?? new Date(now.epochMilliseconds)).getTime(),
          x.break_minutes,
        ),
        share: shareOf.get(`${x.user_id}|${x.business_date}`) ?? null,
      }));
      // A share on a night the person didn't clock in (late tips for an earlier night) still gets its row.
      const withShift = new Set(shifts.rows.map((x) => `${x.user_id}|${x.business_date}`));
      for (const x of shares.rows)
        if (!withShift.has(`${x.user_id}|${x.night}`))
          rows.push({
            name: x.name,
            role: "",
            duty: x.duty,
            business_date: x.night,
            clock_in: "",
            clock_out: null,
            break_minutes: 0,
            minutes: 0,
            share: shareOf.get(`${x.user_id}|${x.night}`)!,
          });
      const v = (
        await c.query<{ rule_pack_id: string | null }>(
          "select rule_pack_id from venues where id = $1",
          [venueId],
        )
      ).rows[0];
      const pack = await rulePackFor(
        c,
        v?.rule_pack_id ?? "us-ny-new-york-county",
        Temporal.PlainDate.from(to),
      );
      const file = payrollCsv(payrollRows(rows, pack?.pack.wages.tipCreditCents ?? 0));
      // Each closed pool in the file is exported now: locked for good.
      const exported = await c.query(
        `update tip_pools set status = 'exported', exported_at = $4
          where venue_id = $1 and business_date between $2::date and $3::date and status = 'closed'`,
        [venueId, from, to, now.toString()],
      );
      return {
        filename: `west4-payroll-${from}-to-${to}.csv`,
        file,
        pools_exported: exported.rowCount ?? 0,
      };
    });
  };

  app.get<{ Params: { venueId: string }; Querystring: { from?: string; to?: string } }>(
    "/v1/venues/:venueId/exports/payroll",
    { config },
    async (request) => {
      await request.server.consumeStepUp!(request);
      return payroll(request, request.query.from ?? "", request.query.to ?? "");
    },
  );

  const payrollEmail = z.object({ from: z.string(), to: z.string() }).strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/exports/payroll/email",
    { config },
    async (request) => {
      const parsed = payrollEmail.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { from, to }");
      const made = await payroll(request, parsed.data.from, parsed.data.to);
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const pay = (await readSetting(c, venueId, "pay", Temporal.PlainDate.from(parsed.data.to)))
          ?.value as PaySettings | undefined;
        const addresses = pay?.accounting?.emailTo ?? [];
        if (addresses.length === 0)
          throw new ApiError("invalid_request", "set where the files go in Admin → Connections", {
            details: { reason: "no_address" },
          });
        const venue = (
          await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
        ).rows[0]!;
        for (const address of addresses)
          await enqueueEmail(c, options.email(), {
            venueId,
            template: "accounting_export",
            to: address,
            locale: "en",
            data: {
              venueName: venue.name,
              date: `${parsed.data.from} to ${parsed.data.to}`,
              file: made.file,
              kind: "payroll",
            },
            runAt: options.clock.now(),
            dedupeKey: `payroll:${parsed.data.from}:${parsed.data.to}:${address}:${options.clock.now().toString()}`,
          });
        return { emailed_to: addresses };
      });
    },
  );
}
