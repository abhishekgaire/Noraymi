import type { FastifyInstance } from "fastify";
import { readSetting } from "@west4/db";
import { Temporal, type Clock, type PaySettings } from "@west4/shared";
import { z } from "zod";
import type { EmailSettings } from "../email/settings.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { enqueueEmail } from "../jobs/send-email.js";
import { exportFile, payoutJournals } from "../nights/journal.js";
import type { Journal } from "@west4/rules";

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
}
