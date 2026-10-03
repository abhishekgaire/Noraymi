import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { resolveVenueSlug, withVenue } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { S3Settings } from "../s3.js";
import { siteView } from "../site/site.js";

/**
 * `GET /v1/public/venues/{slug}/site?guests=&hours=` (M5-01): what the guest site renders, its published
 * words and every live fact, read on the venue's clock. Short-lived in the CDN (60 seconds), so a
 * settings or menu change shows within a minute.
 */
export function siteRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; s3: () => S3Settings },
): void {
  app.get<{ Params: { slug: string }; Querystring: { guests?: string; hours?: string } }>(
    "/v1/public/venues/:slug/site",
    { config: route({ principals: ["public"], module: "core", idempotency: "none" }) },
    async (request, reply) => {
      const venueId = await resolveVenueSlug(options.pool, request.params.slug);
      if (!venueId) throw new ApiError("not_found", "no such venue");
      const guests = Number(request.query.guests);
      const hours = Number(request.query.hours);
      const view = await withVenue(options.pool, { venueId, requestId: request.requestId }, (c) =>
        siteView(c, venueId, options.clock.now(), {
          ...(Number.isInteger(guests) ? { guests } : {}),
          ...(Number.isInteger(hours) ? { hours } : {}),
          s3: options.s3,
        }),
      );
      reply.header("Cache-Control", "public, max-age=0, s-maxage=60");
      return view;
    },
  );
}
