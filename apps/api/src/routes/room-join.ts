import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  emitEvent,
  insertRoomGuest,
  openSessionInRoom,
  refreshRoomGuest,
  resolveRoomHost,
  resolveRoomSession,
  resolveVenueSlug,
  roomGuestById,
  withVenue,
  type RoomGuestRow,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import type { AuthConfig } from "../config.js";
import type { Authenticator } from "../http/conventions.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { hashRoomCode } from "../rooms/checkin.js";
import { openRoomCode, rotateForWrongCodes, WRONG_CODES_TO_ROTATE } from "../rooms/room-code.js";
import { RoomAvailable, roomGuestOf } from "../rooms/room-guest.js";

/**
 * Joining a room (M3-08; screens N3; spec 09 · Joining a room; spec 02 · Guest
 * in a room; spec 12 · 9):
 *   GET  /v1/public/venues/{slug}/rooms/{room}        the room's name and whether it's open
 *   POST /v1/public/venues/{slug}/rooms/{room}/join   { code }: the 5-character code, traded once for a token
 *   POST /v1/public/room-session/host                 { token }: the Room code text's link joins its opener as the host
 *   GET  /v1/public/room-session                      the joined phone's room: name, code, host or friend, moved
 * The token is 128 random bits in an httpOnly cookie; only its hash is kept. Ten wrong codes for one
 * room rotate its code and alert staff. When the session's version moves on (a move, a host lock, a
 * new code), a joined phone's next call gets a fresh token and the new code, and after a move is told
 * "You've moved to Room 11 · new code …". Token routes send no-referrer and no-store.
 */
export const ROOM_COOKIE = "west4_room";
const ROOM_COOKIE_HOURS = 12;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

declare module "fastify" {
  interface FastifyRequest {
    /** The joined guest behind a room cookie (M3-08), set by the room authenticator. */
    roomGuest?: RoomGuestRow;
  }
}

function roomCookieOf(request: FastifyRequest): string | null {
  const cookie = request.headers.cookie;
  if (typeof cookie !== "string") return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === ROOM_COOKIE) {
      const v = decodeURIComponent(part.slice(eq + 1).trim());
      return /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : null;
    }
  }
  return null;
}

