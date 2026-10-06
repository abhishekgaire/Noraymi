import {
  blocksBetween,
  emitEvent,
  idCounts,
  readSetting,
  releaseBlock,
  RoomNotFree,
  setBlockEnd,
  setRoomState,
  type Queryable,
} from "@west4/db";
import { sessionClock, type SessionClock } from "@west4/rules";
import { Temporal, cents } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { nightOf, venueClock } from "./assignment.js";
import { sendToCleaning } from "./cleaning.js";
import { enqueuePush } from "../push/send-push.js";

/**
 * Room sessions and the live room clock (M2-07; spec 04 · room_sessions,
 * session_segments; spec 05 · rules 3 and 4). The server's times decide
 * everything; screens tick on their measured offset and fetch these totals
 * again every minute.
 */
export const RESUME_WITHIN_MIN = 10;

interface SessionRow {
  id: string;
  /** A practice session (training mode, M7-03): it blocks nothing and only screens in training see it. */
  training: boolean;
  room_id: string;
  room_name: string;
  booking_id: string | null;
  check_id: string | null;
  party_size: number;
  started_at: string;
  booked_end_at: string | null;
  ended_at: string | null;
  business_date: string;
  room_code_hash: string | null;
  token_version: number;
  /** The booking's guest (M2-24: the board's "Text Rob & Kim: please wrap up"). */
  guest_name: string | null;
  /** The room's alcohol cut-off (M3-21): when, by whom (first name) and why. */
  alcohol_cut_off_at: string | null;
  alcohol_cut_off_by_name: string | null;
  alcohol_cut_off_reason: string | null;
}

interface SegmentRow {
  id: string;
  session_id: string;
  started_at: string;
  ended_at: string | null;
  billable_guests: number;
  rate_kind: string;
  hourly_cents: number;
  band_id: string | null;
  increment_min: 1 | 15 | 30 | 60;
  rounding: "up" | "nearest" | "down";
  paused: boolean;
}

const iso = (col: string) => `to_json(${col}) #>> '{}'`;
const SESSION_COLS = `s.id, s.room_id, r.name as room_name, s.booking_id, s.check_id, s.party_size,
  ${iso("s.started_at")} as started_at, ${iso("s.booked_end_at")} as booked_end_at, ${iso("s.ended_at")} as ended_at,
  s.business_date::text, s.room_code_hash, s.token_version,
  coalesce(
    (select g.name from bookings b join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
      where b.venue_id = s.venue_id and b.id = s.booking_id),
    (select g.name from guests g where g.venue_id = s.venue_id and g.id = s.guest_id)) as guest_name,
  ${iso("s.alcohol_cut_off_at")} as alcohol_cut_off_at,
  (select split_part(u.name, ' ', 1) from users u where u.id = s.alcohol_cut_off_by) as alcohol_cut_off_by_name,
  s.alcohol_cut_off_reason, s.training`;
const SEGMENT_COLS = `id, session_id, ${iso("started_at")} as started_at, ${iso("ended_at")} as ended_at,
  billable_guests, rate_kind, hourly_cents, band_id, increment_min, rounding, paused`;

async function sessionRows(c: Queryable, venueId: string, where: string, args: unknown[]) {
  const r = await c.query<SessionRow>(
    `select ${SESSION_COLS} from room_sessions s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
      where s.venue_id = $1 and ${where} order by r.is_vip, nullif(regexp_replace(r.name, '\\D', '', 'g'), '')::int nulls last`,
    [venueId, ...args],
  );
  return r.rows;
}

async function segmentsOf(c: Queryable, venueId: string, sessionIds: string[]) {
  if (sessionIds.length === 0) return [];
  const r = await c.query<SegmentRow>(
    `select ${SEGMENT_COLS} from session_segments where venue_id = $1 and session_id = any($2::uuid[]) order by started_at`,
    [venueId, sessionIds],
  );
  return r.rows;
}

export interface SessionView extends SessionRow {
  readonly clock: SessionClock;
  readonly close: string | null;
  readonly segments: SegmentRow[];
  readonly ids_checked: number;
}

