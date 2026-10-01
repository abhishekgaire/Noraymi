import {
  addBlock,
  addCheckLine,
  blocksBetween,
  emitEvent,
  linkFault,
  readSetting,
  reasonOnlyUsed,
  releaseBlock,
  RoomNotFree,
  setBlockEnd,
  setRoomState,
  type Queryable,
} from "@west4/db";
import { compMinutesCents, reasonOnly } from "@west4/rules";
import { cents, Temporal } from "@west4/shared";
import {
  executors,
  requestApproval,
  TargetGone,
  type PendingAnswer,
} from "../approvals/service.js";
import { ApiError } from "../http/errors.js";
import { reassignFutureBookings } from "./assignment.js";

/**
 * Faults and the room clock (M2-16; spec 05 · rule 3, Pauses and faults, and
 * rule 7; screens N14). Out of service takes the room off the board and out of
 * assignment; a pause always waits for approval and, once approved, bills
 * nothing from that minute; "Comp 15 min of room time" is a reason-only comp
 * at the segment's rate, under the same limits as any other.
 */
export const COMP_MINUTES = 15;

interface OpenSegment {
  id: string;
  hourly_cents: number;
  paused: boolean;
  started_at: string;
}

async function openSession(c: Queryable, venueId: string, sessionId: string) {
  const s = (
    await c.query<{
      id: string;
      room_id: string;
      check_id: string | null;
      business_date: string;
      ended_at: string | null;
    }>(
      `select id, room_id, check_id, business_date::text, to_json(ended_at) #>> '{}' as ended_at
         from room_sessions where venue_id = $1 and id = $2 for update`,
      [venueId, sessionId],
    )
  ).rows[0];
  return s ?? null;
}

async function openSegment(c: Queryable, venueId: string, sessionId: string) {
  const r = await c.query<OpenSegment>(
    `select id, hourly_cents, paused, to_json(started_at) #>> '{}' as started_at from session_segments
      where venue_id = $1 and session_id = $2 and ended_at is null order by started_at desc limit 1`,
    [venueId, sessionId],
  );
  return r.rows[0] ?? null;
}

/** The segment whose rate a comp uses: the open one, or the last billing one while paused. */
async function billingSegment(c: Queryable, venueId: string, sessionId: string) {
  const r = await c.query<OpenSegment>(
    `select id, hourly_cents, paused, to_json(started_at) #>> '{}' as started_at from session_segments
      where venue_id = $1 and session_id = $2 and not paused order by started_at desc limit 1`,
    [venueId, sessionId],
  );
  return r.rows[0] ?? null;
}

/** Closes the open segment and opens the next one on the minute: the same rate, paused or billing. */
async function nextSegment(
  c: Queryable,
  venueId: string,
  from: OpenSegment,
  at: Temporal.Instant,
  next: { paused: boolean; reason: string | null; approvedBy: string | null },
): Promise<string> {
  const minute = at.round({ smallestUnit: "minute", roundingMode: "floor" });
  const start = Temporal.Instant.from(from.started_at);
  const when = Temporal.Instant.compare(minute, start) < 0 ? start : minute;
  await c.query("update session_segments set ended_at = $3 where venue_id = $1 and id = $2", [
    venueId,
    from.id,
    when.toString(),
  ]);
  const r = await c.query<{ id: string }>(
    `insert into session_segments (venue_id, session_id, room_id, started_at, billable_guests, rate_kind, hourly_cents,
                                   band_id, increment_min, rounding, paused, reason, approved_by)
     select venue_id, session_id, room_id, $3, billable_guests, rate_kind, hourly_cents, band_id, increment_min, rounding, $4, $5, $6
       from session_segments where venue_id = $1 and id = $2 returning id`,
    [venueId, from.id, when.toString(), next.paused, next.reason, next.approvedBy],
  );
  return r.rows[0]!.id;
}

async function sessionChanged(c: Queryable, venueId: string, sessionId: string, roomId: string) {
  await emitEvent(c, { venueId, type: "session.updated", entityId: sessionId, entityVersion: 0 });
  await emitEvent(c, { venueId, type: "room.updated", entityId: roomId, entityVersion: 0 });
}

