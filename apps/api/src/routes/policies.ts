import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { currentPolicy, resolveVenueSlug, withVenue } from "@west4/db";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * The deposit policy guests accept (M5-06; Data model · policy_versions):
 *   GET /v1/venues/{v}/policy-versions          every version, newest first (Admin → Deposits & cancelling)
 *   GET /v1/public/venues/{slug}/policy         the current words, version and hash (Book and Manage)
 * Saving the deposit or pay settings writes the next version (routes/settings.ts). Neither route
 * is in the API table; they're the cautious default, flagged.
 */
export function policyRoutes(app: FastifyInstance, options: { pool: pg.Pool }): void {
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/policy-versions",
    { config: route({ principals: ["owner_manager"], module: "core", action: "admin.access" }) },
    async (request) => {
      const rows = await request.inVenue(
        async (c) =>
          (
            await c.query<{
              id: string;
              version: number;
              text: string;
              hash: string;
              published_at: string;
              published_by: string | null;
            }>(
              `select p.id, p.version, p.text, p.hash, p.published_at, u.name as published_by
                 from policy_versions p left join users u on u.id = p.published_by
                where p.venue_id = $1 and p.kind = 'deposit' order by p.version desc limit 50`,
              [request.venueId],
            )
          ).rows,
      );
      return { versions: rows };
    },
  );

  // Read whatever the modules say: a guest managing an existing booking still sees its terms.
  app.get<{ Params: { slug: string } }>(
    "/v1/public/venues/:slug/policy",
    { config: route({ principals: ["public"], module: "core", idempotency: "none" }) },
    async (request, reply) => {
      const venueId = await resolveVenueSlug(options.pool, request.params.slug);
      if (!venueId) throw new ApiError("not_found", "no such venue");
      const policy = await withVenue(options.pool, { venueId, requestId: request.requestId }, (c) =>
        currentPolicy(c, venueId),
      );
      if (!policy) throw new ApiError("not_found", "this venue has no policy yet");
      reply.header("Cache-Control", "public, max-age=0, s-maxage=60");
      return { id: policy.id, version: policy.version, text: policy.text, hash: policy.hash };
    },
  );
}
