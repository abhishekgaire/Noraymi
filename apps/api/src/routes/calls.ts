import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Clock, Locale } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { ackCall, callToFault, openCalls } from "../rooms/calls.js";

/**
 * Room calls (M2-20; spec 08 · Live events, room.call):
 *   GET  /v1/venues/{v}/calls                     the open calls (the board, every staff phone's Calls)
 *   POST /v1/venues/{v}/calls/{callId}/ack        On it
 *   POST /v1/venues/{v}/calls/{callId}/fault      a TV or song call as a fault on its room
 * The guest's Call staff button that makes one comes with the room page (M3).
 */
const who = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
  return p.userId;
};

export function callRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "rooms",
    idempotency: "optional",
  });
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/calls",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "rooms" }) },
    async (request) => ({ calls: await request.inVenue((c) => openCalls(c, request.venueId!)) }),
  );

  app.post<{ Params: { venueId: string; callId: string } }>(
    "/v1/venues/:venueId/calls/:callId/ack",
    { config: write },
    async (request) => {
      const userId = who(request);
      return {
        call: await request.inVenue((c) =>
          ackCall(c, request.venueId!, request.params.callId, { userId, now: options.clock.now() }),
        ),
      };
    },
  );

  app.post<{ Params: { venueId: string; callId: string } }>(
    "/v1/venues/:venueId/calls/:callId/fault",
    { config: write },
    async (request, reply) => {
      const userId = who(request);
      const venueId = request.venueId!;
      const result = await request.inVenue(async (c) => {
        const locale = (
          await c.query<{ locale: Locale }>(
            "select locale from memberships where venue_id = $1 and user_id = $2",
            [venueId, userId],
          )
        ).rows[0]?.locale;
        return callToFault(c, venueId, request.params.callId, {
          userId,
          locale: locale ?? "en",
          now: options.clock.now(),
        });
      });
      return reply.code(201).send(result);
    },
  );
}
