import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { cutOffGuest, cutOffRoom, sessionGuests } from "../rooms/cut-off.js";

/**
 * Cut-offs (M3-21; spec 08 · Board and sessions):
 *   POST /v1/venues/{v}/sessions/{s}/cut-off             { reason }: no more alcohol for this room
 *   POST /v1/venues/{v}/sessions/{s}/guests/{g}/cut-off  { reason }: no more alcohol for one guest
 *   GET  /v1/venues/{v}/sessions/{s}/guests              the room's joined phones and tablets
 * Needs `cutoff.apply`: a runner can't cut off (403).
 */
const body = z.object({ reason: z.string().trim().min(1).max(300) }).strict();
const id = z.string().uuid();
const who = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
  return p.userId;
};

export function cutOffRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "core",
    action: "cutoff.apply",
    idempotency: "optional",
  });

  app.post<{ Params: { venueId: string; sessionId: string }; Body: unknown }>(
    "/v1/venues/:venueId/sessions/:sessionId/cut-off",
    { config: write },
    async (request) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "a cut-off needs a reason");
      if (!id.safeParse(request.params.sessionId).success)
        throw new ApiError("not_found", "no such session");
      const userId = who(request);
      return request.inVenue((c) =>
        cutOffRoom(c, request.venueId!, {
          sessionId: request.params.sessionId,
          userId,
          reason: parsed.data.reason,
          now: options.clock.now(),
        }),
      );
    },
  );

  app.post<{ Params: { venueId: string; sessionId: string; g: string }; Body: unknown }>(
    "/v1/venues/:venueId/sessions/:sessionId/guests/:g/cut-off",
    { config: write },
    async (request) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "a cut-off needs a reason");
      if (
        !id.safeParse(request.params.sessionId).success ||
        !id.safeParse(request.params.g).success
      )
        throw new ApiError("not_found", "no such guest in this room");
      const userId = who(request);
      return request.inVenue((c) =>
        cutOffGuest(c, request.venueId!, {
          sessionId: request.params.sessionId,
          roomGuestId: request.params.g,
          userId,
          reason: parsed.data.reason,
          now: options.clock.now(),
        }),
      );
    },
  );

  app.get<{ Params: { venueId: string; sessionId: string } }>(
    "/v1/venues/:venueId/sessions/:sessionId/guests",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => {
      if (!id.safeParse(request.params.sessionId).success)
        throw new ApiError("not_found", "no such session");
      return request.inVenue(async (c) => {
        const found = await c.query("select 1 from room_sessions where venue_id = $1 and id = $2", [
          request.venueId,
          request.params.sessionId,
        ]);
        if (found.rowCount === 0) throw new ApiError("not_found", "no such session");
        return { guests: await sessionGuests(c, request.venueId!, request.params.sessionId) };
      });
    },
  );
}
