import type pg from "pg";
import {
  checkById,
  emitEvent,
  insertCheck,
  nextCheckNumber,
  withVenue,
  type Queryable,
} from "@west4/db";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { sessionViews } from "./sessions.js";

/**
 * Room checks (M2-08; spec 04 · the money core). Opening one takes its number
 * from the venue's counter in its own short transaction first, then writes the
 * check in the caller's transaction. Check-in (M2-11) calls this.
 */
export async function openRoomCheck(
  pool: pg.Pool,
  input: {
    venueId: string;
    sessionId: string;
    bookingId: string | null;
    businessDate: string;
    openedBy: string;
    now: Temporal.Instant;
  },
): Promise<{ id: string; number: number }> {
  const number = await nextCheckNumber(pool, input.venueId);
  return withVenue(pool, { venueId: input.venueId, userId: input.openedBy }, async (c) => {
    const id = await insertCheck(c, {
      venueId: input.venueId,
      number,
      kind: "room",
      businessDate: input.businessDate,
      roomSessionId: input.sessionId,
      bookingId: input.bookingId,
      openedBy: input.openedBy,
      openedAt: input.now.toString(),
    });
    await c.query("update room_sessions set check_id = $3 where venue_id = $1 and id = $2", [
      input.venueId,
      input.sessionId,
      id,
    ]);
    await emitEvent(c, {
      venueId: input.venueId,
      type: "check.updated",
      entityId: id,
      entityVersion: 0,
    });
    return { id, number };
  });
}

/** A check with its lines and the tab so far: room time so far (live, from its session) plus the lines. */
export async function checkView(c: Queryable, venueId: string, id: string, now: Temporal.Instant) {
  const found = await checkById(c, venueId, id);
  if (!found) throw new ApiError("not_found", "no such check");
  const session = found.check.room_session_id
    ? (await sessionViews(c, venueId, now, found.check.room_session_id))[0]
    : undefined;
  const roomTime = session?.clock.roomTimeCents ?? 0;
  const lines = found.lines.reduce((sum, l) => sum + l.amount_cents, 0);
  return {
    check: { ...found.check, label: `#${found.check.number}` },
    lines: found.lines,
    room_time_cents: roomTime,
    minutes: session?.clock.minutes ?? null,
    lines_cents: lines,
    tab_so_far_cents: roomTime + lines,
  };
}
