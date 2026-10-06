import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { emitEvent, faultById, fixFault, insertFault, openFaults, roomById } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import {
  backInService,
  COMP_MINUTES,
  compMinutes,
  requestPause,
  takeOutOfService,
  unpauseClock,
} from "../rooms/faults.js";

/**
 * Room care and the clock (M2-16; spec 08 · Room care, Board and sessions):
 *   GET   /v1/venues/{v}/faults                       the open faults (the tiles)
 *   POST  /v1/venues/{v}/rooms/{r}/faults             log one: out of service, pause the clock, comp 15 min
 *   PATCH /v1/venues/{v}/faults/{f}                   { fixed: true }
 *   POST  /v1/venues/{v}/sessions/{s}/pause           always 202 approval_pending
 *   POST  /v1/venues/{v}/sessions/{s}/unpause
 *   POST  /v1/venues/{v}/sessions/{s}/comp-minutes    201 within the reason-only limit, else 202
 */
const faultBody = z
  .object({
    text: z.string().trim().min(1).max(500),
    out_of_service: z.boolean().optional(),
    pause_clock: z.boolean().optional(),
    comp_minutes: z.literal(COMP_MINUTES).optional(),
  })
  .strict();
const reasonBody = z
  .object({ reason: z.string().trim().min(1).max(500), fault_id: z.string().uuid().optional() })
  .strict();
const compBody = reasonBody.extend({ minutes: z.literal(COMP_MINUTES).optional() }).strict();

const who = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
  return {
    userId: p.userId,
    deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
  };
};

export function faultRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({ principals: ["owner_manager", "staff", "shared_device"], module: "rooms" });
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "rooms",
    action: "guests.checkin",
    idempotency: "optional",
  });
  const comp = route({
    principals: ["owner_manager", "staff"],
    module: "rooms",
    action: "comps.reasonOnly",
    idempotency: "optional",
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/faults",
    { config: read },
    async (request) => ({
      faults: await request.inVenue((c) => openFaults(c, request.venueId!)),
    }),
  );

  app.post<{ Params: { venueId: string; r: string }; Body: unknown }>(
    "/v1/venues/:venueId/rooms/:r/faults",
    { config: write },
    async (request, reply) => {
      const parsed = faultBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { text, out_of_service?, pause_clock?, comp_minutes?: 15 }",
        );
      const b = parsed.data;
      const me = who(request);
      const venueId = request.venueId!;
      const now = options.clock.now();
      const result = await request.inVenue(async (c) => {
        const room = await roomById(c, venueId, request.params.r);
        if (!room || room.archived_at) throw new ApiError("not_found", "no such room");
        const session = (
          await c.query<{ id: string }>(
            "select id from room_sessions where venue_id = $1 and room_id = $2 and ended_at is null and not training",
            [venueId, room.id],
          )
        ).rows[0];
        if ((b.pause_clock || b.comp_minutes) && !session)
          throw new ApiError("invalid_request", "nobody is in the room, so there's no clock");
        const id = await insertFault(c, venueId, {
          roomId: room.id,
          sessionId: session?.id ?? null,
          text: b.text,
          reportedBy: me.userId,
          reportedAt: now.toString(),
          outOfService: b.out_of_service ?? false,
        });
        const reassigned = b.out_of_service
          ? await takeOutOfService(c, venueId, room.id, { reason: b.text, setBy: me.userId, now })
          : undefined;
        const pause = b.pause_clock
          ? await requestPause(c, venueId, {
              sessionId: session!.id,
              reason: b.text,
              faultId: id,
              requestedBy: me.userId,
              requestedDeviceId: me.deviceId,
              now,
            })
          : undefined;
        const comped = b.comp_minutes
          ? await compMinutes(c, venueId, {
              sessionId: session!.id,
              minutes: b.comp_minutes,
              reason: b.text,
              faultId: id,
              requestedBy: me.userId,
              requestedDeviceId: me.deviceId,
              now,
            })
          : undefined;
        return {
          fault: await faultById(c, venueId, id),
          ...(reassigned ? { reassigned } : {}),
          ...(pause ? { pause } : {}),
          ...(comped ? { comp: comped } : {}),
        };
      });
      return reply.code(201).send(result);
    },
  );

  app.patch<{ Params: { venueId: string; f: string }; Body: unknown }>(
    "/v1/venues/:venueId/faults/:f",
    { config: write },
    async (request) => {
      const parsed = z
        .object({ fixed: z.literal(true) })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { fixed: true }");
      const me = who(request);
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const fault = await faultById(c, venueId, request.params.f, true);
        if (!fault) throw new ApiError("not_found", "no such fault");
        if (fault.fixed_at) return { fault };
        await fixFault(c, venueId, fault.id, { fixedBy: me.userId, at: now.toString() });
        if (fault.out_of_service)
          await backInService(c, venueId, fault.room_id, { setBy: me.userId, now });
        else
          await emitEvent(c, {
            venueId,
            type: "room.updated",
            entityId: fault.room_id,
            entityVersion: 0,
          });
        return { fault: await faultById(c, venueId, fault.id) };
      });
    },
  );

  app.post<{ Params: { venueId: string; sessionId: string }; Body: unknown }>(
    "/v1/venues/:venueId/sessions/:sessionId/pause",
    { config: write },
    async (request, reply) => {
      const parsed = reasonBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "a pause needs a reason");
      const me = who(request);
      const venueId = request.venueId!;
      const answer = await request.inVenue((c) =>
        requestPause(c, venueId, {
          sessionId: request.params.sessionId,
          reason: parsed.data.reason,
          faultId: parsed.data.fault_id ?? null,
          requestedBy: me.userId,
          requestedDeviceId: me.deviceId,
          now: options.clock.now(),
        }),
      );
      return reply.code(202).send(answer);
    },
  );

  app.post<{ Params: { venueId: string; sessionId: string } }>(
    "/v1/venues/:venueId/sessions/:sessionId/unpause",
    { config: write },
    async (request) => {
      who(request);
      const venueId = request.venueId!;
      const segment = await request.inVenue((c) =>
        unpauseClock(c, venueId, request.params.sessionId, options.clock.now()),
      );
      return { segment_id: segment };
    },
  );

  app.post<{ Params: { venueId: string; sessionId: string }; Body: unknown }>(
    "/v1/venues/:venueId/sessions/:sessionId/comp-minutes",
    { config: comp },
    async (request, reply) => {
      const parsed = compBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "a comp needs a reason");
      const me = who(request);
      const venueId = request.venueId!;
      const answer = await request.inVenue((c) =>
        compMinutes(c, venueId, {
          sessionId: request.params.sessionId,
          minutes: parsed.data.minutes ?? COMP_MINUTES,
          reason: parsed.data.reason,
          faultId: parsed.data.fault_id ?? null,
          requestedBy: me.userId,
          requestedDeviceId: me.deviceId,
          now: options.clock.now(),
        }),
      );
      return reply.code(answer.status === "added" ? 201 : 202).send(answer);
    },
  );
}
