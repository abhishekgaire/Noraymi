import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { moveSession, sessionMoveOptions } from "../rooms/move.js";

/**
 * The move sheet (M2-18; spec 08 · Board and sessions):
 *   GET  /v1/venues/{v}/sessions/{s}/move-options   the rooms, with free-until or why not
 *   POST /v1/venues/{v}/sessions/{s}/move           { room_id }; anywhere else 409 room_not_free
 */
const body = z.object({ room_id: z.string().uuid() }).strict();

export function moveRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string; sessionId: string } }>(
    "/v1/venues/:venueId/sessions/:sessionId/move-options",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "rooms" }) },
    async (request) =>
      request.inVenue((c) =>
        sessionMoveOptions(c, request.venueId!, request.params.sessionId, options.clock.now()),
      ),
  );

  app.post<{ Params: { venueId: string; sessionId: string }; Body: unknown }>(
    "/v1/venues/:venueId/sessions/:sessionId/move",
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
      if (!parsed.success) throw new ApiError("invalid_request", "send { room_id }");
      const p = request.principal;
      return request.inVenue((c) =>
        moveSession(c, request.venueId!, request.params.sessionId, {
          roomId: parsed.data.room_id,
          now: options.clock.now(),
          ...(p.kind === "user" ? { userId: p.userId } : {}),
        }),
      );
    },
  );
}
