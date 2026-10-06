import { tabHoldOf } from "../payments/splits.js";
import { amountDue, amountDueBesideHolds, emitEvent, insertCheck, type Queryable } from "@west4/db";
import { movedHolds, releaseMovedHolds } from "../tabs/move.js";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { finalizeCheck } from "./finalize.js";
import { endSession } from "./sessions.js";

/**
 * Presenting a room check, reopening it, and paid in full (M4-08; Money
 * rules 6; Payment flows · Room close-out steps 1 and 4).
 */
export interface Blocker {
  readonly order_id: string;
  readonly status: "ringing" | "held";
  /** "2 × Margarita · Peach": the screen builds the sentence from it. */
  readonly items: string;
}

/** Orders on a session still ringing or asked to wait, oldest first. */
export async function openOrders(
  c: Queryable,
  venueId: string,
  sessionId: string,
): Promise<Blocker[]> {
  const r = await c.query<{
    id: string;
    status: "ringing" | "held";
    items: { qty: number; name: string; options: { name: string }[] }[];
  }>(
    `select o.id, o.status,
            coalesce((select json_agg(json_build_object('qty', i.qty, 'name', i.name_snapshot, 'options', i.options) order by i.id)
                        from order_items i where i.venue_id = o.venue_id and i.order_id = o.id), '[]') as items
       from orders o where o.venue_id = $1 and o.session_id = $2 and o.status in ('ringing', 'held')
      order by o.placed_at`,
    [venueId, sessionId],
  );
  // "2 × Margarita · Peach": the line's name with its choices, as the bar and the ticket show it.
  return r.rows.map((o) => ({
    order_id: o.id,
    status: o.status,
    items: o.items
      .map((i) => `${i.qty} × ${[i.name, ...(i.options ?? []).map((x) => x.name)].join(" · ")}`)
      .join(", "),
  }));
}

async function lockedCheck(c: Queryable, venueId: string, checkId: string) {
  const r = await c.query<{
    id: string;
    status: string;
    room_session_id: string | null;
    version: number;
  }>(
    "select id, status, room_session_id, version from checks where venue_id = $1 and id = $2 for update",
    [venueId, checkId],
  );
  const check = r.rows[0];
  if (!check) throw new ApiError("not_found", "no such check");
  return check;
}

async function roomOf(c: Queryable, venueId: string, sessionId: string): Promise<string | null> {
  const r = await c.query<{ room_id: string }>(
    "select room_id from room_sessions where venue_id = $1 and id = $2",
    [venueId, sessionId],
  );
  return r.rows[0]?.room_id ?? null;
}

async function announce(c: Queryable, venueId: string, checkId: string, sessionId: string | null) {
  const roomId = sessionId ? await roomOf(c, venueId, sessionId) : null;
  await emitEvent(c, {
    venueId,
    type: "check.updated",
    entityId: checkId,
    roomId: roomId ?? undefined,
  });
  if (sessionId)
    await emitEvent(c, {
      venueId,
      type: "session.updated",
      entityId: sessionId,
      roomId: roomId ?? undefined,
    });
}

/** Present the check: refused while an order rings or waits; otherwise finalize it and lock ordering. */
export async function presentCheck(
  c: Queryable,
  venueId: string,
  checkId: string,
  input: { userId: string; now: Temporal.Instant; ifMatch?: number },
) {
  const check = await lockedCheck(c, venueId, checkId);
  if (!check.room_session_id)
    throw new ApiError("invalid_request", "only a room's check is presented");
  if (!["open", "reopened"].includes(check.status))
    throw new ApiError("invalid_request", `this check is ${check.status}`);
  const blockers = await openOrders(c, venueId, check.room_session_id);
  if (blockers.length > 0)
    throw new ApiError("orders_open", "an order is still ringing or waiting at the bar", {
      details: { orders: blockers },
    });
  const done = await finalizeCheck(c, venueId, checkId, input);
  await c.query("update checks set status = 'finalized' where venue_id = $1 and id = $2", [
    venueId,
    checkId,
  ]);
  await c.query("update room_sessions set ordering_locked = true where venue_id = $1 and id = $2", [
    venueId,
    check.room_session_id,
  ]);
  await announce(c, venueId, checkId, check.room_session_id);
  return done;
}

/** Reopen (a manager's): ordering opens again, and the next finalize writes the next revision. */
export async function reopenCheck(c: Queryable, venueId: string, checkId: string) {
  const check = await lockedCheck(c, venueId, checkId);
  if (check.status !== "finalized" && check.status !== "partly_paid")
    throw new ApiError("invalid_request", `a ${check.status} check isn't reopened`);
  await c.query(
    "update checks set status = 'reopened', version = version + 1 where venue_id = $1 and id = $2",
    [venueId, checkId],
  );
  if (check.room_session_id)
    await c.query(
      "update room_sessions set ordering_locked = false where venue_id = $1 and id = $2",
      [venueId, check.room_session_id],
    );
  await announce(c, venueId, checkId, check.room_session_id);
}

