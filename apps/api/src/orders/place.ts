import {
  clearDraft,
  emitEvent,
  basketOrders,
  insertBasket,
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
import { kitchenOn } from "../kitchen/module.js";
import { stepOrder } from "./pipeline.js";
import { alcoholBlock, checkAlcohol, checkGiftAlcohol } from "./alcohol.js";

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
  /** A food line's note for the kitchen, up to 200 characters, and "This is an allergy" (K-04). */
  readonly kitchen_note?: string | null | undefined;
  readonly kitchen_note_allergy?: boolean | undefined;
}

export interface GiftFor {
  readonly singerId: string;
  readonly checkId: string | null;
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
    /** A round a manager OKs later (M6-07, over_hold) left the draft when it was asked for. */
    keepDraft?: boolean;
    /** A gift order (M6-24): the singer it's for and their check, whose cut-off it checks. */
    gift?: GiftFor | null;
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
  // A reopened check takes orders again (M4-08); a presented or paid one doesn't.
  if (ch.status !== "open" && ch.status !== "reopened")
    throw new ApiError("ordering_closed", "this check is closed to new orders");
  if (input.lines.length === 0) throw new ApiError("invalid_request", "nothing to send");

  const items = await orderItemsFor(c, venueId, input.lines, input.now);
  const alcoholItems = items.map((i) => ({ name: i.name, alcohol: i.alcohol }));
  // A gift is checked first against the singer it's for (M6-24): the window, then their tab's or
  // room's cut-off, so the refusal is logged on the check it's about.
  if (input.gift)
    await checkGiftAlcohol(c, venueId, {
      items: alcoholItems,
      giftCheckId: input.gift.checkId,
      refusedBy: input.userId,
      now: input.now,
    });
  // The alcohol window and the room's cut-off (M3-20).
  await checkAlcohol(c, venueId, {
    items: alcoholItems,
    sessionId: ch.room_session_id,
    checkId: input.checkId,
    roomGuestId: null,
    refusedBy: input.userId,
    now: input.now,
  });

  const clock = await venueClock(c, venueId);
  // One order per station, placed together (K-02); each is accepted as it's placed.
  const orderIds = await insertBasket(c, venueId, {
    checkId: input.checkId,
    sessionId: ch.room_session_id,
    source: input.gift ? "gift" : "staff",
    giftForSingerId: input.gift?.singerId ?? null,
    giftForCheckId: input.gift?.checkId ?? null,
    placedBy: input.userId,
    placedAt: input.now.toString(),
    businessDate: businessDate(input.now, clock.timeZone, clock.dayCutover).businessDate.toString(),
    clientOrderId: input.clientOrderId,
    items,
  });
  const placed: OrderRow[] = [];
  for (const orderId of orderIds) {
    await emitEvent(c, { venueId, type: "order.ringing", entityId: orderId, entityVersion: 0 });
    const accepted = await stepOrder(c, venueId, orderId, "accept", {
      userId: input.userId,
      deviceId: input.deviceId,
      now: input.now,
    });
    if (accepted.status !== "done") throw new ApiError("internal", "a staff order wasn't accepted");
    placed.push(accepted.order);
  }
  const first = placed[0]!;
  if (input.keepDraft) return first;
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
  return first;
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
  let kitchen: boolean | undefined;
  for (const line of lines) {
    const v = await orderableVariant(c, venueId, line.variant_id, nowIso);
    if (!v || !v.shown)
      throw new ApiError("invalid_request", "that drink isn't on the menu", {
        details: { reason: "not_on_menu", variant_id: line.variant_id },
      });
    const name = v.variant_count > 1 ? `${v.item_name} · ${v.variant_name}` : v.item_name;
    // With Kitchen & food off, no item routes to the kitchen: food can't be ordered (K-02).
    if (v.station === "kitchen" && !(kitchen ??= await kitchenOn(c, venueId)))
      throw new ApiError("invalid_request", `${name} isn't on the menu`, {
        details: { reason: "kitchen_off", variant_id: v.variant_id },
      });
    // A closed kitchen, or tonight's last order passed, refuses new food (K-07). Alcohol rules
    // don't touch food, and food doesn't change them.
    if (v.kitchen_stop)
      throw new ApiError(
        "invalid_request",
        v.kitchen_stop === "kitchen_closed"
          ? `The kitchen is closed: ${name} can't be ordered now`
          : `The kitchen's last order has passed: ${name} can't be ordered now`,
        { details: { reason: v.kitchen_stop, variant_id: v.variant_id } },
      );
    // A note for the kitchen goes on food only: a drink's ticket never reaches the kitchen.
    if (line.kitchen_note?.trim() && v.station !== "kitchen")
      throw new ApiError(
        "invalid_request",
        `${name} isn't food: a note for the kitchen goes on food`,
        { details: { reason: "kitchen_note_not_food", variant_id: v.variant_id } },
      );
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
      kitchenNote: line.kitchen_note?.trim() ? line.kitchen_note.trim() : null,
      kitchenNoteAllergy: Boolean(line.kitchen_note?.trim()) && line.kitchen_note_allergy === true,
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
    isHost: boolean;
    lines: readonly StaffLine[];
    clientOrderId: string;
    sameAgainOf?: string | null;
    now: Temporal.Instant;
  },
): Promise<OrderRow[]> {
  const seen = await c.query<{ id: string }>(
    "select id from orders where venue_id = $1 and client_order_id = $2",
    [venueId, input.clientOrderId],
  );
  if (seen.rows[0])
    return basketOrders(c, venueId, (await orderById(c, venueId, seen.rows[0].id))!);
  const s = await c.query<{
    check_id: string | null;
    ordering_locked: boolean;
    host_lock: boolean;
    ended: boolean;
  }>(
    `select check_id, ordering_locked, host_lock, ended_at is not null as ended from room_sessions
      where venue_id = $1 and id = $2`,
    [venueId, input.sessionId],
  );
  const session = s.rows[0];
  if (!session || session.ended || !session.check_id)
    throw new ApiError("ordering_closed", "this room isn't taking orders");
  if (session.ordering_locked)
    throw new ApiError("ordering_closed", "your bill is ready · ordering is closed");
  // The host lock (M3-10): friends see the menu, but only the host sends orders.
  if (session.host_lock && !input.isHost)
    throw new ApiError("ordering_closed", "the host has locked ordering", {
      details: { reason: "host_lock" },
    });
  const items = await orderItemsFor(c, venueId, input.lines, input.now);
  // The alcohol window, the room's cut-off and the guest's (M3-20).
  await checkAlcohol(c, venueId, {
    items: items.map((i) => ({ name: i.name, alcohol: i.alcohol })),
    sessionId: input.sessionId,
    checkId: session.check_id,
    roomGuestId: input.roomGuestId,
    refusedBy: null,
    now: input.now,
  });
  const clock = await venueClock(c, venueId);
  // A basket with food and drinks rings as one order per station, placed together (K-02).
  const orderIds = await insertBasket(c, venueId, {
    checkId: session.check_id,
    sessionId: input.sessionId,
    roomGuestId: input.roomGuestId,
    source: "room",
    placedAt: input.now.toString(),
    businessDate: businessDate(input.now, clock.timeZone, clock.dayCutover).businessDate.toString(),
    clientOrderId: input.clientOrderId,
    sameAgainOf: input.sameAgainOf ?? null,
    items,
  });
  const orders: OrderRow[] = [];
  for (const orderId of orderIds) {
    await emitEvent(c, {
      venueId,
      type: "order.ringing",
      entityId: orderId,
      entityVersion: 0,
      roomId: input.roomId,
    });
    orders.push((await orderById(c, venueId, orderId))!);
  }
  return orders;
}

