import type { FastifyInstance, FastifyRequest } from "fastify";
import { emitEvent, kitchenStop, type Queryable } from "@west4/db";
import { businessDate, wallClock } from "@west4/rules";
import type { Clock, Temporal } from "@west4/shared";
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
 *   POST /v1/venues/{v}/kitchen/close    Close the kitchen (K-07): every food item out until the
 *        night's end; accepted orders still print and run. Managers and the owner.
 *   POST /v1/venues/{v}/kitchen/reopen   Reopen the kitchen the same night.
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
          // Why the kitchen isn't taking orders now (K-07): "kitchen_closed", "last_order" or null.
          stop: await kitchenStop(c, request.venueId!, options.clock.now().toString()),
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

  // Close the kitchen (K-07; spec 16 · 86 and closing the kitchen): until the next cutover, so the
  // night close or a new business date ends it, and kept apart from each item's own 86.
  const closeOrReopen = (closing: boolean) => async (request: FastifyRequest) =>
    request.inVenue(async (c) => {
      const venueId = request.venueId!;
      const userId = who(request);
      const now = options.clock.now();
      const until = closing ? await nightEnd(c, venueId, now) : null;
      await c.query(
        "update venues set kitchen_closed_until = $2, kitchen_closed_by = $3 where id = $1",
        [venueId, until, closing ? userId : null],
      );
      await emitEvent(c, { venueId, type: "menu.changed", entityId: venueId });
      return {
        closed: closing,
        closed_until: until,
        stop: await kitchenStop(c, venueId, now.toString()),
      };
    });
  const manage = route({
    principals: ["owner_manager", "staff"],
    module: "kitchen",
    action: "night.close",
    idempotency: "optional",
  });
  app.post("/v1/venues/:venueId/kitchen/close", { config: manage }, closeOrReopen(true));
  app.post("/v1/venues/:venueId/kitchen/reopen", { config: manage }, closeOrReopen(false));
}

/** The end of tonight's business date: the next cutover, as text. */
async function nightEnd(c: Queryable, venueId: string, now: Temporal.Instant): Promise<string> {
  const v = await c.query<{ time_zone: string; day_cutover: string }>(
    "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
    [venueId],
  );
  const { time_zone: tz, day_cutover: cut } = v.rows[0]!;
  const bd = businessDate(now, tz, cut).businessDate;
  return wallClock(bd.add({ days: 1 }), cut, tz, cut).toString();
}
