import type { FastifyInstance } from "fastify";
import { venueOnBackupInternet, venueVendorHealth, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * The venue's connection (M8-01; spec 09 · Outages):
 *   GET /v1/venues/{v}/connection   backup internet, Stripe's and Twilio's health, and the
 *                                   replayed offline orders waiting for Accept (M8-05)
 *
 * Every staff screen polls it: an answer is the last sync the Board's footer
 * shows ("Online · synced 4 s ago"), and no answer is the pink "Offline"
 * banner. vendor.health and the router's events make the screens fetch it at once.
 */
export function connectionRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const tonight = async (c: Queryable, venueId: string) => {
    const v = await venueClock(c, venueId);
    return businessDate(options.clock.now(), v.timeZone, v.dayCutover).businessDate.toString();
  };
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
          // Replayed offline orders asked to wait for a bartender's Accept (M8-05).
          replayed_waiting: (
            await c.query<{ n: number }>(
              `select (select count(*)::int from orders o
                where o.venue_id = $1 and o.source = 'offline' and o.status = 'held'
                  and (select k.training from checks k where k.venue_id = o.venue_id and k.id = o.check_id) = $2)
                -- Cash quick sales taken offline that the replay refused, until someone taps OK (U-16).
                + (select count(*)::int from offline_replays r
                    where r.venue_id = $1 and not $2 and r.kind = 'cash_sale' and r.outcome = 'failed'
                      and r.seen_at is null and (r.queued_on = $3::date or r.replayed_on = $3::date)) as n`,
              [venueId, request.training, await tonight(c, venueId)],
            )
          ).rows[0]!.n,
          vendors: {
            stripe: vendors.stripe.trouble ? "trouble" : "ok",
            twilio: vendors.twilio.trouble ? "trouble" : "ok",
          },
        };
      }),
  );
}
