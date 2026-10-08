import { queueRoomQuantity } from "../billing/plan.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createRoom,
  emitEvent,
  listRooms,
  roomById,
  roomStates,
  setRoomState,
  updateRoom,
  type RoomState,
} from "@west4/db";
import { Temporal, type Clock } from "@west4/shared";
import { availability, freeFor, reassignFutureBookings } from "../rooms/assignment.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * Rooms (M2-04; spec 04 · rooms, room_states, Room assignment; spec 08 · Rooms):
 *   GET   /v1/venues/{v}/rooms                 the live rooms with their state (?all=1 adds archived ones)
 *   POST  /v1/venues/{v}/rooms                 Admin → Rooms creates one
 *   PATCH /v1/venues/{v}/rooms/{r}             edits it, or archives it ({ archived: true }); nothing deletes a room
 *   PATCH /v1/venues/{v}/rooms/{r}/state       available, out_of_service ("Switched off" is the Admin switch), …
 * Every route belongs to the Rooms & room clock module. Switching a room off
 * or out of service re-runs assignment for its future bookings and lists any
 * that no longer fit for a manager; bookings arrive in M2-05, so the hook is
 * here and the lists are empty until then.
 */
interface VenueParams {
  venueId: string;
}

const roomBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    size_tier: z.string().trim().min(1).max(40),
    capacity_min: z.number().int().min(1),
    capacity_max: z.number().int().min(1),
    cleaning_min: z.number().int().min(0).nullable().optional(),
    is_vip: z.boolean().optional(),
    bookable_online: z.boolean().optional(),
  })
  .strict();

const patchBody = roomBody.partial().extend({ archived: z.boolean().optional() }).strict();

