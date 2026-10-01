import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { changePartySize } from "../rooms/party-size.js";

/**
 * `POST /v1/venues/{v}/sessions/{s}/party-size` (M2-17; spec 08 · Board and
 * sessions): the new size; answers the new hourly rate and billable minimum.
 */
const body = z.object({ party_size: z.number().int().min(1).max(500) }).strict();

export function partySizeRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.post<{ Params: { venueId: string; sessionId: string }; Body: unknown }>(
    "/v1/venues/:venueId/sessions/:sessionId/party-size",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "rooms",
        action: "guests.checkin",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { party_size }");
      const venueId = request.venueId!;
      return request.inVenue((c) =>
        changePartySize(c, venueId, request.params.sessionId, {
          partySize: parsed.data.party_size,
          at: options.clock.now(),
        }),
      );
    },
  );
}
