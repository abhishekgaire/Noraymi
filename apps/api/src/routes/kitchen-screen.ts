import type { FastifyInstance } from "fastify";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { bumpKitchenTicket, doneKitchenTickets, openKitchenTickets } from "../kitchen/screen.js";

/**
 * Kitchen screen (P-17; module kitchen_screen): the open kitchen tickets oldest first, tonight's
 * bumped ones for the bar ("Food up"), and Done. A paired kitchen display, a bar computer (its
 * second window, nobody signed in) and the venue's staff may read and bump; a switched-off module
 * answers module_off.
 */
export function kitchenScreenRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const spec = route({
    principals: ["owner_manager", "staff", "shared_device", "kitchen_display"],
    module: "kitchen_screen",
  });

  app.get<{ Params: { venueId: string }; Querystring: { view?: string } }>(
    "/v1/venues/:venueId/kitchen/tickets",
    { config: spec },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const now = options.clock.now();
        if (request.query.view === "done") {
          const v = await venueClock(c, venueId);
          const night = businessDate(now, v.timeZone, v.dayCutover).businessDate.toString();
          return { tickets: await doneKitchenTickets(c, venueId, night), now: now.toString() };
        }
        return { tickets: await openKitchenTickets(c, venueId), now: now.toString() };
      }),
  );

  app.post<{ Params: { venueId: string; ticketId: string } }>(
    "/v1/venues/:venueId/kitchen/tickets/:ticketId/done",
    { config: spec },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.ticketId).success)
        throw new ApiError("not_found", "no such kitchen ticket");
      const p = request.principal;
      const ticket = await request.inVenue((c) =>
        bumpKitchenTicket(c, request.venueId!, {
          ticketId: request.params.ticketId,
          at: options.clock.now().toString(),
          deviceId: request.signedDevice?.deviceId ?? (p.kind === "device" ? p.deviceId : null),
          userId: p.kind === "user" ? p.userId : null,
        }),
      );
      if (!ticket) throw new ApiError("not_found", "no such kitchen ticket");
      return { ticket };
    },
  );
}