export interface Settled {
  readonly status: string;
  readonly due_cents: number;
  /** Paid in full and the room released to cleaning, or what holds it. */
  readonly room: {
    readonly released: boolean;
    readonly blocked_by: Blocker[];
    readonly unpaid_checks: string[];
  } | null;
}

/**
 * After money lands on a check: paid in full when nothing is due (with paid_at), partly paid otherwise.
 * A paid room check sends its room to cleaning, unless an order on it is ringing or waiting, or another
 * check on the session isn't paid.
 */
export async function settleCheck(
  c: Queryable,
  venueId: string,
  checkId: string,
  now: Temporal.Instant,
): Promise<Settled> {
  const check = await lockedCheck(c, venueId, checkId);
  // A bar tab's standing hold only guarantees what's left (M6-10): a split share paid beside it leaves the
  // check partly paid until the hold is captured.
  // A room holding the holds of tabs moved into it (M6-13) counts what's paid beside them.
  const moved = (await movedHolds(c, venueId, checkId)).length > 0;
  const due = moved
    ? await amountDueBesideHolds(c, checkId)
    : await amountDue(c, checkId, (await tabHoldOf(c, venueId, checkId))?.paymentId ?? null);
  if (!["finalized", "partly_paid", "reopened", "open"].includes(check.status))
    return { status: check.status, due_cents: due, room: null };
  const status = due === 0 ? "paid" : "partly_paid";
  if (status !== check.status || status === "paid")
    await c.query(
      `update checks set status = $3, paid_at = case when $3 = 'paid' then $4::timestamptz else paid_at end
        where venue_id = $1 and id = $2`,
      [venueId, checkId, status, now.toString()],
    );
  // Settled another way, the moved holds are canceled (Money rules 12).
  if (status === "paid" && moved) await releaseMovedHolds(c, venueId, checkId, now);
  await announce(c, venueId, checkId, check.room_session_id);
  if (status !== "paid" || !check.room_session_id) return { status, due_cents: due, room: null };
  return {
    status,
    due_cents: due,
    room: await releaseRoom(c, venueId, check.room_session_id, now),
  };
}

/** Sends a paid session's room to cleaning, unless something still holds it. */
export async function releaseRoom(
  c: Queryable,
  venueId: string,
  sessionId: string,
  now: Temporal.Instant,
) {
  const blocked_by = await openOrders(c, venueId, sessionId);
  const unpaid = await c.query<{ id: string }>(
    "select id from checks where venue_id = $1 and room_session_id = $2 and status not in ('paid', 'void')",
    [venueId, sessionId],
  );
  const unpaid_checks = unpaid.rows.map((r) => r.id);
  const ended = await c.query<{ ended: boolean }>(
    "select ended_at is not null as ended from room_sessions where venue_id = $1 and id = $2",
    [venueId, sessionId],
  );
  if (blocked_by.length > 0 || unpaid_checks.length > 0 || ended.rows[0]?.ended)
    return { released: false, blocked_by, unpaid_checks };
  await endSession(c, venueId, sessionId, now);
  return { released: true, blocked_by, unpaid_checks };
}

/**
 * Where an accepted order's lines go: its check, or, when that check is already paid, a new check on the
 * same session (rule 6, after payment), which staff settle before the room is released.
 */
export async function checkForAccept(
  c: Queryable,
  venueId: string,
  input: { checkId: string; openedBy: string; now: Temporal.Instant },
): Promise<string> {
  const r = await c.query<{
    status: string;
    room_session_id: string | null;
    booking_id: string | null;
    business_date: string;
    training: boolean;
  }>(
    "select status, room_session_id, booking_id, business_date::text, training from checks where venue_id = $1 and id = $2",
    [venueId, input.checkId],
  );
  const check = r.rows[0];
  if (!check || check.status !== "paid" || !check.room_session_id) return input.checkId;
  const existing = await c.query<{ id: string }>(
    "select id from checks where venue_id = $1 and room_session_id = $2 and status not in ('paid', 'void') order by opened_at desc limit 1",
    [venueId, check.room_session_id],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  // No Stripe call happens in this transaction, so the number is taken here.
  const n = await c.query<{ number: string }>(
    "update venue_counters set next = next + 1 where venue_id = $1 and name = $2 returning next - 1 as number",
    [venueId, check.training ? "check_training" : "check"],
  );
  const id = await insertCheck(c, {
    venueId,
    training: check.training,
    number: Number(n.rows[0]!.number),
    kind: "room",
    businessDate: check.business_date,
    roomSessionId: check.room_session_id,
    bookingId: check.booking_id,
    openedBy: input.openedBy,
    openedAt: input.now.toString(),
  });
  await c.query("update room_sessions set check_id = $3 where venue_id = $1 and id = $2", [
    venueId,
    check.room_session_id,
    id,
  ]);
  return id;
}