/** "Pause the clock": always an approval (kind clock_pause), never a direct write. */
export async function requestPause(
  c: Queryable,
  venueId: string,
  input: {
    sessionId: string;
    reason: string;
    faultId: string | null;
    requestedBy: string;
    requestedDeviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<PendingAnswer> {
  const s = await openSession(c, venueId, input.sessionId);
  if (!s) throw new ApiError("not_found", "no such session");
  if (s.ended_at) throw new ApiError("invalid_request", "the session has ended");
  const seg = await openSegment(c, venueId, s.id);
  if (seg?.paused) throw new ApiError("invalid_request", "the clock is already paused");
  return requestApproval(c, venueId, {
    kind: "clock_pause",
    targetKind: "session",
    targetId: s.id,
    amountCents: null,
    reason: input.reason,
    payload: { session_id: s.id, fault_id: input.faultId },
    requestedBy: input.requestedBy,
    requestedDeviceId: input.requestedDeviceId,
    now: input.now,
  });
}

/** Runs an approved pause: the clock bills nothing from the approval's minute, with its approver. */
export async function pauseClock(
  c: Queryable,
  venueId: string,
  input: {
    sessionId: string;
    reason: string;
    approvedBy: string;
    at: Temporal.Instant;
    faultId: string | null;
  },
): Promise<string> {
  const s = await openSession(c, venueId, input.sessionId);
  if (!s || s.ended_at) throw new TargetGone();
  const seg = await openSegment(c, venueId, s.id);
  if (!seg || seg.paused) throw new TargetGone();
  const id = await nextSegment(c, venueId, seg, input.at, {
    paused: true,
    reason: input.reason,
    approvedBy: input.approvedBy,
  });
  if (input.faultId) await linkFault(c, venueId, input.faultId, { pauseSegmentId: id });
  await sessionChanged(c, venueId, s.id, s.room_id);
  return id;
}

/** Starts billing again from this minute. */
export async function unpauseClock(
  c: Queryable,
  venueId: string,
  sessionId: string,
  at: Temporal.Instant,
): Promise<string> {
  const s = await openSession(c, venueId, sessionId);
  if (!s) throw new ApiError("not_found", "no such session");
  if (s.ended_at) throw new ApiError("invalid_request", "the session has ended");
  const seg = await openSegment(c, venueId, s.id);
  if (!seg?.paused) throw new ApiError("invalid_request", "the clock isn't paused");
  const id = await nextSegment(c, venueId, seg, at, {
    paused: false,
    reason: null,
    approvedBy: null,
  });
  await sessionChanged(c, venueId, s.id, s.room_id);
  return id;
}

export type CompAnswer =
  | { readonly status: "added"; readonly line_id: number; readonly amount_cents: number }
  | PendingAnswer;

/**
 * "Comp 15 min of room time": 15 minutes at the segment's rate as a `comp`
 * line with tax category room_time, written at once within the reason-only
 * limit, otherwise waiting for approval. Room time lines are computed at
 * finalize (M4), so the comp points at its segment (source_id), not a line.
 */
export async function compMinutes(
  c: Queryable,
  venueId: string,
  input: {
    sessionId: string;
    minutes: number;
    reason: string;
    faultId: string | null;
    requestedBy: string;
    requestedDeviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<CompAnswer> {
  if (!input.reason.trim()) throw new ApiError("invalid_request", "a comp needs a reason");
  const s = await openSession(c, venueId, input.sessionId);
  if (!s) throw new ApiError("not_found", "no such session");
  if (!s.check_id) throw new ApiError("invalid_request", "the session has no check");
  const seg = await billingSegment(c, venueId, s.id);
  if (!seg) throw new ApiError("invalid_request", "the session has no room time to comp");
  const amount = compMinutesCents(input.minutes, cents(seg.hourly_cents));
  const payload = {
    check_id: s.check_id,
    description: `Comp ${input.minutes} min of room time`,
    amount_cents: amount,
    tax_category: "room_time",
    business_date: s.business_date,
    source_id: seg.id,
    fault_id: input.faultId,
  };
  const pos = await readSetting(c, venueId, "pos", Temporal.PlainDate.from(s.business_date));
  const limits = pos?.value.reasonOnly ?? { eachCents: 0, perShiftCents: 0 };
  const used = await reasonOnlyUsed(c, venueId, input.requestedBy, s.business_date);
  if (reasonOnly(cents(used), cents(-amount), limits).needsApproval)
    return requestApproval(c, venueId, {
      kind: "comp",
      targetKind: "check",
      targetId: s.check_id,
      amountCents: amount,
      reason: input.reason,
      payload,
      requestedBy: input.requestedBy,
      requestedDeviceId: input.requestedDeviceId,
      now: input.now,
    });
  const lineId = await writeComp(c, venueId, payload, {
    reason: input.reason,
    addedBy: input.requestedBy,
    approvedBy: null,
    at: input.now,
  });
  return { status: "added", line_id: lineId, amount_cents: amount };
}

export interface CompPayload {
  check_id?: string;
  description?: string;
  amount_cents?: number;
  tax_category?: string | null;
  business_date?: string;
  source_id?: string | null;
  fault_id?: string | null;
}

/** The comp line itself (reason-only or approved), linked from its fault when there is one. */
export async function writeComp(
  c: Queryable,
  venueId: string,
  p: CompPayload,
  who: { reason: string; addedBy: string; approvedBy: string | null; at: Temporal.Instant },
): Promise<number> {
  const check = await c.query<{ status: string }>(
    "select status from checks where venue_id = $1 and id = $2",
    [venueId, p.check_id],
  );
  if (!check.rows[0] || check.rows[0].status !== "open") throw new TargetGone();
  const size = Math.abs(p.amount_cents ?? 0);
  const lineId = await addCheckLine(c, venueId, p.check_id!, {
    kind: "comp",
    description: p.description ?? "Comp",
    qty: 1,
    unitCents: -size,
    amountCents: -size,
    taxCategory: p.tax_category ?? null,
    businessDate: p.business_date!,
    reason: who.reason,
    addedBy: who.addedBy,
    approvedBy: who.approvedBy,
    addedAt: who.at.toString(),
    sourceId: p.source_id ?? null,
  });
  if (p.fault_id) await linkFault(c, venueId, p.fault_id, { compLineId: lineId });
  await emitEvent(c, {
    venueId,
    type: "check.updated",
    entityId: p.check_id!,
    entityVersion: 0,
  });
  return lineId;
}

/**
 * Out of service: the room's state, an `out_of_service` block from now (after
 * whatever is using the room now) up to the first booking that couldn't be
 * moved, its future bookings reassigned, and the ones that no longer fit
 * listed for a manager. Its tablet reads the state and goes off.
 */
export async function takeOutOfService(
  c: Queryable,
  venueId: string,
  roomId: string,
  input: { reason: string; setBy: string | null; now: Temporal.Instant },
) {
  await setRoomState(c, venueId, roomId, {
    state: "out_of_service",
    reason: input.reason,
    setBy: input.setBy ?? undefined,
    at: input.now.toString(),
  });
  const reassigned = await reassignFutureBookings(c, venueId, roomId, input.now);
  const blocks = (await blocksBetween(c, venueId, input.now.subtract({ hours: 24 }), null)).filter(
    (b) => b.room_id === roomId,
  );
  const covering = blocks.filter(
    (b) =>
      Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), input.now) <= 0 &&
      (b.ends_at === null ||
        Temporal.Instant.compare(input.now, Temporal.Instant.from(b.ends_at)) < 0),
  );
  if (!covering.some((b) => b.ends_at === null)) {
    const from = covering.reduce((at, b) => {
      const end = Temporal.Instant.from(b.ends_at!);
      return Temporal.Instant.compare(end, at) > 0 ? end : at;
    }, input.now);
    const next = blocks
      .filter((b) => Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), from) >= 0)
      .map((b) => Temporal.Instant.from(b.starts_at))
      .sort(Temporal.Instant.compare)[0];
    await c.query("savepoint out_of_service_block");
    try {
      await addBlock(c, { venueId, roomId, kind: "out_of_service", from, to: next ?? null });
    } catch (e) {
      if (!(e instanceof RoomNotFree)) throw e;
      await c.query("rollback to savepoint out_of_service_block");
    }
  }
  await emitEvent(c, { venueId, type: "room.updated", entityId: roomId, entityVersion: 0 });
  return reassigned;
}

