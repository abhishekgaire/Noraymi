import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { resolveVenueSlug, withVenue } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { page, parseListQuery } from "../http/paging.js";
import { enquiryBody, listEnquiries, takeEnquiry } from "../enquiries/enquiries.js";

/**
 * Private-party enquiries (M5-04; API · Enquiries):
 *   POST /v1/public/venues/{slug}/enquiries   { name, phone, party_size, date, message? }: into Messages
 *   GET  /v1/venues/{v}/enquiries?after=      newest first, for staff
 * The CAPTCHA and daily limits join the public route with M5-05 (blocked on M2-27's provider and numbers).
 */
export function enquiriesRoutes(app: FastifyInstance, options: { pool: pg.Pool; clock: Clock }) {
  app.post<{ Params: { slug: string }; Body: unknown }>(
    "/v1/public/venues/:slug/enquiries",
    { config: route({ principals: ["public"], module: "website", idempotency: "none" }) },
    async (request, reply) => {
      const parsed = enquiryBody.safeParse(request.body);
      if (!parsed.success) {
        const phone = parsed.error.issues.some((i) => i.path[0] === "phone");
        throw new ApiError(
          "invalid_request",
          phone
            ? "a US mobile number, like +12125550100: we reply by text"
            : "send { name, phone, party_size, date, message? }",
          { details: { reason: phone ? "phone" : "body" } },
        );
      }
      const venueId = await resolveVenueSlug(options.pool, request.params.slug);
      if (!venueId) throw new ApiError("not_found", "no such venue");
      const made = await withVenue(options.pool, { venueId, requestId: request.requestId }, (c) =>
        takeEnquiry(c, venueId, parsed.data, options.clock.now()),
      );
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send({ id: made.id });
    },
  );

  app.get<{ Params: { venueId: string }; Querystring: Record<string, string> }>(
    "/v1/venues/:venueId/enquiries",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "website",
        action: "texts.send",
      }),
    },
    async (request) => {
      const q = parseListQuery(request.query);
      const rows = await request.inVenue((c) =>
        listEnquiries(c, request.venueId!, { after: q.after ?? null, limit: q.limit }),
      );
      return page(rows, q.limit, (r) => new Date(r.created_at).toISOString());
    },
  );
}
