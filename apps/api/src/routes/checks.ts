import type { FastifyInstance } from "fastify";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { checkView } from "../rooms/checks.js";

/**
 * `GET /v1/venues/{v}/checks/{c}` (M2-08; spec 08 · Checks): the number
 * (#1042), the lines and the tab so far. Tax, gratuity, totals and revisions
 * come with finalize in M4.
 */
export function checksRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string; checkId: string } }>(
    "/v1/venues/:venueId/checks/:checkId",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) =>
      request.inVenue((c) =>
        checkView(c, request.venueId!, request.params.checkId, options.clock.now()),
      ),
  );
}