/** Back in service once its last out-of-service fault is fixed: the block ends now and the room is free. */
export async function backInService(
  c: Queryable,
  venueId: string,
  roomId: string,
  input: { setBy: string; now: Temporal.Instant },
): Promise<void> {
  const open = await c.query(
    "select 1 from room_faults where venue_id = $1 and room_id = $2 and out_of_service and fixed_at is null",
    [venueId, roomId],
  );
  if ((open.rowCount ?? 0) > 0) return;
  const session = await c.query(
    "select 1 from room_sessions where venue_id = $1 and room_id = $2 and ended_at is null",
    [venueId, roomId],
  );
  await setRoomState(c, venueId, roomId, {
    state: (session.rowCount ?? 0) > 0 ? "in_use" : "available",
    reason: null,
    setBy: input.setBy,
    at: input.now.toString(),
  });
  const blocks = (
    await blocksBetween(c, venueId, input.now.subtract({ hours: 24 * 400 }), null)
  ).filter((b) => b.room_id === roomId && b.kind === "out_of_service");
  for (const b of blocks) {
    if (
      b.ends_at !== null &&
      Temporal.Instant.compare(Temporal.Instant.from(b.ends_at), input.now) <= 0
    )
      continue;
    if (Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), input.now) >= 0)
      await releaseBlock(c, b.id);
    else await setBlockEnd(c, venueId, b.id, input.now);
  }
  await emitEvent(c, { venueId, type: "room.updated", entityId: roomId, entityVersion: 0 });
}

/** What runs when a comp (room time now, drinks in M3) or a clock pause is approved. */
executors.set("comp", async (c, venueId, approval, ctx) => {
  await writeComp(c, venueId, approval.payload as CompPayload, {
    reason: approval.reason,
    addedBy: approval.requested_by,
    approvedBy: ctx.approverId,
    at: ctx.at,
  });
});

executors.set("clock_pause", async (c, venueId, approval, ctx) => {
  const p = approval.payload as { session_id?: string; fault_id?: string | null };
  await pauseClock(c, venueId, {
    sessionId: p.session_id ?? approval.target_id,
    reason: approval.reason,
    approvedBy: ctx.approverId,
    at: ctx.at,
    faultId: p.fault_id ?? null,
  });
});
