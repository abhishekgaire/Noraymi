import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  addLostItem,
  addRoomNote,
  clearRoomNote,
  emitEvent,
  lostItemById,
  lostItems,
  roomById,
  updateLostItem,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { attachFile } from "../files/storage.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { markClean } from "../rooms/cleaning.js";

/**
 * Room care (M2-19; spec 08 · Room care):
 *   POST  /v1/venues/{v}/rooms/{r}/clean           mark a room clean
 *   POST  /v1/venues/{v}/rooms/{r}/notes           { text }; notes stay with the room
 *   PATCH /v1/venues/{v}/room-notes/{noteId}        { cleared: true }
 *   GET   /v1/venues/{v}/lost-items?all=1          the lost-and-found log
 *   POST  /v1/venues/{v}/lost-items                { description, kept_at, room_id?, photo_file_id? }
 *   PATCH /v1/venues/{v}/lost-items/{itemId}       { kept_at? , claimed_by_name?, disposed? }
 */
const noteBody = z.object({ text: z.string().trim().min(1).max(500) }).strict();
const lostBody = z
  .object({
    description: z.string().trim().min(1).max(300),
    kept_at: z.string().trim().min(1).max(100),
    room_id: z.string().uuid().nullable().optional(),
    photo_file_id: z.string().uuid().optional(),
  })
  .strict();
const lostPatch = z
  .object({
    kept_at: z.string().trim().min(1).max(100).optional(),
    claimed_by_name: z.string().trim().min(1).max(100).optional(),
    disposed: z.literal(true).optional(),
  })
  .strict();

const userOf = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
  return p.userId;
};

export function roomCareRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({ principals: ["owner_manager", "staff", "shared_device"], module: "rooms" });
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "rooms",
    action: "guests.checkin",
    idempotency: "optional",
  });

  app.post<{ Params: { venueId: string; r: string } }>(
    "/v1/venues/:venueId/rooms/:r/clean",
    { config: write },
    async (request) => {
      const userId = userOf(request);
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        await markClean(c, venueId, request.params.r, { now: options.clock.now(), userId });
        return { room: await roomById(c, venueId, request.params.r) };
      });
    },
  );

  app.post<{ Params: { venueId: string; r: string }; Body: unknown }>(
    "/v1/venues/:venueId/rooms/:r/notes",
    { config: write },
    async (request, reply) => {
      const parsed = noteBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { text }");
      const userId = userOf(request);
      const venueId = request.venueId!;
      const id = await request.inVenue(async (c) => {
        const room = await roomById(c, venueId, request.params.r);
        if (!room) throw new ApiError("not_found", "no such room");
        const noteId = await addRoomNote(c, venueId, {
          roomId: room.id,
          text: parsed.data.text,
          addedBy: userId,
          at: options.clock.now().toString(),
        });
        await emitEvent(c, { venueId, type: "room.updated", entityId: room.id, entityVersion: 0 });
        return noteId;
      });
      return reply.code(201).send({ note: { id, text: parsed.data.text } });
    },
  );

  app.patch<{ Params: { venueId: string; noteId: string }; Body: unknown }>(
    "/v1/venues/:venueId/room-notes/:noteId",
    { config: write },
    async (request) => {
      const parsed = z
        .object({ cleared: z.literal(true) })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { cleared: true }");
      userOf(request);
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const note = (
          await c.query<{ room_id: string }>(
            "select room_id from room_notes where venue_id = $1 and id = $2",
            [venueId, request.params.noteId],
          )
        ).rows[0];
        if (!note) throw new ApiError("not_found", "no such note");
        await clearRoomNote(c, venueId, request.params.noteId, options.clock.now().toString());
        await emitEvent(c, {
          venueId,
          type: "room.updated",
          entityId: note.room_id,
          entityVersion: 0,
        });
        return { cleared: true };
      });
    },
  );

  app.get<{ Params: { venueId: string }; Querystring: { all?: string } }>(
    "/v1/venues/:venueId/lost-items",
    { config: read },
    async (request) => ({
      items: await request.inVenue((c) =>
        lostItems(c, request.venueId!, request.query.all === "1"),
      ),
    }),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/lost-items",
    { config: write },
    async (request, reply) => {
      const parsed = lostBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { description, kept_at, room_id?, photo_file_id? }",
        );
      const userId = userOf(request);
      const venueId = request.venueId!;
      const now = options.clock.now();
      const item = await request.inVenue(async (c) => {
        const roomId = parsed.data.room_id ?? null;
        let sessionId: string | null = null;
        if (roomId) {
          if (!(await roomById(c, venueId, roomId)))
            throw new ApiError("not_found", "no such room");
          // The party in the room now, or the last one to leave it.
          sessionId =
            (
              await c.query<{ id: string }>(
                "select id from room_sessions where venue_id = $1 and room_id = $2 order by started_at desc limit 1",
                [venueId, roomId],
              )
            ).rows[0]?.id ?? null;
        }
        if (parsed.data.photo_file_id) {
          const file = await c.query<{ kind: string }>(
            "select kind from files where venue_id = $1 and id = $2 and removed_at is null",
            [venueId, parsed.data.photo_file_id],
          );
          if (file.rows[0]?.kind !== "lost_item_photo")
            throw new ApiError("invalid_request", "the photo must be a lost_item_photo upload");
          await attachFile(c, venueId, parsed.data.photo_file_id, now);
        }
        const id = await addLostItem(c, venueId, {
          roomId,
          sessionId,
          description: parsed.data.description,
          photoFileId: parsed.data.photo_file_id ?? null,
          foundBy: userId,
          at: now.toString(),
          keptAt: parsed.data.kept_at,
        });
        await emitEvent(c, { venueId, type: "lost_item.updated", entityId: id, entityVersion: 0 });
        return lostItemById(c, venueId, id);
      });
      return reply.code(201).send({ item });
    },
  );

  app.patch<{ Params: { venueId: string; itemId: string }; Body: unknown }>(
    "/v1/venues/:venueId/lost-items/:itemId",
    { config: write },
    async (request) => {
      const parsed = lostPatch.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { kept_at?, claimed_by_name?, disposed? }");
      const userId = userOf(request);
      const venueId = request.venueId!;
      const now = options.clock.now().toString();
      return request.inVenue(async (c) => {
        const item = await lostItemById(c, venueId, request.params.itemId);
        if (!item) throw new ApiError("not_found", "no such item");
        await updateLostItem(c, venueId, item.id, {
          ...(parsed.data.kept_at ? { keptAt: parsed.data.kept_at } : {}),
          ...(parsed.data.claimed_by_name
            ? { claim: { name: parsed.data.claimed_by_name, handedOverBy: userId, at: now } }
            : {}),
          ...(parsed.data.disposed ? { disposedAt: now } : {}),
        });
        await emitEvent(c, {
          venueId,
          type: "lost_item.updated",
          entityId: item.id,
          entityVersion: 0,
        });
        return { item: await lostItemById(c, venueId, item.id) };
      });
    },
  );
}
