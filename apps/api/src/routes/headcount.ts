import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { countDoor, headcount } from "../rooms/headcount.js";

/**
 * The headcount and the door counter (M2-28; spec 08 · Board and sessions):
 *   GET  /v1/venues/{v}/headcount     inside, in rooms, waiting, the door, and the limit (or none)
 *   POST /v1/venues/{v}/door-counts   { delta: 1 | -1 }
 */
export function headcountRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/headcount",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => request.inVenue((c) => headcount(c, request.venueId!, options.clock.now())),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/door-counts",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        action: "guests.checkin",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      const parsed = z
        .object({ delta: z.union([z.literal(1), z.literal(-1)]) })
        .strict()
        .safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { delta: 1 } or { delta: -1 }");
      const p = request.principal;
      if (p.kind !== "user")
        throw new ApiError("forbidden", "counting the door is a person's work");
      const result = await request.inVenue((c) =>
        countDoor(c, request.venueId!, {
          delta: parsed.data.delta,
          userId: p.userId,
          deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send(result);
    },
  );
}
