import type { FastifyInstance } from "fastify";
import { insertPrintJob } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { htmlToPdf } from "../menu/pdf.js";
import { breakGlassCard, breakGlassHtml, breakGlassLines } from "../payments/break-glass.js";

/**
 * The break-glass card on Close the night (M8-06; spec 09 · Break-glass card), owners and managers:
 *   GET  /v1/venues/{v}/break-glass-card         who's ready for Tap to Pay, as the card will print it
 *   GET  /v1/venues/{v}/break-glass-card/pdf     { pdf (base64), filename }: the letter-size card, English then Spanish
 *   POST /v1/venues/{v}/break-glass-card/print   the short version on the front-desk receipt printer
 * The PDF is printed by the menu PDF job's renderer (Chromium, tagged), outside any transaction.
 */
export function breakGlassRoutes(
  app: FastifyInstance,
  options: { clock: Clock; pdf?: (html: string) => Promise<Uint8Array> },
): void {
  const config = route({
    principals: ["owner_manager"],
    module: "core",
    action: "night.close",
    idempotency: "optional",
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/break-glass-card",
    { config },
    async (request) => {
      const venueId = request.venueId!;
      return request.inVenue((c) => breakGlassCard(c, venueId, options.clock.now()));
    },
  );

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/break-glass-card/pdf",
    { config },
    async (request) => {
      const venueId = request.venueId!;
      const card = await request.inVenue((c) => breakGlassCard(c, venueId, options.clock.now()));
      const pdf = await (options.pdf ?? htmlToPdf)(breakGlassHtml(card));
      return { pdf: Buffer.from(pdf).toString("base64"), filename: "break-glass-card.pdf" };
    },
  );

  app.post<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/break-glass-card/print",
    { config },
    async (request) => {
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        // The front-desk receipt printer: the one the front-desk drawer kicks through (as the X and Z reports).
        const printer = (
          await c.query<{ id: string }>(
            "select printer_device_id as id from cash_drawers where venue_id = $1 and station = 'front_desk' and printer_device_id is not null",
            [venueId],
          )
        ).rows[0];
        if (!printer) throw new ApiError("invalid_request", "there's no front-desk printer paired");
        const card = await breakGlassCard(c, venueId, now);
        const job = await insertPrintJob(c, venueId, {
          kind: "break_glass",
          station: "front_desk",
          deviceId: printer.id,
          payload: { lines: breakGlassLines(card) },
          createdAt: now.toString(),
        });
        return { print_job_id: job };
      });
    },
  );
}