function setRoomCookie(reply: FastifyReply, auth: AuthConfig, token: string | null): void {
  const parts = [
    `${ROOM_COOKIE}=${token ?? ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${token === null ? 0 : ROOM_COOKIE_HOURS * 3600}`,
  ];
  if (auth.cookieSecure) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

/** 128 random bits. */
const newToken = () => randomBytes(16).toString("base64url");

/**
 * The room authenticator: on the guest room routes, a room cookie becomes a guest of that room
 * (principal id: the room the token was issued in, so the room's channel reaches the phone).
 */
export function roomGuestAuthenticator(pool: pg.Pool): Authenticator {
  return async (request) => {
    // The guest room routes, and the room's live channel when no staff session is on the request.
    const path = request.url.split("?")[0]!;
    const channel =
      /^\/v1\/venues\/[^/]+\/events$/.test(path) &&
      !request.headers.authorization &&
      !/(^|;\s*)west4_session=/.test(request.headers.cookie ?? "");
    if (!path.startsWith("/v1/public/room-session") && !channel) return undefined;
    const token = roomCookieOf(request);
    if (!token) return undefined;
    const found = await resolveRoomSession(pool, tokenHash(token));
    if (!found) return undefined;
    const guest = await withVenue(pool, { venueId: found.venueId }, (c) =>
      roomGuestById(c, found.venueId, found.roomGuestId),
    );
    if (!guest) return undefined;
    request.roomGuest = guest;
    return { kind: "guest", venueId: found.venueId, scope: "room_session", id: guest.room_id };
  };
}

export function roomJoinRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; auth: AuthConfig },
): void {
  const open = route({
    principals: ["public"],
    module: "room_ordering",
    idempotency: "none",
    tokenRoute: true,
  });
  const guestRoute = route({
    principals: ["guest_room", "room_tablet"],
    module: "room_ordering",
    idempotency: "none",
    tokenRoute: true,
  });

  const venueOf = async (slug: string) => {
    const venueId = await resolveVenueSlug(options.pool, slug);
    if (!venueId) throw new ApiError("not_found", "no such venue");
    return venueId;
  };
  const roomName = async (venueId: string, roomId: string) => {
    if (!z.string().uuid().safeParse(roomId).success)
      throw new ApiError("not_found", "no such room");
    const r = await withVenue(options.pool, { venueId }, (c) =>
      c.query<{ name: string; venue_name: string }>(
        `select r.name, v.name as venue_name from rooms r join venues v on v.id = r.venue_id
          where r.venue_id = $1 and r.id = $2 and r.archived_at is null`,
        [venueId, roomId],
      ),
    );
    if (!r.rows[0]) throw new ApiError("not_found", "no such room");
    return r.rows[0];
  };

  app.get<{ Params: { slug: string; roomId: string } }>(
    "/v1/public/venues/:slug/rooms/:roomId",
    { config: open },
    async (request) => {
      const venueId = await venueOf(request.params.slug);
      const room = await roomName(venueId, request.params.roomId);
      const session = await withVenue(options.pool, { venueId }, (c) =>
        openSessionInRoom(c, venueId, request.params.roomId),
      );
      return { venue_name: room.venue_name, room_name: room.name, open: session !== null };
    },
  );

  const joinBody = z.object({ code: z.string().trim().min(1).max(12) }).strict();
  app.post<{ Params: { slug: string; roomId: string }; Body: unknown }>(
    "/v1/public/venues/:slug/rooms/:roomId/join",
    { config: open },
    async (request, reply) => {
      const parsed = joinBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { code }");
      const venueId = await venueOf(request.params.slug);
      const room = await roomName(venueId, request.params.roomId);
      const now = options.clock.now();
      const token = newToken();
      const result = await withVenue(
        options.pool,
        { venueId, requestId: request.requestId },
        async (c) => {
          const s = await openSessionInRoom(c, venueId, request.params.roomId);
          if (!s) return { closed: true as const };
          const code = parsed.data.code.toUpperCase().replace(/\s+/g, "");
          if (s.room_code_hash !== hashRoomCode(venueId, code)) {
            const wrong = await c.query<{ wrong_codes: number }>(
              "update room_sessions set wrong_codes = wrong_codes + 1 where venue_id = $1 and id = $2 returning wrong_codes",
              [venueId, s.id],
            );
            if ((wrong.rows[0]?.wrong_codes ?? 0) >= WRONG_CODES_TO_ROTATE)
              await rotateForWrongCodes(
                c,
                venueId,
                { id: s.id, roomId: request.params.roomId, roomName: room.name },
                now,
              );
            return { wrong: true as const };
          }
          const guestId = await insertRoomGuest(c, venueId, {
            sessionId: s.id,
            roomId: request.params.roomId,
            tokenHash: tokenHash(token),
            tokenVersion: s.token_version,
            isHost: false,
            at: now.toString(),
          });
          await emitEvent(c, {
            venueId,
            type: "room.guest_joined",
            entityId: guestId,
            entityVersion: 0,
            roomId: request.params.roomId,
          });
          return { guestId };
        },
      );
      // A wrong code is counted even though the answer is a refusal, so the count commits first.
      if ("closed" in result)
        throw new ApiError("not_found", `${room.name} is closed`, {
          details: { reason: "closed", room_name: room.name },
        });
      if ("wrong" in result)
        throw new ApiError("invalid_request", "that code isn't right", {
          details: { reason: "wrong_code" },
        });
      setRoomCookie(reply, options.auth, token);
      return reply.code(201).send({ joined: true, is_host: false, room_name: room.name });
    },
  );

  const hostBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/) }).strict();
  app.post<{ Body: unknown }>(
    "/v1/public/room-session/host",
    { config: open },
    async (request, reply) => {
      const parsed = hostBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("not_found", "this link has expired");
      const found = await resolveRoomHost(options.pool, tokenHash(parsed.data.token));
      if (!found)
        throw new ApiError("not_found", "this link has expired", {
          details: { reason: "expired" },
        });
      const now = options.clock.now();
      const token = newToken();
      const room = await withVenue(
        options.pool,
        { venueId: found.venueId, requestId: request.requestId },
        async (c) => {
          const s = await c.query<{ room_id: string; token_version: number; name: string }>(
            `select s.room_id, s.token_version, r.name from room_sessions s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
            where s.venue_id = $1 and s.id = $2 and s.ended_at is null`,
            [found.venueId, found.sessionId],
          );
          const row = s.rows[0];
          if (!row)
            throw new ApiError("not_found", "this link has expired", {
              details: { reason: "expired" },
            });
          const guestId = await insertRoomGuest(c, found.venueId, {
            sessionId: found.sessionId,
            roomId: row.room_id,
            tokenHash: tokenHash(token),
            tokenVersion: row.token_version,
            isHost: true,
            at: now.toString(),
          });
          await emitEvent(c, {
            venueId: found.venueId,
            type: "room.guest_joined",
            entityId: guestId,
            entityVersion: 0,
            roomId: row.room_id,
          });
          return row;
        },
      );
      setRoomCookie(reply, options.auth, token);
      return reply.code(201).send({ joined: true, is_host: true, room_name: room.name });
    },
  );

  app.get("/v1/public/room-session", { config: guestRoute }, async (request, reply) => {
    let g: RoomGuestRow & { tablet: boolean };
    try {
      g = await roomGuestOf(request, options.pool, options.clock.now());
    } catch (e) {
      // A tablet between sessions reads "Room available" and takes no orders (M3-12).
      if (e instanceof RoomAvailable) return { available: true, room: { name: e.roomName } };
      throw e;
    }
    if (g.session.ended) {
      setRoomCookie(reply, options.auth, null);
      throw new ApiError("not_found", "this room's session has ended", {
        details: { reason: "ended" },
      });
    }
    const now = options.clock.now();
    const venueId = (request.principal as { venueId: string }).venueId;
    let moved: { from: string; to: string } | null = null;
    let rotated = false;
    if (!g.tablet && g.token_version !== g.session.token_version) {
      // The session moved on: a fresh token at its version, in the room it's in now.
      const token = newToken();
      await withVenue(options.pool, { venueId, requestId: request.requestId }, (c) =>
        refreshRoomGuest(c, venueId, g.id, {
          tokenHash: tokenHash(token),
          tokenVersion: g.session.token_version,
          roomId: g.session.room_id,
          at: now.toString(),
        }),
      );
      setRoomCookie(reply, options.auth, token);
      rotated = true;
      if (g.room_id !== g.session.room_id) moved = { from: g.room_name, to: g.session.room_name };
    }
    return {
      venue: { id: venueId, name: g.venue_name, slug: g.venue_slug },
      room: { id: g.session.room_id, name: g.session.room_name },
      code: openRoomCode(g.session.room_code_enc),
      is_host: g.is_host,
      tablet: g.tablet,
      available: false,
      host_lock: g.session.host_lock,
      host_name: g.session.host_name,
      ordering_locked: g.session.ordering_locked,
      rotated,
      moved,
    };
  });
}
