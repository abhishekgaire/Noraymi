import type { FastifyInstance } from "fastify";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { markClearOut } from "../rooms/clear-out.js";

/**
 * The clear-out check (M3-23; spec 08 · Night close):
 *   POST /v1/venues/{v}/nights/{date}/clear-out   { note? }: walked every room and the bar, records who and when
 */
const body = z.object({ note: z.string().trim().max(300).nullable().optional() }).strict();

export function clearOutRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.post<{ Params: { venueId: string; date: string }; Body: unknown }>(
    "/v1/venues/:venueId/nights/:date/clear-out",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        action: "guests.checkin",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(request.params.date))
        throw new ApiError("not_found", "no such night");
      const parsed = body.safeParse(request.body ?? {});
      if (!parsed.success) throw new ApiError("invalid_request", "send { note? }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      return request.inVenue((c) =>
        markClearOut(c, request.venueId!, {
          date: request.params.date,
          userId: p.userId,
          note: parsed.data.note ?? null,
          now: options.clock.now(),
        }),
      );
    },
  );
}
