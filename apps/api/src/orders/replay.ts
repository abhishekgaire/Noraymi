import { emitEvent, insertBasket, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { checkAlcohol } from "./alcohol.js";
import { orderItemsFor } from "./place.js";

/**
 * The replay of queued orders (M8-05; spec 09 · Replay). The bar computer
 * queued each round in an outage with an order id it made itself; on
 * reconnect it uploads them, and the server checks each one again as if it
 * were rung now: the night is still the one it was queued on, the tab or room
 * is still open, its check isn't finalized or paid, every drink is still on
 * the menu and not 86'd, and the alcohol window and cut-offs allow it. A round
 * that passes lands as a held order (source offline) that stays off the tab
 * until a bartender accepts it, which is the sale; one that fails is kept for
 * Review after outage with its reason. Either way the order id is answered
 * the same every time after, so the same queue uploaded twice lands once.
 */
export interface QueuedRound {
  readonly order_id: string;
  readonly queued_at: string;
  readonly tab_id: string;
  readonly check_id: string;
  readonly tab_name: string;
  readonly staff: { readonly membership_id: string; readonly name: string };
  readonly lines: readonly {
    readonly variant_id: string;
    readonly name: string;
    readonly qty: number;
    readonly unit_cents: number;
    readonly alcohol: boolean;
  }[];
  readonly cash_note: string | null;
}

export const REPLAY_REASONS = [
  "earlier_night",
  "no_check",
  "tab_closed",
  "check_paid",
  "check_closed",
  "alcohol_closed",
  "cut_off",
  "not_on_menu",
  "out_tonight",
] as const;
export type ReplayReason = (typeof REPLAY_REASONS)[number];

export interface ReplayAnswer {
  readonly order_id: string;
  readonly outcome: "held" | "failed";
  readonly reason: ReplayReason | null;
}

/** A refusal the replay records instead of throwing. */
export class ReplayRefused extends Error {
  constructor(readonly reason: ReplayReason) {
    super(reason);
  }
}

/** The answer already given for this order id, if it reached us before. */
export async function replayedBefore(
  c: Queryable,
  venueId: string,
  orderId: string,
): Promise<ReplayAnswer | null> {
  const r = await c.query<{ outcome: "held" | "failed"; reason: ReplayReason | null }>(
    "select outcome, reason from offline_replays where venue_id = $1 and client_order_id = $2",
    [venueId, orderId],
  );
  const row = r.rows[0];
  return row ? { order_id: orderId, outcome: row.outcome, reason: row.reason } : null;
}

/** What an API refusal from the menu or alcohol checks means for a replay. */
export function reasonOf(e: unknown): ReplayReason | null {
  if (e instanceof ReplayRefused) return e.reason;
  if (!(e instanceof ApiError)) return null;
  if (e.code === "alcohol_closed") return "alcohol_closed";
  if (e.code === "cut_off") return "cut_off";
  const detail = (e.details as { reason?: string } | undefined)?.reason;
  // A closed kitchen or a passed last order (K-07) reads like an 86: out for tonight.
  if (
    e.code === "invalid_request" &&
    (detail === "out_tonight" || detail === "kitchen_closed" || detail === "last_order")
  )
    return "out_tonight";
  if (e.code === "invalid_request") return "not_on_menu";
  return null;
}

const totalOf = (round: QueuedRound) =>
  round.lines.reduce((sum, l) => sum + l.qty * l.unit_cents, 0);

async function nightOf(c: Queryable, venueId: string, at: Temporal.Instant): Promise<string> {
  const clock = await venueClock(c, venueId);
  return businessDate(at, clock.timeZone, clock.dayCutover).businessDate.toString();
}

/** The person who rang it, when they are a member of this venue. */
async function ringerOf(c: Queryable, venueId: string, membershipId: string) {
  const r = await c.query<{ user_id: string }>(
    "select user_id from memberships where venue_id = $1 and id::text = $2",
    [venueId, membershipId],
  );
  return r.rows[0]?.user_id ?? null;
}

async function record(
  c: Queryable,
  venueId: string,
  round: QueuedRound,
  input: {
    deviceId: string | null;
    now: Temporal.Instant;
    outcome: "held" | "failed";
    reason: ReplayReason | null;
    orderId: string | null;
  },
): Promise<void> {
  const queuedAt = Temporal.Instant.from(round.queued_at);
  await c.query(
    `insert into offline_replays (venue_id, client_order_id, device_id, queued_on, replayed_on, queued_at,
       replayed_at, check_id, tab_name, staff_membership_id, staff_name, lines, total_cents, cash_note,
       outcome, reason, order_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
       (select id from memberships where venue_id = $1 and id::text = $10), $11, $12, $13, $14, $15, $16, $17)`,
    [
      venueId,
      round.order_id,
      input.deviceId,
      await nightOf(c, venueId, queuedAt),
      await nightOf(c, venueId, input.now),
      round.queued_at,
      input.now.toString(),
      round.check_id,
      round.tab_name,
      round.staff.membership_id,
      round.staff.name,
      JSON.stringify(round.lines),
      totalOf(round),
      round.cash_note,
      input.outcome,
      input.reason,
      input.orderId,
    ],
  );
}

/**
 * One round checked again and landed as held. Throws ReplayRefused (or the
 * menu's and alcohol's own refusals) when it fails; the caller records those.
 */
export async function replayRound(
  c: Queryable,
  venueId: string,
  round: QueuedRound,
  input: { deviceId: string | null; now: Temporal.Instant },
): Promise<ReplayAnswer> {
  // Never onto an earlier night: a round queued before the 6:00 AM cutover waits for a manager.
  if (
    (await nightOf(c, venueId, Temporal.Instant.from(round.queued_at))) !==
    (await nightOf(c, venueId, input.now))
  )
    throw new ReplayRefused("earlier_night");
  const k = await c.query<{ status: string; room_session_id: string | null }>(
    "select status, room_session_id from checks where venue_id = $1 and id = $2",
    [venueId, round.check_id],
  );
  const check = k.rows[0];
  if (!check) throw new ReplayRefused("no_check");
  // Never onto a paid check, nor one that's finalized or presented for payment.
  if (check.status === "paid" || check.status === "partly_paid")
    throw new ReplayRefused("check_paid");
  if (check.status !== "open" && check.status !== "reopened")
    throw new ReplayRefused("check_closed");
  // The tab or the room is still open.
  if (check.room_session_id) {
    const s = await c.query<{ ended: boolean; locked: boolean }>(
      `select ended_at is not null as ended, ordering_locked as locked from room_sessions
        where venue_id = $1 and id = $2`,
      [venueId, check.room_session_id],
    );
    if (!s.rows[0] || s.rows[0].ended) throw new ReplayRefused("tab_closed");
    if (s.rows[0].locked) throw new ReplayRefused("check_closed");
  } else {
    const t = await c.query<{ state: string }>(
      "select state from tabs where venue_id = $1 and check_id = $2",
      [venueId, round.check_id],
    );
    if (!t.rows[0] || t.rows[0].state !== "open") throw new ReplayRefused("tab_closed");
  }
  const items = await orderItemsFor(
    c,
    venueId,
    round.lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })),
    input.now,
  );
  const placedBy = await ringerOf(c, venueId, round.staff.membership_id);
  await checkAlcohol(c, venueId, {
    items: items.map((i) => ({ name: i.name, alcohol: i.alcohol })),
    sessionId: check.room_session_id,
    checkId: round.check_id,
    roomGuestId: null,
    refusedBy: placedBy,
    now: input.now,
  });
  // A round with food and drinks is one order per station (K-02); the first carries the round's id.
  const orderIds = await insertBasket(c, venueId, {
    checkId: round.check_id,
    sessionId: check.room_session_id,
    source: "offline",
    placedBy,
    placedAt: round.queued_at,
    businessDate: await nightOf(c, venueId, Temporal.Instant.from(round.queued_at)),
    clientOrderId: round.order_id,
    items,
  });
  // Asked to wait: off the tab until a bartender accepts it against the tab.
  for (const orderId of orderIds)
    await c.query(
      "update orders set status = 'held', held_at = $3 where venue_id = $1 and id = $2",
      [venueId, orderId, input.now.toString()],
    );
  await record(c, venueId, round, {
    ...input,
    outcome: "held",
    reason: null,
    orderId: orderIds[0]!,
  });
  for (const orderId of orderIds)
    await emitEvent(c, { venueId, type: "order.held", entityId: orderId, entityVersion: 0 });
  return { order_id: round.order_id, outcome: "held", reason: null };
}

/** A round that failed the checks, kept for Review after outage. */
export async function recordFailed(
  c: Queryable,
  venueId: string,
  round: QueuedRound,
  input: { deviceId: string | null; now: Temporal.Instant; reason: ReplayReason },
): Promise<ReplayAnswer> {
  await record(c, venueId, round, {
    deviceId: input.deviceId,
    now: input.now,
    outcome: "failed",
    reason: input.reason,
    orderId: null,
  });
  await emitEvent(c, {
    venueId,
    type: "offline.replay_failed",
    entityId: round.check_id,
    entityVersion: 0,
  });
  return { order_id: round.order_id, outcome: "failed", reason: input.reason };
}
