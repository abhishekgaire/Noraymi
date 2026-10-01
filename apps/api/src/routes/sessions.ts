import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { endSession, resumeSession, sessionViews, setBookedEnd } from "../rooms/sessions.js";

/**
 * Room sessions (M2-07; spec 08 · Board and sessions):
 *   GET   /v1/venues/{v}/sessions              the open sessions with their live clock (screens refetch each minute)
 *   GET   /v1/venues/{v}/sessions/{s}
 *   PATCH /v1/venues/{v}/sessions/{s}          { booked_end_at }: the soft end
 *   POST  /v1/venues/{v}/sessions/{s}/end
 *   POST  /v1/venues/{v}/sessions/{s}/resume   within 10 minutes, same code and check
 */
interface Params {
  venueId: string;
  sessionId: string;
}

const view = (v: Awaited<ReturnType<typeof sessionViews>>[number]) => ({
  id: v.id,
  room_id: v.room_id,
  room_name: v.room_name,
  booking_id: v.booking_id,
  check_id: v.check_id,
  party_size: v.party_size,
  ids_checked: v.ids_checked,
  started_at: v.started_at,
  booked_end_at: v.booked_end_at,
  ended_at: v.ended_at,
  business_date: v.business_date,
  minutes: v.clock.minutes,
  room_time_cents: v.clock.roomTimeCents,
  tile: v.clock.tile,
  stay_on_offer: v.clock.stayOnOffer,
  wrap_up: v.clock.wrapUp,
  close: v.close,
  segments: v.segments,
});

export function sessionsRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({ principals: ["owner_manager", "staff", "shared_device"], module: "rooms" });
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "rooms",
    action: "guests.checkin",
    idempotency: "optional",
  });
  const userOf = (p: { kind: string; userId?: string }) =>
    p.kind === "user" ? p.userId : undefined;

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/sessions",
    { config: read },
    async (request) => ({
      sessions: (
        await request.inVenue((c) => sessionViews(c, request.venueId!, options.clock.now()))
      ).map(view),
    }),
  );

  app.get<{ Params: Params }>(
    "/v1/venues/:venueId/sessions/:sessionId",
    { config: read },
    async (request) => {
      const found = await request.inVenue((c) =>
        sessionViews(c, request.venueId!, options.clock.now(), request.params.sessionId),
      );
      if (!found[0]) throw new ApiError("not_found", "no such session");
      return { session: view(found[0]) };
    },
  );

  const patchBody = z.object({ booked_end_at: z.string().datetime({ offset: true }) }).strict();
  app.patch<{ Params: Params; Body: unknown }>(
    "/v1/venues/:venueId/sessions/:sessionId",
    { config: write },
    async (request) => {
      const parsed = patchBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { booked_end_at }");
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        await setBookedEnd(
          c,
          request.venueId!,
          request.params.sessionId,
          Temporal.Instant.from(parsed.data.booked_end_at),
          now,
        );
        return {
          session: view(
            (await sessionViews(c, request.venueId!, now, request.params.sessionId))[0]!,
          ),
        };
      });
    },
  );

  app.post<{ Params: Params }>(
    "/v1/venues/:venueId/sessions/:sessionId/end",
    { config: write },
    async (request) => {
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        await endSession(
          c,
          request.venueId!,
          request.params.sessionId,
          now,
          userOf(request.principal as never),
        );
        return {
          session: view(
            (await sessionViews(c, request.venueId!, now, request.params.sessionId))[0]!,
          ),
        };
      });
    },
  );

  app.post<{ Params: Params }>(
    "/v1/venues/:venueId/sessions/:sessionId/resume",
    { config: write },
    async (request) => {
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        await resumeSession(
          c,
          request.venueId!,
          request.params.sessionId,
          now,
          userOf(request.principal as never),
        );
        return {
          session: view(
            (await sessionViews(c, request.venueId!, now, request.params.sessionId))[0]!,
          ),
        };
      });
    },
  );
}
