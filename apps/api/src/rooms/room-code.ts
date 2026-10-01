import { decryptSecret, emitEvent, encryptSecret, type Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { enqueuePush } from "../push/send-push.js";
import { managerOnDutyAt } from "../approvals/service.js";
import { hashRoomCode, newRoomCode } from "./checkin.js";

/**
 * Room codes (M3-08). A code is stored hashed, for joining, and sealed with
 * the API's secret key, so phones already in the room can be shown a new one
 * after a rotation ("You've moved to Room 11 · new code …"). The key is set
 * once when the app is built (buildApp), from AUTH_SECRET_KEY.
 */
let sealKey: Buffer | null = null;

export function setRoomCodeKey(key: Buffer): void {
  sealKey = key;
}

export function sealRoomCode(code: string): string | null {
  return sealKey ? encryptSecret(sealKey, code) : null;
}

export function openRoomCode(sealed: string | null): string | null {
  if (!sealed || !sealKey) return null;
  try {
    return decryptSecret(sealKey, sealed);
  } catch {
    return null;
  }
}

/** A room's code columns for a new code: the hash for joining, the sealed code for joined phones. */
export function roomCodeColumns(venueId: string, code: string) {
  return { hash: hashRoomCode(venueId, code), sealed: sealRoomCode(code) };
}

/** Ten wrong codes for one room: a new code, so the old one stops working, and staff are told. */
export const WRONG_CODES_TO_ROTATE = 10;

export async function rotateForWrongCodes(
  c: Queryable,
  venueId: string,
  session: { id: string; roomId: string; roomName: string },
  now: Temporal.Instant,
): Promise<void> {
  const code = newRoomCode(session.roomName);
  const cols = roomCodeColumns(venueId, code);
  await c.query(
    `update room_sessions set room_code_hash = $3, room_code_enc = $4, token_version = token_version + 1,
            wrong_codes = 0, code_alert_at = $5
      where venue_id = $1 and id = $2`,
    [venueId, session.id, cols.hash, cols.sealed, now.toString()],
  );
  await emitEvent(c, { venueId, type: "room.updated", entityId: session.roomId, entityVersion: 0 });
  // Joined phones in the room fetch their fresh token and the new code.
  await emitEvent(c, {
    venueId,
    type: "session.code_changed",
    entityId: session.id,
    entityVersion: 0,
    roomId: session.roomId,
  });
  const manager = await managerOnDutyAt(c, venueId, now);
  if (manager)
    await enqueuePush(c, {
      venueId,
      audience: { kind: "person", userId: manager },
      message: {
        key: "joinCode.rotated.push",
        params: { room: session.roomName },
        url: "/tonight",
        tag: `room-code-${session.id}`,
      },
      runAt: now,
    });
}