/** Sessions with their live clock at `now`: the open ones, or one by id. */
export async function sessionViews(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  only?: string,
  /** The open sessions a screen in training sees: the live ones and the practice ones. */
  training = false,
): Promise<SessionView[]> {
  const sessions = only
    ? await sessionRows(c, venueId, "s.id = $2", [only])
    : await sessionRows(c, venueId, "s.ended_at is null and (not s.training or $2)", [training]);
  if (sessions.length === 0) return [];
  const venue = await venueClock(c, venueId);
  const night = await nightOf(c, venueId, venue, now);
  const [rooms, prices, alerts] = await Promise.all([
    readSetting(c, venueId, "rooms", night.businessDate),
    readSetting(c, venueId, "prices", night.businessDate),
    readSetting(c, venueId, "alerts", night.businessDate),
  ]);
  const segments = await segmentsOf(
    c,
    venueId,
    sessions.map((s) => s.id),
  );
  const ids = await idCounts(
    c,
    venueId,
    sessions.map((s) => s.id),
  );
  // Past the close (the clock keeps ticking), look a little ahead rather than build a backwards range.
  const ahead =
    night.close && Temporal.Instant.compare(night.close, now) > 0
      ? night.close
      : now.add({ hours: 24 });
  const blocks = await blocksBetween(c, venueId, now, ahead);
  return sessions.map((s) => {
    const mine = segments.filter((g) => g.session_id === s.id);
    const next = blocks
      .filter(
        (b) =>
          b.room_id === s.room_id &&
          (b.kind === "booking" || b.kind === "hold") &&
          Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), now) > 0,
      )
      .sort((a, b) =>
        Temporal.Instant.compare(
          Temporal.Instant.from(a.starts_at),
          Temporal.Instant.from(b.starts_at),
        ),
      )[0];
    const last = mine.at(-1);
    const end = s.ended_at ? Temporal.Instant.from(s.ended_at) : now;
    const clock = sessionClock({
      segments: mine.map((g) => ({
        startedAt: Temporal.Instant.from(g.started_at),
        endedAt: g.ended_at ? Temporal.Instant.from(g.ended_at) : null,
        hourlyCents: cents(g.hourly_cents),
        paused: g.paused,
      })),
      now: end,
      bookedEnd: s.booked_end_at ? Temporal.Instant.from(s.booked_end_at) : null,
      nextNeedsRoomAt: next ? Temporal.Instant.from(next.starts_at) : null,
      close: night.close,
      stayOnWhenFree: rooms?.value.stayOnWhenFree ?? false,
      noticeMin: alerts?.value.roomEndingMin ?? 10,
      firstHourMinimum: prices?.value.firstHourMinimum ?? true,
      ...(last ? { step: { incrementMin: last.increment_min, rounding: last.rounding } } : {}),
    });
    return {
      ...s,
      clock,
      close: night.close?.toString() ?? null,
      segments: mine,
      ids_checked: ids.get(s.id) ?? 0,
    };
  });
}

async function sessionOrThrow(c: Queryable, venueId: string, id: string) {
  const s = (await sessionRows(c, venueId, "s.id = $2", [id]))[0];
  if (!s) throw new ApiError("not_found", "no such session");
  return s;
}

/** The session's current block: the latest, since a move ends the old room's and opens one in the new room. */
export async function sessionBlock(c: Queryable, venueId: string, sessionId: string) {
  const r = await c.query<{ id: string; ends_at: string | null }>(
    `select id, ${iso("upper(period)")} as ends_at from room_blocks where venue_id = $1 and ref_id = $2 and kind = 'session'
      order by lower(period) desc limit 1`,
    [venueId, sessionId],
  );
  return r.rows[0] ?? null;
}

/** Ends a session: the clock stops, the room goes to cleaning until staff mark it clean or the next booking. */
export async function endSession(
  c: Queryable,
  venueId: string,
  id: string,
  now: Temporal.Instant,
  userId?: string,
) {
  const s = await sessionOrThrow(c, venueId, id);
  if (s.ended_at) throw new ApiError("invalid_request", "this session has ended");
  await c.query("update room_sessions set ended_at = $3 where venue_id = $1 and id = $2", [
    venueId,
    id,
    now.toString(),
  ]);
  await c.query(
    "update session_segments set ended_at = $3 where venue_id = $1 and session_id = $2 and ended_at is null",
    [venueId, id, now.toString()],
  );
  // A practice session writes no blocks and no room states (M7-03): the room was never taken.
  if (s.training) {
    await emitEvent(c, { venueId, type: "room.updated", entityId: s.room_id, entityVersion: 0 });
    return;
  }
  const block = await sessionBlock(c, venueId, id);
  if (block) await setBlockEnd(c, venueId, block.id, now);
  await sendToCleaning(c, venueId, s.room_id, { now, userId });
}

/**
 * Resumes a session ended by mistake, within 10 minutes: the same room code,
 * the same check, and room time billed straight through (the party never
 * left; flagged in M2-07).
 */
