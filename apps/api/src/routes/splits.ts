import type { FastifyInstance } from "fastify";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { startSplit, stopSplit } from "../payments/splits.js";

/**
 * Splits (M4-14; spec 08 · Checks):
 *   POST /v1/venues/{v}/checks/{c}/splits   { kind: "even", shares } or { kind: "items", people, claims: { lineId: person } }
 *   POST /v1/venues/{v}/splits/{s}/stop     "Stop splitting · charge the rest to …": the paid shares stay
 * Each share pays through POST /checks/{c}/payments with its share_id.
 */
const body = z.union([
  z.object({ kind: z.literal("even"), shares: z.number().int().min(2).max(50) }).strict(),
  z
    .object({
      kind: z.literal("items"),
      people: z.number().int().min(2).max(50),
      claims: z.record(z.string().regex(/^\d+$/), z.number().int().min(0)),
    })
    .strict(),
]);
const uuid = z.string().uuid();

export function splitRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const config = route({
    principals: ["owner_manager", "staff", "shared_device"],
    module: "core",
    action: "payments.take",
    idempotency: "optional",
  });
  app.post<{ Params: { venueId: string; checkId: string }; Body: unknown }>(
    "/v1/venues/:venueId/checks/:checkId/splits",
    { config },
    async (request, reply) => {
      if (!uuid.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such check");
      const parsed = body.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          'send { kind: "even", shares } or { kind: "items", people, claims }',
        );
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "splitting is a person's work");
      const split = await request.inVenue((c) =>
        startSplit(c, request.venueId!, request.params.checkId, parsed.data, {
          userId: p.userId,
          now: options.clock.now(),
        }),
      );
      reply.code(201);
      return { split };
    },
  );

  app.post<{ Params: { venueId: string; splitId: string } }>(
    "/v1/venues/:venueId/splits/:splitId/stop",
    { config },
    async (request) => {
      if (!uuid.safeParse(request.params.splitId).success)
        throw new ApiError("not_found", "no such split");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "a person stops a split");
      const done = await request.inVenue((c) =>
        stopSplit(c, request.venueId!, request.params.splitId, {
          userId: p.userId,
          now: options.clock.now(),
        }),
      );
      return { stopped: true, check_id: done.check_id };
    },
  );
}
