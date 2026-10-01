import { emitEvent, insertFault, type Queryable } from "@west4/db";
import { t, type Locale, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { enqueuePush } from "../push/send-push.js";

/**
 * Room calls (M2-20; screens N19; spec 04 · room_calls). A call reaches the
 * board and every staff phone's Calls list with a push; On it records who and
 * when and clears it everywhere. A "TV or song isn't working" call becomes a
 * fault on its room in one tap (M2-16).
 */
export type CallKind = "mic" | "tv" | "check" | "other";
export const CALL_KINDS: readonly CallKind[] = ["mic", "tv", "check", "other"];

export interface CallRow {
  readonly id: string;
  readonly session_id: string;
  readonly room_id: string;
  readonly room_name: string;
  readonly kind: CallKind;
  readonly created_at: string;
  readonly acked_by: string | null;
  readonly acked_by_name: string | null;
  readonly acked_at: string | null;
}

const COLS = `k.id, k.session_id, s.room_id, r.name as room_name, k.kind, to_json(k.created_at) #>> '{}' as created_at,
  k.acked_by, u.name as acked_by_name, to_json(k.acked_at) #>> '{}' as acked_at
  from room_calls k
  join room_sessions s on s.venue_id = k.venue_id and s.id = k.session_id
  join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
  left join users u on u.id = k.acked_by`;

export async function callById(c: Queryable, venueId: string, id: string) {
  const r = await c.query<CallRow>(`select ${COLS} where k.venue_id = $1 and k.id = $2`, [
    venueId,
    id,
  ]);
  return r.rows[0] ?? null;
}

export async function openCalls(c: Queryable, venueId: string) {
  const r = await c.query<CallRow>(
    `select ${COLS} where k.venue_id = $1 and k.acked_at is null order by k.created_at`,
    [venueId],
  );
  return r.rows;
}

async function announce(c: Queryable, venueId: string, call: CallRow) {
  await emitEvent(c, {
    venueId,
    type: "room.call",
    entityId: call.id,
    entityVersion: call.acked_at ? 1 : 0,
    roomId: call.room_id,
  });
}

export async function createCall(
  c: Queryable,
  venueId: string,
  input: { sessionId: string; kind: CallKind; now: Temporal.Instant },
): Promise<CallRow> {
  const open = await c.query(
    "select 1 from room_sessions where venue_id = $1 and id = $2 and ended_at is null",
    [venueId, input.sessionId],
  );
  if (!open.rowCount) throw new ApiError("invalid_request", "nobody is in that room");
  const id = (
    await c.query<{ id: string }>(
      "insert into room_calls (venue_id, session_id, kind, created_at) values ($1, $2, $3, $4) returning id",
      [venueId, input.sessionId, input.kind, input.now.toString()],
    )
  ).rows[0]!.id;
  const call = (await callById(c, venueId, id))!;
  await announce(c, venueId, call);
  await enqueuePush(c, {
    venueId,
    audience: { kind: "everyone" },
    message: {
      key: `calls.push.${input.kind}`,
      params: { room: call.room_name },
      url: "/calls",
      tag: `call-${id}`,
    },
    runAt: input.now,
  });
  return call;
}

export async function ackCall(
  c: Queryable,
  venueId: string,
  id: string,
  input: { userId: string; now: Temporal.Instant },
): Promise<CallRow> {
  const call = await callById(c, venueId, id);
  if (!call) throw new ApiError("not_found", "no such call");
  if (call.acked_at) return call;
  await c.query(
    "update room_calls set acked_by = $3, acked_at = $4 where venue_id = $1 and id = $2 and acked_at is null",
    [venueId, id, input.userId, input.now.toString()],
  );
  const done = (await callById(c, venueId, id))!;
  await announce(c, venueId, done);
  return done;
}

/** "TV or song isn't working" as a fault on its room, in the words of the person who taps, and the call is On it. */
export async function callToFault(
  c: Queryable,
  venueId: string,
  id: string,
  input: { userId: string; locale: Locale; now: Temporal.Instant },
) {
  const call = await callById(c, venueId, id);
  if (!call) throw new ApiError("not_found", "no such call");
  if (call.kind !== "tv")
    throw new ApiError("invalid_request", "only a TV or song call becomes a fault");
  const faultId = await insertFault(c, venueId, {
    roomId: call.room_id,
    sessionId: call.session_id,
    text: t(input.locale, "calls.kind.tv"),
    reportedBy: input.userId,
    reportedAt: input.now.toString(),
    outOfService: false,
  });
  await emitEvent(c, { venueId, type: "room.updated", entityId: call.room_id, entityVersion: 0 });
  return { fault_id: faultId, call: await ackCall(c, venueId, id, input) };
}
