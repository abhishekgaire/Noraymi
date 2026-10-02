import { createHash } from "node:crypto";
import type pg from "pg";
import type { FastifyRequest } from "fastify";
import { openSessionInRoom, roomGuestById, withVenue, type RoomGuestRow } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";

/**
 * Who is ordering from a room page (M3-08, M3-12): a joined phone (its room
 * cookie), or a room tablet (a signed request from the device paired to the
 * room). A tablet gets its own room guest for each session, named for the
 * tablet and never the host, so its orders carry a room guest like a phone's
 * and the host lock and cut-offs cover it; its token never rotates out from
 * under it. A tablet in a room with no session answers 404 `available`.
 */
export class RoomAvailable extends ApiError {
  constructor(readonly roomName: string) {
    super("not_found", "Room available", { details: { reason: "available", room_name: roomName } });
  }
}

async function tabletGuest(
  pool: pg.Pool,
  venueId: string,
  deviceId: string,
  now: Temporal.Instant,
): Promise<RoomGuestRow> {
  return withVenue(pool, { venueId }, async (c) => {
    const d = await c.query<{ room_id: string | null; name: string; room_name: string | null }>(
      `select d.room_id, d.name, r.name as room_name from devices d
         left join rooms r on r.venue_id = d.venue_id and r.id = d.room_id
        where d.venue_id = $1 and d.id = $2 and d.revoked_at is null`,
      [venueId, deviceId],
    );
    const device = d.rows[0];
    if (!device?.room_id) throw new ApiError("forbidden", "this tablet isn't paired to a room");
    const s = await openSessionInRoom(c, venueId, device.room_id);
    if (!s) throw new RoomAvailable(device.room_name ?? "");
    const hash = createHash("sha256").update(`tablet:${deviceId}:${s.id}`).digest("hex");
    const g = await c.query<{ id: string }>(
      `insert into room_guests (venue_id, session_id, room_id, token_hash, token_version, name, is_host, joined_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, false, $7, $7)
       on conflict (token_hash) do update set token_version = excluded.token_version, room_id = excluded.room_id,
         last_seen_at = excluded.last_seen_at
       returning id`,
      [
        venueId,
        s.id,
        device.room_id,
        hash,
        s.token_version,
        device.name.slice(0, 40),
        now.toString(),
      ],
    );
    return (await roomGuestById(c, venueId, g.rows[0]!.id))!;
  });
}

/** The room guest behind a request, phone or tablet; `venueId` is the venue it belongs to. */
export async function roomGuestOf(
  request: FastifyRequest,
  pool: pg.Pool,
  now: Temporal.Instant,
): Promise<RoomGuestRow & { venueId: string; tablet: boolean }> {
  const p = request.principal;
  if (p.kind === "device" && p.deviceKind === "room_tablet")
    return {
      ...(await tabletGuest(pool, p.venueId, p.deviceId, now)),
      venueId: p.venueId,
      tablet: true,
    };
  const g = request.roomGuest;
  if (!g || p.kind !== "guest") throw new ApiError("unauthorized", "join the room first");
  return { ...g, venueId: p.venueId, tablet: false };
}
