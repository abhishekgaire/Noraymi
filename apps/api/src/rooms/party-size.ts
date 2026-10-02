import { emitEvent, idCounts, listRooms, readSetting, type Queryable } from "@west4/db";
import { gratuityApplies, rateAt, type RoomForRate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { executors, requestApproval, TargetGone } from "../approvals/service.js";
import { ApiError } from "../http/errors.js";
import { priceContext } from "./checkin.js";

/**
 * The party-size control (M2-17; screens N13; spec 05 · rule 3, Party size):
 * a change closes the current segment on the minute and opens the next with
 * the new billable guests and rate (the VIP rate starts or stops as a VIP-room
 * party crosses its threshold). A paused clock stays paused at the new rate.
 * Lowering it after the gratuity applies needs approval (M4-23; Money rules 3
 * and 9): the ask answers 202 approval_pending (kind party_size_down) and
 * nothing changes until it's approved; then the clock bills the lower size from
 * that minute, and the next finalize records it in the gratuity basis. At West 4
 * every room check carries the gratuity, so every lower size on a room asks.
 */
export async function lowerNeedsApproval(
  c: Queryable,
  venueId: string,
  sessionId: string,
  at: Temporal.Instant,
): Promise<boolean> {
  const row = (
    await c.query<{ kind: string; party_size: number; business_date: string }>(
      `select k.kind, s.party_size, k.business_date::text from room_sessions s
         join checks k on k.venue_id = s.venue_id and k.id = s.check_id
        where s.venue_id = $1 and s.id = $2`,
      [venueId, sessionId],
    )
  ).rows[0];
  if (!row) return false;
  const pay = await readSetting(c, venueId, "pay", Temporal.PlainDate.from(row.business_date));
  if (!pay) return false;
  const g = pay.value.gratuity;
  void at;
  return gratuityApplies(
    g.auto,
    { kind: row.kind as "room", partySize: row.party_size },
    g.partyMin,
  );
}

/** Asks for a lower party size: 202 approval_pending, "Waiting for Andy". */
export async function askLowerPartySize(
  c: Queryable,
  venueId: string,
  sessionId: string,
  input: { partySize: number; userId: string; deviceId: string | null; at: Temporal.Instant },
) {
  const pending = await c.query(
    `select 1 from approvals where venue_id = $1 and kind = 'party_size_down' and target_id = $2 and status = 'pending'`,
    [venueId, sessionId],
  );
  if (pending.rows[0]) throw new ApiError("in_progress", "a lower party size is already waiting");
  return requestApproval(c, venueId, {
    kind: "party_size_down",
    targetKind: "session",
    targetId: sessionId,
    amountCents: null,
    reason: `Party size lowered to ${input.partySize}`,
    payload: { party_size: input.partySize },
    requestedBy: input.userId,
    requestedDeviceId: input.deviceId,
    now: input.at,
  });
}

// Approved on the approver's own phone: the lower size bills from that minute.
executors.set("party_size_down", async (c, venueId, approval, ctx) => {
  const size = Number((approval.payload as { party_size?: number }).party_size);
  const open = await c.query(
    "select 1 from room_sessions where venue_id = $1 and id = $2 and ended_at is null",
    [venueId, approval.target_id],
  );
  if (!open.rows[0] || !Number.isInteger(size) || size < 1) throw new TargetGone();
  await changePartySize(c, venueId, approval.target_id, { partySize: size, at: ctx.at });
});
export async function changePartySize(
  c: Queryable,
  venueId: string,
  sessionId: string,
  input: { partySize: number; at: Temporal.Instant },
) {
  const s = (
    await c.query<{ id: string; room_id: string; ended_at: string | null; party_size: number }>(
      `select id, room_id, to_json(ended_at) #>> '{}' as ended_at, party_size
         from room_sessions where venue_id = $1 and id = $2 for update`,
      [venueId, sessionId],
    )
  ).rows[0];
  if (!s) throw new ApiError("not_found", "no such session");
  if (s.ended_at) throw new ApiError("invalid_request", "the session has ended");
  const seg = (
    await c.query<{ id: string; started_at: string; paused: boolean }>(
      `select id, to_json(started_at) #>> '{}' as started_at, paused from session_segments
        where venue_id = $1 and session_id = $2 and ended_at is null order by started_at desc limit 1`,
      [venueId, s.id],
    )
  ).rows[0];
  if (!seg) throw new ApiError("invalid_request", "the session has no running clock");
  const room = (await listRooms(c, venueId)).find((r) => r.id === s.room_id);
  if (!room) throw new ApiError("not_found", "no such room");
  const minute = input.at.round({ smallestUnit: "minute", roundingMode: "floor" });
  const priced = await priceContext(c, venueId, minute);
  const rate = rateAt(minute, input.partySize, room as RoomForRate, priced.prices, priced.venue);
  if (input.partySize !== s.party_size) {
    const startedAt = seg.started_at;
    const when = minute.epochMilliseconds < Date.parse(startedAt) ? startedAt : minute.toString();
    await c.query("update session_segments set ended_at = $3 where venue_id = $1 and id = $2", [
      venueId,
      seg.id,
      when,
    ]);
    await c.query(
      `insert into session_segments (venue_id, session_id, room_id, started_at, billable_guests, rate_kind, hourly_cents,
                                     band_id, increment_min, rounding, paused, reason, approved_by)
       select venue_id, session_id, room_id, $3, $4, $5, $6, $7, $8, $9, paused, reason, approved_by
         from session_segments where venue_id = $1 and id = $2`,
      [
        venueId,
        seg.id,
        when,
        rate.billableGuests,
        rate.rateKind,
        rate.hourlyCents,
        rate.bandId,
        rate.billing.incrementMin,
        rate.billing.rounding,
      ],
    );
    await c.query("update room_sessions set party_size = $3 where venue_id = $1 and id = $2", [
      venueId,
      s.id,
      input.partySize,
    ]);
    await emitEvent(c, { venueId, type: "session.updated", entityId: s.id, entityVersion: 0 });
    await emitEvent(c, { venueId, type: "room.updated", entityId: s.room_id, entityVersion: 0 });
  }
  return {
    session_id: s.id,
    party_size: input.partySize,
    min_guests: rate.minGuests,
    billable_guests: rate.billableGuests,
    rate_kind: rate.rateKind,
    hourly_cents: rate.hourlyCents,
    ids_checked: (await idCounts(c, venueId, [s.id])).get(s.id) ?? 0,
  };
}
