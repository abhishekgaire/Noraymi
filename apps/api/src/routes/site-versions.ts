import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { S3Settings } from "../s3.js";
import { publishDraft, republish, saveDraft, siteVersions } from "../site/versions.js";

interface VenueParams {
  venueId: string;
}

/**
 * Admin → Website (M5-02). The API names no routes for site_versions; these four are the
 * cautious default, flagged in the ticket:
 *   GET  /v1/venues/{v}/site-versions                  the draft, every published version, each section's state
 *   PUT  /v1/venues/{v}/site-versions/draft            save the draft's words, photos and hidden sections
 *   POST /v1/venues/{v}/site-versions/draft/publish    the draft goes live
 *   POST /v1/venues/{v}/site-versions/{n}/republish    an earlier version goes live again
 * Admin, so a passkey session only; the website module must be on.
 */
export function siteVersionsRoutes(
  app: FastifyInstance,
  options: { clock: Clock; s3: () => S3Settings },
): void {
  const read = route({ principals: ["owner_manager"], module: "website", action: "admin.access" });
  const write = route({
    principals: ["owner_manager"],
    module: "website",
    action: "admin.access",
    idempotency: "optional",
  });
  const by = (request: FastifyRequest) => ({
    userId: request.principal.kind === "user" ? request.principal.userId : null,
    now: options.clock.now(),
  });

  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/site-versions",
    { config: read },
    async (request) => request.inVenue((c) => siteVersions(c, request.venueId!, options.s3)),
  );

  app.put<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/site-versions/draft",
    { config: write },
    async (request) =>
      request.inVenue(async (c) => {
        await saveDraft(c, request.venueId!, request.body, by(request));
        return siteVersions(c, request.venueId!, options.s3);
      }),
  );

  app.post<{ Params: VenueParams }>(
    "/v1/venues/:venueId/site-versions/draft/publish",
    { config: write },
    async (request) => request.inVenue((c) => publishDraft(c, request.venueId!, by(request))),
  );

  app.post<{ Params: VenueParams & { version: string } }>(
    "/v1/venues/:venueId/site-versions/:version/republish",
    { config: write },
    async (request) => {
      const version = Number(request.params.version);
      if (!Number.isInteger(version) || version < 1)
        throw new ApiError("invalid_request", "the version is a whole number");
      return request.inVenue((c) => republish(c, request.venueId!, version, by(request)));
    },
  );
}