export interface AgainRound {
  readonly order_id: string;
  readonly delivered_at: string | null;
  readonly lines: readonly (StaffLine & {
    name: string;
    options: readonly string[];
    unit_cents: number;
  })[];
  readonly total_cents: number;
  /** What the round had that can't be ordered again tonight, and why. */
  readonly left_out: readonly {
    name: string;
    reason: "out_tonight" | "not_on_menu" | "window_closed" | "cut_off";
  }[];
}

/**
 * Same again (M3-11; screens N7): a session's delivered rounds, newest first, priced from today's
 * menu, each choice matched by its group and name, leaving out anything 86'd or off the menu and
 * saying so. The alcohol window and cut-offs leave items out here too from M3-20 and M3-21.
 */
export async function sameAgainRounds(
  c: Queryable,
  venueId: string,
  sessionId: string,
  now: Temporal.Instant,
  roomGuestId: string | null = null,
  /** The list leaves refused alcohol out; ordering a round keeps it, so the order is refused and logged. */
  hideRefused = true,
): Promise<AgainRound[]> {
  // Alcohol outside the window, or for a cut-off room or guest, is left out too (M3-20).
  const block = hideRefused
    ? await alcoholBlock(c, venueId, { sessionId, roomGuestId }, now)
    : null;
  const delivered = await c.query<{ id: string }>(
    `select id from orders where venue_id = $1 and session_id = $2 and status = 'delivered'
      order by delivered_at desc nulls last, placed_at desc limit 10`,
    [venueId, sessionId],
  );
  const nowIso = new Date(now.epochMilliseconds).toISOString();
  const rounds: AgainRound[] = [];
  for (const { id } of delivered.rows) {
    const order = (await orderById(c, venueId, id))!;
    const lines: AgainRound["lines"][number][] = [];
    const leftOut: AgainRound["left_out"][number][] = [];
    for (const item of order.items) {
      const v = item.variant_id
        ? await orderableVariant(c, venueId, item.variant_id, nowIso)
        : null;
      if (!v || !v.shown) {
        leftOut.push({ name: item.name_snapshot, reason: "not_on_menu" });
        continue;
      }
      const optionIds: string[] = [];
      let missing = false;
      let out = v.out_tonight || v.kitchen_stop !== null;
      let extra = 0;
      for (const o of item.options) {
        const match = v.groups
          .find((g) => g.name === o.group)
          ?.options.find((x) => x.name === o.name);
        if (!match) missing = true;
        else {
          optionIds.push(match.id);
          extra += match.price_delta_cents;
          out ||= match.out_tonight;
        }
      }
      const name = v.variant_count > 1 ? `${v.item_name} · ${v.variant_name}` : v.item_name;
      const full = [name, ...item.options.map((o) => o.name)].join(" · ");
      if (missing) leftOut.push({ name: full, reason: "not_on_menu" });
      else if (v.alcohol && block) leftOut.push({ name: full, reason: block });
      else if (out) leftOut.push({ name: full, reason: "out_tonight" });
      else
        lines.push({
          variant_id: v.variant_id,
          qty: item.qty,
          option_ids: optionIds,
          name,
          options: item.options.map((o) => o.name),
          unit_cents: v.price_cents + extra,
        });
    }
    if (lines.length === 0) continue;
    rounds.push({
      order_id: order.id,
      delivered_at: order.delivered_at,
      lines,
      total_cents: lines.reduce((s, l) => s + l.unit_cents * l.qty, 0),
      left_out: leftOut,
    });
  }
  return rounds;
}