export async function resumeSession(
  c: Queryable,
  venueId: string,
  id: string,
  now: Temporal.Instant,
  userId?: string,
) {
  const s = await sessionOrThrow(c, venueId, id);
  if (!s.ended_at) throw new ApiError("invalid_request", "this session is still open");
  const ended = Temporal.Instant.from(s.ended_at);
  if (Temporal.Instant.compare(now, ended.add({ minutes: RESUME_WITHIN_MIN })) > 0)
    throw new ApiError(
      "invalid_request",
      `a session resumes only within ${RESUME_WITHIN_MIN} minutes of its end`,
    );
  const open = await sessionRows(
    c,
    venueId,
    "s.room_id = $2 and s.ended_at is null and s.training = $3",
    [s.room_id, s.training],
  );
  if (open.length > 0) throw new ApiError("room_not_free", "another party is in that room now");
  // The cleaning block the end wrote goes; the session's block runs on again.
  const cleaning = await c.query<{ id: string }>(
    "select id from room_blocks where venue_id = $1 and room_id = $2 and kind = 'cleaning' and lower(period) = $3::timestamptz",
    [venueId, s.room_id, ended.toString()],
  );
  if (!s.training) for (const row of cleaning.rows) await releaseBlock(c, row.id);
  const block = await sessionBlock(c, venueId, id);
  const planned = s.booked_end_at ? Temporal.Instant.from(s.booked_end_at) : ended;
  let until = Temporal.Instant.compare(planned, now) > 0 ? planned : ended;
  while (Temporal.Instant.compare(until, now) <= 0) until = until.add({ minutes: 15 });
  try {
    if (block) await setBlockEnd(c, venueId, block.id, until);
  } catch (e) {
    if (e instanceof RoomNotFree)
      throw new ApiError("room_not_free", "the room has been given to someone else");
    throw e;
  }
  await c.query("update room_sessions set ended_at = null where venue_id = $1 and id = $2", [
    venueId,
    id,
  ]);
  await c.query(
    "update session_segments set ended_at = null where venue_id = $1 and session_id = $2 and ended_at = $3::timestamptz",
    [venueId, id, ended.toString()],
  );
  if (!s.training)
    await setRoomState(c, venueId, s.room_id, {
      state: "in_use",
      setBy: userId,
      at: now.toString(),
    });
  await emitEvent(c, { venueId, type: "room.updated", entityId: s.room_id, entityVersion: 0 });
}

/** Moves the soft booked end (the clock never stops at it); the room's block follows, refused if it would overlap. */
export async function setBookedEnd(
  c: Queryable,
  venueId: string,
  id: string,
  end: Temporal.Instant,
  now: Temporal.Instant,
) {
  const s = await sessionOrThrow(c, venueId, id);
  if (s.ended_at) throw new ApiError("invalid_request", "this session has ended");
  const venue = await venueClock(c, venueId);
  const night = await nightOf(c, venueId, venue, Temporal.Instant.from(s.started_at));
  if (night.close && Temporal.Instant.compare(end, night.close) > 0)
    throw new ApiError("invalid_request", "nothing runs past the night's close");
  if (Temporal.Instant.compare(end, Temporal.Instant.from(s.started_at)) <= 0)
    throw new ApiError("invalid_request", "the end comes after the start");
  const block = await sessionBlock(c, venueId, id);
  try {
    if (block)
      await setBlockEnd(
        c,
        venueId,
        block.id,
        Temporal.Instant.compare(end, now) > 0 ? end : now.add({ minutes: 15 }),
      );
  } catch (e) {
    if (e instanceof RoomNotFree)
      throw new ApiError("room_not_free", "the room is booked before then");
    throw e;
  }
  await c.query("update room_sessions set booked_end_at = $3 where venue_id = $1 and id = $2", [
    venueId,
    id,
    end.toString(),
  ]);
  await emitEvent(c, { venueId, type: "room.updated", entityId: s.room_id, entityVersion: 0 });
}

/** Rooms whose session needs wrapping up (someone next, or the close) go to wrap-up; the board reads it. */
export async function markWrapUps(c: Queryable, venueId: string, now: Temporal.Instant) {
  const views = await sessionViews(c, venueId, now);
  const changed: string[] = [];
  for (const v of views) {
    if (!v.clock.wrapUp) continue;
    const r = await c.query(
      "update room_states set state = 'wrap_up', since = $3 where venue_id = $1 and room_id = $2 and state = 'in_use'",
      [venueId, v.room_id, now.toString()],
    );
    if (r.rowCount === 1) {
      changed.push(v.room_id);
      await emitEvent(c, { venueId, type: "room.updated", entityId: v.room_id, entityVersion: 0 });
      // Every staff phone hears it once per room and booked end (M2-32; Staff note 14).
      await enqueuePush(c, {
        venueId,
        audience: { kind: "everyone" },
        message: {
          key: "push.wrapUp",
          params: { room: v.room_name },
          url: "/tonight",
          tag: `wrap-${v.id}`,
        },
        runAt: now,
        dedupeKey: `push:wrap:${v.id}:${v.booked_end_at ?? ""}`,
      });
    }
  }
  return changed;
}
