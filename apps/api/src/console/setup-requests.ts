import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { consoleVenue, finishSetupRequest, listSetupRequests } from "@west4/db";
import type { Clock } from "@west4/shared";
import { downloadLink } from "../files/storage.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { S3Settings } from "../s3.js";

/**
 * Requests from Set up your venue in the Console (O-10; spec 17 · Step details 8): a menu sent as
 * a PDF or a photo for our team to type in. Our staff open the file through a short-lived link,
 * type the menu in (Admin → Menu, under a support grant, or the importer), then mark it done.
 *   GET  /v1/console/venues/{v}/setup-requests
 *   GET  /v1/console/venues/{v}/setup-requests/{id}/file
 *   POST /v1/console/venues/{v}/setup-requests/{id}/done
 */
export function setupRequestConsoleRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; s3: () => S3Settings },
): void {
  const read = route({ principals: ["console"], module: "core" });
  const write = route({ principals: ["console"], module: "core", idempotency: "optional" });
  const uuid = /^[0-9a-f-]{36}$/i;

  const scope = async (request: {
    principal: { kind: string };
    params: { v: string };
    requestId: string;
  }) => {
    const p = request.principal as { kind: string; staffId?: string };
    if (p.kind !== "console" || !p.staffId) throw new ApiError("forbidden", "you can't call this");
    if (!uuid.test(request.params.v)) throw new ApiError("not_found", "no such venue");
    const venue = await consoleVenue(options.pool, request.params.v);
    if (!venue) throw new ApiError("not_found", "no such venue");
    return {
      venueId: venue.id,
      staffId: p.staffId,
      context: { venueId: venue.id, userId: p.staffId, requestId: request.requestId },
    };
  };

  app.get<{ Params: { v: string } }>(
    "/v1/console/venues/:v/setup-requests",
    { config: read },
    async (request) => {
      const s = await scope(request);
      return {
        requests: await app.db.withVenue(s.context, (c) => listSetupRequests(c, s.venueId)),
      };
    },
  );

  app.get<{ Params: { v: string; id: string } }>(
    "/v1/console/venues/:v/setup-requests/:id/file",
    { config: read },
    async (request) => {
      const s = await scope(request);
      if (!uuid.test(request.params.id)) throw new ApiError("not_found", "no such request");
      return app.db.withVenue(s.context, async (c) => {
        const r = (await listSetupRequests(c, s.venueId, { id: request.params.id }))[0];
        if (!r?.file_id) throw new ApiError("not_found", "no such request");
        return downloadLink(c, options.s3(), s.venueId, r.file_id);
      });
    },
  );

  app.post<{ Params: { v: string; id: string } }>(
    "/v1/console/venues/:v/setup-requests/:id/done",
    { config: write },
    async (request) => {
      const s = await scope(request);
      if (!uuid.test(request.params.id)) throw new ApiError("not_found", "no such request");
      return app.db.withVenue(s.context, async (c) => {
        const done = await finishSetupRequest(c, s.venueId, request.params.id, {
          staffId: s.staffId,
          at: options.clock.now().toString(),
        });
        if (!done) throw new ApiError("not_found", "no open request with that id");
        return { requests: await listSetupRequests(c, s.venueId) };
      });
    },
  );
}
