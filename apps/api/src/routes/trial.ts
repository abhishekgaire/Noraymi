import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * The timed staff trial's capture (M9-11; spec 13 · Tests, Timed staff trial):
 *   POST /v1/venues/{v}/trial-events   { events: [{ kind, label?, screen?, at }] }, at most 200
 * Training mode only: a live person on a live device gets 403, so nothing about live work is
 * ever kept. The staff app sends its taps, the errors it showed and a badge take-over's two
 * moments; trial:report reads them back by time window.
 */
const body = z
  .object({
    events: z
      .array(
        z
          .object({
            kind: z.enum(["tap", "error", "badge", "signed_in"]),
            label: z.string().max(80).optional(),
            screen: z.string().max(120).optional(),
            at: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export function trialRoutes(app: FastifyInstance): void {
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/trial-events",
    {
      config: route({
        principals: ["owner_manager", "staff", "shared_device"],
        module: "core",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      if (!request.training)
        throw new ApiError("forbidden", "the trial's capture runs only in training mode", {
          details: { reason: "training" },
        });
      const parsed = body.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { events: [{ kind, label?, screen?, at }] }");
      const p = request.principal;
      const membershipId =
        p.kind === "user"
          ? (p.memberships.find((m) => m.venueId === request.venueId)?.membershipId ?? null)
          : null;
      const deviceId =
        p.kind === "device"
          ? p.deviceId
          : (request.signedDevice?.deviceId ?? request.session?.deviceId ?? null);
      const events = parsed.data.events;
      await request.inVenue((c) =>
        c.query(
          `insert into trial_events (venue_id, membership_id, device_id, kind, label, screen, at)
           select $1, $2, $3, e.kind, e.label, e.screen, e.at
             from jsonb_to_recordset($4::jsonb) as e(kind text, label text, screen text, at timestamptz)`,
          [request.venueId, membershipId, deviceId, JSON.stringify(events)],
        ),
      );
      return reply.code(201).send({ accepted: events.length });
    },
  );
}
