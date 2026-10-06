import type { FastifyInstance } from "fastify";
import { venueOnBackupInternet, venueVendorHealth } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";

/**
 * The venue's connection (M8-01; spec 09 · Outages):
 *   GET /v1/venues/{v}/connection   backup internet, and Stripe's and Twilio's health
 *
 * Every staff screen polls it: an answer is the last sync the Board's footer
 * shows ("Online · synced 4 s ago"), and no answer is the pink "Offline"
 * banner. vendor.health and the router's events make the screens fetch it at once.
 */
export function connectionRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/connection",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const vendors = await venueVendorHealth(c, venueId);
        return {
          server_time: options.clock.now().toString(),
          backup_internet: await venueOnBackupInternet(c, venueId),
          vendors: {
            stripe: vendors.stripe.trouble ? "trouble" : "ok",
            twilio: vendors.twilio.trouble ? "trouble" : "ok",
          },
        };
      }),
  );
}
