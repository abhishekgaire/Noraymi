import {
  clearDraft,
  emitEvent,
  insertOrder,
  orderById,
  type NewOrder,
  orderableVariant,
  type OrderRow,
  type Queryable,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { stepOrder } from "./pipeline.js";

/**
 * A staff order (M3-07; spec 10 · Adding drinks to a room from a staff
 * screen): drinks rung on a room's tab from DeskRoom, the Room phone (and
 * the bar POS in M6). Each line is checked against the menu as it is now:
 * on the menu, not 86'd, every required choice made. The price, name,
 * alcohol flag, tax category and station are copied onto the order, which
 * is accepted as it's placed by the person who rang it, so its lines go on
 * the check and a ticket prints at the bar. The person's draft for the tab
 * empties. The alcohol window and the cut-offs are checked here in M3-20.
 */
export interface StaffLine {
  readonly variant_id: string;
  readonly qty: number;
  readonly option_ids?: readonly string[] | undefined;
  readonly notes?: string | null | undefined;
}

export async function placeStaffOrder(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    lines: readonly StaffLine[];
    clientOrderId: string | null;
    userId: string;
    membershipId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<OrderRow> {
  // A retried send with the same client_order_id answers the order it made the first time.
  if (input.clientOrderId) {
    const seen = await c.query<{ id: string }>(
      "select id from orders where venue_id = $1 and client_order_id = $2",
      [venueId, input.clientOrderId],
    );
    if (seen.rows[0]) return (await orderById(c, venueId, seen.rows[0].id))!;
  }
  const check = await c.query<{ status: string; room_session_id: string | null }>(
    "select status, room_session_id from checks where venue_id = $1 and id = $2",
    [venueId, input.checkId],
  );
  const ch = check.rows[0];
  if (!ch) throw new ApiError("not_found", "no such check");
  if (ch.status !== "open")
    throw new ApiError("ordering_closed", "this check is closed to new orders");
  if (input.lines.length === 0) throw new ApiError("invalid_request", "nothing to send");

  const items = await orderItemsFor(c, venueId, input.lines, input.now);

  const clock = await venueClock(c, venueId);
  const orderId = await insertOrder(c, venueId, {
    checkId: input.checkId,
    sessionId: ch.room_session_id,
    source: "staff",
    placedBy: input.userId,
    placedAt: input.now.toString(),
    businessDate: businessDate(input.now, clock.timeZone, clock.dayCutover).businessDate.toString(),
    clientOrderId: input.clientOrderId,
    items,
  });
  await emitEvent(c, { venueId, type: "order.ringing", entityId: orderId, entityVersion: 0 });
  const accepted = await stepOrder(c, venueId, orderId, "accept", {
    userId: input.userId,
    deviceId: input.deviceId,
    now: input.now,
  });
  if (accepted.status !== "done") throw new ApiError("internal", "a staff order wasn't accepted");
  const version = await clearDraft(
    c,
    venueId,
    input.membershipId,
    input.checkId,
    input.now.toString(),
  );
  if (version !== null)
    await emitEvent(c, {
      venueId,
      type: "draft.updated",
      entityId: input.checkId,
      entityVersion: version,
      audience: "user",
      userId: input.userId,
    });
  return accepted.order;
}

/**
 * Each line checked against the menu as it is now (shown, not 86'd, every required choice made,
 * no more than a group allows) and priced from it: the order's items, with the price, name,
 * alcohol flag, tax category and station copied. Shared by staff orders and guests' orders.
 */
export async function orderItemsFor(
  c: Queryable,
  venueId: string,
  lines: readonly StaffLine[],
  now: Temporal.Instant,
): Promise<NewOrder["items"][number][]> {
  const nowIso = new Date(now.epochMilliseconds).toISOString();
  const items = [];
  for (const line of lines) {
    const v = await orderableVariant(c, venueId, line.variant_id, nowIso);
    if (!v || !v.shown)
      throw new ApiError("invalid_request", "that drink isn't on the menu", {
        details: { reason: "not_on_menu", variant_id: line.variant_id },
      });
    const name = v.variant_count > 1 ? `${v.item_name} · ${v.variant_name}` : v.item_name;
    if (v.out_tonight)
      throw new ApiError("invalid_request", `${name} is 86'd tonight`, {
        details: { reason: "out_tonight", variant_id: v.variant_id },
      });
    const chosen = [...new Set(line.option_ids ?? [])];
    const options: { group: string; name: string; price_delta_cents: number }[] = [];
    for (const optionId of chosen) {
      const group = v.groups.find((g) => g.options.some((o) => o.id === optionId));
      if (!group)
        throw new ApiError("invalid_request", `that choice isn't one of ${name}'s`, {
          details: { reason: "not_a_choice", option_id: optionId },
        });
      const option = group.options.find((o) => o.id === optionId)!;
      if (option.out_tonight)
        throw new ApiError("invalid_request", `${name} · ${option.name} is 86'd tonight`, {
          details: { reason: "out_tonight", option_id: optionId },
        });
      options.push({
        group: group.name,
        name: option.name,
        price_delta_cents: option.price_delta_cents,
      });
    }
    for (const g of v.groups) {
      const picked = g.options.filter((o) => chosen.includes(o.id)).length;
      const least = Math.max(g.min_choices, g.required ? 1 : 0);
      if (picked < least)
        throw new ApiError("invalid_request", `Pick ${g.name.toLowerCase()} for ${name}`, {
          details: { reason: "choice_missing", variant_id: v.variant_id, group: g.name },
        });
      if (picked > g.max_choices)
        throw new ApiError(
          "invalid_request",
          `${name} takes at most ${g.max_choices} ${g.name.toLowerCase()}`,
          {
            details: { reason: "too_many_choices", group: g.name },
          },
        );
    }
    items.push({
      variantId: v.variant_id,
      itemId: v.item_id,
      options,
      qty: line.qty,
      unitCents: v.price_cents,
      name,
      alcohol: v.alcohol,
      taxCategory: v.tax_category,
      station: v.station,
      notes: line.notes?.trim() ? line.notes.trim() : null,
    });
  }

  return items;
}

/**
 * A guest's order from the room page (M3-09): it rings at the bar and waits for Accept, which is
 * the sale. A retry with the same client_order_id answers the order it made the first time. A check
 * that's presented (ordering locked) answers 409 ordering_closed; the host lock, the alcohol window
 * and the cut-offs are checked here in M3-10 and M3-20.
 */
export async function placeRoomOrder(
  c: Queryable,
  venueId: string,
  input: {
    sessionId: string;
    roomGuestId: string;
    roomId: string;
    lines: readonly StaffLine[];
    clientOrderId: string;
    now: Temporal.Instant;
  },
): Promise<OrderRow> {
  const seen = await c.query<{ id: string }>(
    "select id from orders where venue_id = $1 and client_order_id = $2",
    [venueId, input.clientOrderId],
  );
  if (seen.rows[0]) return (await orderById(c, venueId, seen.rows[0].id))!;
  const s = await c.query<{ check_id: string | null; ordering_locked: boolean; ended: boolean }>(
    `select check_id, ordering_locked, ended_at is not null as ended from room_sessions
      where venue_id = $1 and id = $2`,
    [venueId, input.sessionId],
  );
  const session = s.rows[0];
  if (!session || session.ended || !session.check_id)
    throw new ApiError("ordering_closed", "this room isn't taking orders");
  if (session.ordering_locked)
    throw new ApiError("ordering_closed", "your bill is ready · ordering is closed");
  const items = await orderItemsFor(c, venueId, input.lines, input.now);
  const clock = await venueClock(c, venueId);
  const orderId = await insertOrder(c, venueId, {
    checkId: session.check_id,
    sessionId: input.sessionId,
    roomGuestId: input.roomGuestId,
    source: "room",
    placedAt: input.now.toString(),
    businessDate: businessDate(input.now, clock.timeZone, clock.dayCutover).businessDate.toString(),
    clientOrderId: input.clientOrderId,
    items,
  });
  await emitEvent(c, {
    venueId,
    type: "order.ringing",
    entityId: orderId,
    entityVersion: 0,
    roomId: input.roomId,
  });
  return (await orderById(c, venueId, orderId))!;
}