const stateBody = z
  .object({
    state: z.enum(roomStates as [RoomState, ...RoomState[]]),
    reason: z.string().trim().max(200).nullable().optional(),
    until: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

function instantOr(raw: string | undefined, fallback: Temporal.Instant): Temporal.Instant {
  if (raw === undefined) return fallback;
  try {
    return Temporal.Instant.from(raw);
  } catch {
    throw new ApiError("invalid_request", `"${raw}" isn't an ISO 8601 instant`);
  }
}

export function roomsRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({
    principals: ["owner_manager", "staff", "shared_device", "room_tablet"],
    module: "rooms",
  });
  const admin = route({
    principals: ["owner_manager"],
    module: "rooms",
    action: "admin.access",
    idempotency: "optional",
  });
  const bad = (issues: z.ZodIssue[]) =>
    new ApiError(
      "invalid_request",
      issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );

  app.get<{ Params: VenueParams; Querystring: { all?: string } }>(
    "/v1/venues/:venueId/rooms",
    { config: read },
    async (request) => ({
      rooms: await request.inVenue((c) =>
        listRooms(c, request.venueId!, { includeArchived: request.query.all === "1" }),
      ),
    }),
  );

  /** The board's "free until": every live room at an instant (M2-05). */
  app.get<{ Params: VenueParams; Querystring: { at?: string } }>(
    "/v1/venues/:venueId/rooms/availability",
    { config: read },
    async (request) => {
      const at = instantOr(request.query.at, options.clock.now());
      return request.inVenue((c) => availability(c, request.venueId!, at));
    },
  );

  /** Rooms free for the time needed (moves, waitlist offers): fitting the party, in assignment order. */
  app.get<{
    Params: VenueParams;
    Querystring: { party?: string; from?: string; to?: string; minutes?: string };
  }>("/v1/venues/:venueId/rooms/free", { config: read }, async (request) => {
    const party = Number(request.query.party);
    if (!Number.isInteger(party) || party < 1)
      throw new ApiError("invalid_request", "party is a whole number of guests");
    const from = instantOr(request.query.from, options.clock.now());
    const minutes = request.query.minutes !== undefined ? Number(request.query.minutes) : null;
    const to =
      request.query.to !== undefined
        ? instantOr(request.query.to, from)
        : minutes !== null && Number.isInteger(minutes) && minutes > 0
          ? from.add({ minutes })
          : null;
    if (!to || Temporal.Instant.compare(to, from) <= 0)
      throw new ApiError("invalid_request", "send to (an instant after from) or minutes");
    return request.inVenue((c) =>
      freeFor(c, request.venueId!, { party, from, to, now: options.clock.now() }),
    );
  });

  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/rooms",
    { config: admin },
    async (request, reply) => {
      const parsed = roomBody.safeParse(request.body);
      if (!parsed.success) throw bad(parsed.error.issues);
      const b = parsed.data;
      if (b.capacity_max < b.capacity_min)
        throw new ApiError("invalid_request", "capacity_max is below capacity_min");
      const venueId = request.venueId!;
      const room = await request.inVenue(async (c) => {
        let id: string;
        try {
          id = await createRoom(
            c,
            venueId,
            {
              name: b.name,
              sizeTier: b.size_tier,
              capacityMin: b.capacity_min,
              capacityMax: b.capacity_max,
              cleaningMin: b.cleaning_min ?? null,
              isVip: b.is_vip ?? false,
              bookableOnline: b.bookable_online ?? true,
            },
            options.clock.now().toString(),
          );
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw new ApiError("invalid_request", `there is already a room called "${b.name}"`);
          throw e;
        }
        await emitEvent(c, { venueId, type: "room.updated", entityId: id, entityVersion: 0 });
        // Our plan counts every room that isn't archived (M8-15).
        await queueRoomQuantity(c, venueId, options.clock.now());
        return roomById(c, venueId, id);
      });
      return reply.code(201).send({ room });
    },
  );

  app.patch<{ Params: VenueParams & { r: string }; Body: unknown }>(
    "/v1/venues/:venueId/rooms/:r",
    { config: admin },
    async (request) => {
      const parsed = patchBody.safeParse(request.body);
      if (!parsed.success) throw bad(parsed.error.issues);
      const b = parsed.data;
      if (Object.keys(b).length === 0) throw new ApiError("invalid_request", "nothing to change");
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const before = await roomById(c, venueId, request.params.r);
        if (!before) throw new ApiError("not_found", "no such room");
        const min = b.capacity_min ?? before.capacity_min;
        const max = b.capacity_max ?? before.capacity_max;
        if (max < min) throw new ApiError("invalid_request", "capacity_max is below capacity_min");
        try {
          await updateRoom(
            c,
            venueId,
            request.params.r,
            {
              ...(b.name !== undefined ? { name: b.name } : {}),
              ...(b.size_tier !== undefined ? { sizeTier: b.size_tier } : {}),
              ...(b.capacity_min !== undefined ? { capacityMin: b.capacity_min } : {}),
              ...(b.capacity_max !== undefined ? { capacityMax: b.capacity_max } : {}),
              ...(b.cleaning_min !== undefined ? { cleaningMin: b.cleaning_min } : {}),
              ...(b.is_vip !== undefined ? { isVip: b.is_vip } : {}),
              ...(b.bookable_online !== undefined ? { bookableOnline: b.bookable_online } : {}),
              ...(b.archived !== undefined ? { archived: b.archived } : {}),
            },
            options.clock.now().toString(),
          );
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw new ApiError("invalid_request", `there is already a room called "${b.name}"`);
          throw e;
        }
        await emitEvent(c, {
          venueId,
          type: "room.updated",
          entityId: request.params.r,
          entityVersion: 0,
        });
        if (b.archived !== undefined && b.archived !== (before.archived_at !== null))
          await queueRoomQuantity(c, venueId, options.clock.now());
        const room = await roomById(c, venueId, request.params.r);
        // An archived room leaves the board and assignment; its future bookings move like a room switched off.
        const reassigned =
          b.archived === true
            ? await reassignFutureBookings(c, venueId, request.params.r, options.clock.now())
            : null;
        return { room, ...(reassigned ? { reassigned } : {}) };
      });
    },
  );

  app.patch<{ Params: VenueParams & { r: string }; Body: unknown }>(
    "/v1/venues/:venueId/rooms/:r/state",
    { config: admin },
    async (request) => {
      const parsed = stateBody.safeParse(request.body);
      if (!parsed.success) throw bad(parsed.error.issues);
      const b = parsed.data;
      const venueId = request.venueId!;
      const p = request.principal;
      return request.inVenue(async (c) => {
        const before = await roomById(c, venueId, request.params.r);
        if (!before) throw new ApiError("not_found", "no such room");
        if (before.archived_at)
          throw new ApiError("invalid_request", "an archived room has no state");
        await setRoomState(c, venueId, request.params.r, {
          state: b.state,
          reason: b.reason ?? null,
          until: b.until ?? null,
          setBy: p.kind === "user" ? p.userId : undefined,
          at: options.clock.now().toString(),
        });
        await emitEvent(c, {
          venueId,
          type: "room.updated",
          entityId: request.params.r,
          entityVersion: 0,
        });
        const room = await roomById(c, venueId, request.params.r);
        const reassigned =
          b.state === "out_of_service"
            ? await reassignFutureBookings(c, venueId, request.params.r, options.clock.now())
            : null;
        return { room, ...(reassigned ? { reassigned } : {}) };
      });
    },
  );
}
