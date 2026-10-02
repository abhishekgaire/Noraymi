import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { askLowerPartySize, changePartySize, lowerNeedsApproval } from "../rooms/party-size.js";

/**
 * `POST /v1/venues/{v}/sessions/{s}/party-size` (M2-17; spec 08 · Board and
 * sessions): the new size; answers the new hourly rate and billable minimum.
 * A lower size after the gratuity applies answers 202 approval_pending (M4-23).
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
    async (request, reply) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { party_size }");
      const venueId = request.venueId!;
      const at = options.clock.now();
      const p = request.principal;
      const answer = await request.inVenue(async (c) => {
        const current = (
          await c.query<{ party_size: number }>(
            "select party_size from room_sessions where venue_id = $1 and id = $2",
            [venueId, request.params.sessionId],
          )
        ).rows[0];
        // Fewer guests after the gratuity applies waits for a manager (M4-23).
        if (
          current &&
          parsed.data.party_size < current.party_size &&
          (await lowerNeedsApproval(c, venueId, request.params.sessionId, at))
        ) {
          if (p.kind !== "user")
            throw new ApiError("forbidden", "asking for an approval is a person's");
          return {
            pending: await askLowerPartySize(c, venueId, request.params.sessionId, {
              partySize: parsed.data.party_size,
              userId: p.userId,
              deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
              at,
            }),
          };
        }
        return {
          changed: await changePartySize(c, venueId, request.params.sessionId, {
            partySize: parsed.data.party_size,
            at,
          }),
        };
      });
      if ("pending" in answer) return reply.code(202).send(answer.pending);
      return answer.changed;
    },
  );
}
