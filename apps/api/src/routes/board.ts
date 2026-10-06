import type { FastifyInstance } from "fastify";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { board } from "../rooms/board.js";

/** `GET /v1/venues/{v}/board` (M2-29): every room's tile, the counts and the headcount. */
export function boardRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/board",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "rooms" }) },
    async (request) =>
      request.inVenue((c) => board(c, request.venueId!, options.clock.now(), request.training)),
  );
}
