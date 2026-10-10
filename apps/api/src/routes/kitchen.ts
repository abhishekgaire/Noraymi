import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { hasKitchenPrinter, kitchenSettings } from "../kitchen/module.js";
import { removeUnsentFood, sendToKitchen } from "../kitchen/send.js";

/**
 * Kitchen & food (spec 16; K-01). Every kitchen route is registered with module `kitchen`, so each
 * answers 404 module_off while the module is off. Admin → Kitchen edits the `kitchen` settings key
 * through the settings routes, which stay open while the module is off: the allergy notice has to be
 * set before the switch can turn on.
 *   GET /v1/venues/{v}/kitchen   tonight's kitchen settings and whether the kitchen printer is there
 *   POST /v1/venues/{v}/checks/{c}/kitchen-sends   (Idempotency-Key) { lines: [{ line_id, kitchen_note?,
 *        kitchen_note_allergy? }], name? }: Send to kitchen (K-05): one kitchen ticket, the lines marked
 *        sent; a line already sent answers 409 version_conflict (already_sent). A quick sale needs a name.
 *   POST /v1/venues/{v}/checks/{c}/lines/{l}/remove-unsent   food that's Not sent, off with no reason
 */
export function kitchenRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({
    principals: ["owner_manager", "staff", "shared_device"],
    module: "kitchen",
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/kitchen",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => {
        const s = await kitchenSettings(c, request.venueId!, options.clock);
        return {
          allergy_notice: s.allergyNotice,
          last_order: s.lastOrder,
          unsent_warn_min: s.unsentWarnMin,
          kitchen_printer: await hasKitchenPrinter(c, request.venueId!),
        };
      }),
  );

  const sendBody = z
    .object({
      lines: z
        .array(
          z
            .object({
              line_id: z.number().int().positive(),
              kitchen_note: z.string().max(200).nullable().optional(),
              kitchen_note_allergy: z.boolean().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
      name: z.string().trim().max(40).nullable().optional(),
    })
    .strict();
  const who = (request: FastifyRequest) => {
    const p = request.principal;
    if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
    return p.userId;
  };
  const checkOf = (checkId: string) => {
    if (!z.string().uuid().safeParse(checkId).success)
      throw new ApiError("not_found", "no such check");
    return checkId;
  };

  app.post<{ Params: { venueId: string; checkId: string }; Body: unknown }>(
    "/v1/venues/:venueId/checks/:checkId/kitchen-sends",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "kitchen",
        action: "orders.accept",
        idempotency: "required",
      }),
    },
    async (request, reply) => {
      const parsed = sendBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { lines: [{ line_id, kitchen_note? }], name? }",
        );
      const checkId = checkOf(request.params.checkId);
      const userId = who(request);
      const sent = await request.inVenue((c) =>
        sendToKitchen(c, request.venueId!, {
          checkId,
          lines: parsed.data.lines,
          name: parsed.data.name ?? null,
          userId,
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send(sent);
    },
  );

  app.post<{ Params: { venueId: string; checkId: string; lineId: string } }>(
    "/v1/venues/:venueId/checks/:checkId/lines/:lineId/remove-unsent",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "kitchen",
        action: "orders.accept",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const checkId = checkOf(request.params.checkId);
      const lineId = Number(request.params.lineId);
      if (!Number.isSafeInteger(lineId) || lineId <= 0)
        throw new ApiError("not_found", "no such line on this check");
      const userId = who(request);
      return request.inVenue((c) =>
        removeUnsentFood(c, request.venueId!, {
          checkId,
          lineId,
          userId,
          now: options.clock.now(),
        }),
      );
    },
  );
}
