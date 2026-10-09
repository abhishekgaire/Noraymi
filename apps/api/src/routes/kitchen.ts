import type { FastifyInstance } from "fastify";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { hasKitchenPrinter, kitchenSettings } from "../kitchen/module.js";

/**
 * Kitchen & food (spec 16; K-01). Every kitchen route is registered with module `kitchen`, so each
 * answers 404 module_off while the module is off. Admin → Kitchen edits the `kitchen` settings key
 * through the settings routes, which stay open while the module is off: the allergy notice has to be
 * set before the switch can turn on.
 *   GET /v1/venues/{v}/kitchen   tonight's kitchen settings and whether the kitchen printer is there
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
}
