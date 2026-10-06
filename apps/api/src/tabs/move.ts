import { addCheckLine, allocate, emitEvent, enqueue, openSplit, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { requestApproval, type PendingAnswer } from "../approvals/service.js";
import { AlcoholRefused, alcoholNow } from "../orders/alcohol.js";
import { savedCardFor } from "../payments/card-on-file.js";
import { tabHoldOf } from "../payments/splits.js";
import { venueClock } from "../rooms/assignment.js";
import { holdCardOf, tabOfCheck, withinHold, type TabHold } from "./hold.js";
import { TAB_CANCEL_HOLD_KIND } from "./pay.js";
import { moveTab } from "./state.js";

/**
 * Moving a tab into a room, and moving lines between tabs (M6-13; Payment flows · Moving a tab into a
 * room; Money rules 5, 9 and 12; spec 10 · Move tab to a room, Changing a sent drink):
 *  - every line moves as a transfer, in the caller's one transaction: a `transfer_out` line on the check
 *    it leaves (pointing at the line, so it's no longer on it) and a `transfer_in` line on the check it
 *    joins, each naming the other check (`moved_check_id`), so the room's check reads "Moved from Jess
 *    P.'s bar tab" and the tab "Moved to Room 9". Moved drinks are items of the room's check, so they
 *    carry its gratuity and its tax like any drink there.
 *  - a move runs the same checks as a send: alcohol can't move onto a cut-off room or tab, or once the
 *    alcohol window has closed (`409 cut_off` or `409 alcohol_closed`, with the cut-off's reason, logged
 *    in `alcohol_refusals` by the route), and a line moved onto a tab with a hold runs its hold check
 *    (M6-07's `withinHold`): a raise first, a declined raise waits for a manager like a round.
 *  - the tab moved into a room closes ("Moved to Room 9", `moved_to_check_id`). Its hold is canceled at
 *    once when the room has a payment method (the booking's saved card, or a card tapped for the room);
 *    until then its allocation follows the moved lines onto the room's check, up to the hold.
 * A room's own hold (`pay.roomHold`) is off at West 4 and in no milestone, so no room hold is raised.
 */
const MOVABLE = ["item", "song", "transfer_in"];

export interface MovableLine {
  readonly id: number;
  readonly kind: string;
  readonly description: string;
  /** What's left of the line after comps, voids and earlier moves. */
  readonly qty: number;
  readonly unit_cents: number;
  readonly tax_category: string | null;
  readonly business_date: string;
  readonly alcohol: boolean;
}

/**
 * A check's lines that can still move, with what's left of each, and whether each is alcohol: the
 * order's flag, or the menu's for drinks put on without an order (the seed's tabs), or, failing both, a
 * drink counts as alcohol (the cautious reading).
 */
export async function movableLines(
  c: Queryable,
  venueId: string,
  checkId: string,
  lineId: number | null = null,
): Promise<MovableLine[]> {
  const r = await c.query<{
    id: string;
    kind: string;
    description: string;
    qty: string;
    unit_cents: string;
    tax_category: string | null;
    business_date: string;
    alcohol: boolean;
  }>(
    `select l.id, l.kind, l.description, l.unit_cents, l.tax_category, l.business_date::text,
            l.qty - coalesce((select sum(x.qty) from check_lines x
                               where x.venue_id = l.venue_id and x.reverses_id = l.id), 0) as qty,
            coalesce(oi.alcohol,
                     (select bool_or(m.alcohol) from menu_items m
                       where m.venue_id = l.venue_id
                         and (m.name = l.description or l.description like m.name || ' · %')),
                     l.tax_category = 'drink') as alcohol
       from check_lines l
       left join order_items oi on oi.venue_id = l.venue_id and oi.id = l.source_id
      where l.venue_id = $1 and l.check_id = $2 and l.reverses_id is null and l.kind = any($3)
        and l.amount_cents > 0 and ($4::bigint is null or l.id = $4)
      order by l.id`,
    [venueId, checkId, MOVABLE, lineId],
  );
  return r.rows
    .map((l) => ({
      id: Number(l.id),
      kind: l.kind,
      description: l.description,
      qty: Number(l.qty),
      unit_cents: Number(l.unit_cents),
      tax_category: l.tax_category,
      business_date: l.business_date,
      alcohol: l.alcohol,
    }))
    .filter((l) => l.qty > 0);
}

/** One line moved: out of one check, into another, each naming the other. Answers the new line's id. */
async function transfer(
  c: Queryable,
  venueId: string,
  line: MovableLine,
  qty: number,
  move: {
    fromCheckId: string;
    toCheckId: string;
    /** The records' words, in English like every line's description; screens build their own. */
    outReason: string;
    inReason: string;
    by: string;
    approvedBy: string | null;
    at: Temporal.Instant;
  },
): Promise<number> {
  const common = {
    description: line.description,
    qty,
    taxCategory: line.tax_category,
    // A moved drink was sold when it was rung; the move doesn't sell it again.
    businessDate: line.business_date,
    addedBy: move.by,
    approvedBy: move.approvedBy,
    addedAt: move.at.toString(),
  };
  await addCheckLine(c, venueId, move.fromCheckId, {
    ...common,
    kind: "transfer_out",
    unitCents: -line.unit_cents,
    amountCents: -line.unit_cents * qty,
    reversesId: line.id,
    reason: move.outReason,
    movedCheckId: move.toCheckId,
  });
  return addCheckLine(c, venueId, move.toCheckId, {
    ...common,
    kind: "transfer_in",
    unitCents: line.unit_cents,
    amountCents: line.unit_cents * qty,
    reason: move.inReason,
    movedCheckId: move.fromCheckId,
  });
}

/** "Jess P.'s bar tab", as the room's check names where its drinks came from. */
const barTab = (name: string) => `${name}'s bar tab`;

interface CutOff {
  readonly at: string | null;
  readonly by: string | null;
  readonly reason: string | null;
}

/** Refuses alcohol that may not go where it's moving: the window, then the cut-off, with its reason. */
async function refuseAlcohol(
  c: Queryable,
  venueId: string,
  lines: readonly MovableLine[],
  to: {
    checkId: string;
    sessionId: string | null;
    cutOff: CutOff | null;
    by: string;
    now: Temporal.Instant;
  },
) {
  const alcohol = lines.filter((l) => l.alcohol);
  if (alcohol.length === 0) return;
  const closed = (await alcoholNow(c, venueId, to.now)).state === "closed";
  if (!closed && !to.cutOff) return;
  const v = await venueClock(c, venueId);
  throw new AlcoholRefused(
    {
      reason: closed ? "window_closed" : "cut_off",
      sessionId: to.sessionId,
      checkId: to.checkId,
      roomGuestId: null,
      orderId: null,
      refusedBy: to.by,
      items: alcohol.map((l) => l.description),
      at: to.now.toString(),
      businessDate: businessDate(to.now, v.timeZone, v.dayCutover).businessDate.toString(),
    },
    !closed && to.cutOff ? { cut_off: to.cutOff } : {},
  );
}

/** Whether a room has a payment method: the booking's saved card, or a card tapped for it. */
export async function roomHasCard(c: Queryable, venueId: string, checkId: string) {
  if (await savedCardFor(c, venueId, checkId)) return true;
  const r = await c.query(
    "select 1 from check_cards where venue_id = $1 and check_id = $2 and state = 'saved'",
    [venueId, checkId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The holds of tabs moved into a room that still stand as its guarantee, with each tab's name. */
export async function movedHolds(c: Queryable, venueId: string, checkId: string) {
  const r = await c.query<{
    allocation_id: string;
    payment_id: string;
    tab_id: string;
    name: string;
    hold_cents: number;
  }>(
    `select a.id as allocation_id, a.payment_id, t.id as tab_id, t.name, t.hold_cents
       from payment_allocations a
       join tabs t on t.venue_id = a.venue_id and t.payment_id = a.payment_id
      where a.venue_id = $1 and a.check_id = $2 and a.state = 'in_progress' and a.follows_lines
        and t.check_id <> a.check_id
      order by a.created_at, a.id`,
    [venueId, checkId],
  );
  return r.rows;
}

/**
 * Once a room has a payment method, or is settled another way (Money rules 12): the holds of tabs moved
 * into it are released from its check and canceled, each by a job run outside the transaction.
 */
export async function releaseMovedHolds(
  c: Queryable,
  venueId: string,
  checkId: string,
  now: Temporal.Instant,
): Promise<string[]> {
  const holds = await movedHolds(c, venueId, checkId);
  for (const h of holds) {
    await c.query(
      "update payment_allocations set state = 'released' where venue_id = $1 and id = $2",
      [venueId, h.allocation_id],
    );
    await cancelHoldSoon(c, venueId, h.payment_id, now);
    await emitEvent(c, { venueId, type: "tab.updated", entityId: h.tab_id });
  }
  if (holds.length)
    await emitEvent(c, { venueId, type: "check.updated", entityId: checkId, entityVersion: 0 });
  return holds.map((h) => h.payment_id);
}

const cancelHoldSoon = (c: Queryable, venueId: string, paymentId: string, now: Temporal.Instant) =>
  enqueue(c, {
    venueId,
    kind: TAB_CANCEL_HOLD_KIND,
    pool: "critical",
    dedupeKey: `${TAB_CANCEL_HOLD_KIND}:${paymentId}`,
    payload: { payment_id: paymentId },
    runAt: now,
    maxAttempts: 5,
  });

/** A tab that can move: open, not being paid, split or partly paid, and no raise being checked. */
async function movableTab(c: Queryable, venueId: string, tab: TabHold) {
  if (tab.state !== "open")
    throw new ApiError("invalid_request", "only an open tab moves", {
      details: { reason: "tab_state", state: tab.state },
    });
  const check = await c.query<{ status: string }>(
    "select status from checks where venue_id = $1 and id = $2 for update",
    [venueId, tab.check_id],
  );
  if (!["open", "reopened"].includes(check.rows[0]?.status ?? ""))
    throw new ApiError("in_progress", "this tab is being paid", {
      details: { reason: "tab_paying" },
    });
  if (await openSplit(c, venueId, tab.check_id))
    throw new ApiError("invalid_request", "this tab is split: stop splitting first", {
      details: { reason: "tab_split" },
    });
  const paid = await c.query(
    `select 1 from payment_allocations where venue_id = $1 and check_id = $2
        and state in ('captured', 'in_progress') and payment_id is distinct from $3`,
    [venueId, tab.check_id, tab.payment_id],
  );
  if (paid.rowCount)
    throw new ApiError("invalid_request", "something is already paid on this tab", {
      details: { reason: "tab_partly_paid" },
    });
}

export interface MoveToRoomInput {
  readonly tabId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly now: Temporal.Instant;
}

export interface MovedToRoom {
  readonly tab_id: string;
  readonly room_check_id: string;
  readonly room: string;
  readonly lines: number;
  /** released: the room has a card, so the hold is being canceled; kept: it guarantees the room. */
  readonly hold: "released" | "kept" | "none";
}

/** Move tab to a room (`POST /tabs/{t}/move-to-room`). One transaction: the caller's. */
export async function moveTabToRoom(
  c: Queryable,
  venueId: string,
  input: MoveToRoomInput,
): Promise<MovedToRoom> {
  const found = await c.query<{ check_id: string }>(
    "select check_id from tabs where venue_id = $1 and id = $2",
    [venueId, input.tabId],
  );
  if (!found.rows[0]) throw new ApiError("not_found", "no such tab");
  const tab = (await tabOfCheck(c, venueId, found.rows[0].check_id, true))!;
  await movableTab(c, venueId, tab);
  const last = tab.payment_id
    ? await c.query<{ action: string; state: string }>(
        `select action, state from payment_attempts where venue_id = $1 and payment_id = $2
          order by attempt_no desc limit 1`,
        [venueId, tab.payment_id],
      )
    : null;
  if (last?.rows[0]?.action === "increment" && ["started", "unknown"].includes(last.rows[0].state))
    throw new ApiError("payment_unknown", "Checking with Stripe · don't retry", {
      details: { reason: "hold_checking", payment_id: tab.payment_id },
    });

  // The room: in use (its session open, with a check that still takes orders).
  const room = (
    await c.query<{
      check_id: string | null;
      ended: boolean;
      name: string;
      cut_at: string | null;
      cut_by: string | null;
      cut_reason: string | null;
    }>(
      `select s.check_id, s.ended_at is not null as ended, r.name,
              to_json(s.alcohol_cut_off_at) #>> '{}' as cut_at, split_part(u.name, ' ', 1) as cut_by,
              s.alcohol_cut_off_reason as cut_reason
         from room_sessions s
         join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
         left join users u on u.id = s.alcohol_cut_off_by
        where s.venue_id = $1 and s.id = $2`,
      [venueId, input.sessionId],
    )
  ).rows[0];
  if (!room) throw new ApiError("not_found", "no such room session");
  if (room.ended || !room.check_id)
    throw new ApiError("invalid_request", "this room isn't in use", {
      details: { reason: "room_not_in_use" },
    });
  const roomCheck = (
    await c.query<{ status: string }>(
      "select status from checks where venue_id = $1 and id = $2 for update",
      [venueId, room.check_id],
    )
  ).rows[0];
  if (!roomCheck || !["open", "reopened"].includes(roomCheck.status))
    throw new ApiError("ordering_closed", "this room's check is closed to new orders");

  const lines = await movableLines(c, venueId, tab.check_id);
  // The same checks as a send. Spec gap: a tab with some alcohol onto a cut-off room isn't spelled out;
  // the cautious default refuses the whole move, with the cut-off's reason.
  await refuseAlcohol(c, venueId, lines, {
    checkId: room.check_id,
    sessionId: input.sessionId,
    cutOff: room.cut_at ? { at: room.cut_at, by: room.cut_by, reason: room.cut_reason } : null,
    by: input.userId,
    now: input.now,
  });

  for (const l of lines)
    await transfer(c, venueId, l, l.qty, {
      fromCheckId: tab.check_id,
      toCheckId: room.check_id,
      outReason: `Moved to ${room.name}`,
      inReason: `Moved from ${barTab(tab.name)}`,
      by: input.userId,
      approvedBy: null,
      at: input.now,
    });

  // The hold: canceled once the room has a payment method; until then it follows the lines there.
  let hold: MovedToRoom["hold"] = "none";
  const held = await tabHoldOf(c, venueId, tab.check_id);
  if (held) {
    const alloc = (
      await c.query<{ id: string; amount_cents: string }>(
        `select id, amount_cents from payment_allocations where venue_id = $1 and check_id = $2
            and payment_id = $3 and state = 'in_progress'`,
        [venueId, tab.check_id, held.paymentId],
      )
    ).rows;
    for (const a of alloc)
      await c.query(
        "update payment_allocations set state = 'released' where venue_id = $1 and id = $2",
        [venueId, a.id],
      );
    if (await roomHasCard(c, venueId, room.check_id)) {
      await cancelHoldSoon(c, venueId, held.paymentId, input.now);
      hold = "released";
    } else {
      await allocate(c, venueId, {
        paymentId: held.paymentId,
        checkId: room.check_id,
        amountCents: tab.hold_cents,
        state: "in_progress",
        followsLines: true,
      });
      hold = "kept";
    }
  }

  await moveTab(c, venueId, tab.tab_id, "closed");
  await c.query(
    `update tabs set moved_to_check_id = $3, closed_at = $4, closed_by = $5, hold_declined_at = null
      where venue_id = $1 and id = $2`,
    [venueId, tab.tab_id, room.check_id, input.now.toString(), input.userId],
  );
  // Its check owes nothing now: every line moved, so it's settled at $0 and takes no more orders.
  await c.query("update checks set status = 'paid', paid_at = $3 where venue_id = $1 and id = $2", [
    venueId,
    tab.check_id,
    input.now.toString(),
  ]);
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.tab_id });
  for (const check of [tab.check_id, room.check_id])
    await emitEvent(c, { venueId, type: "check.updated", entityId: check, entityVersion: 0 });
  return {
    tab_id: tab.tab_id,
    room_check_id: room.check_id,
    room: room.name,
    lines: lines.length,
    hold,
  };
}

export interface MoveLineInput {
  readonly checkId: string;
  readonly lineId: number;
  readonly toTabId: string;
  readonly qty: number | null;
  readonly userId: string;
  readonly deviceId: string | null;
  readonly now: Temporal.Instant;
  readonly raised?: boolean;
}

export type MoveLineAnswer =
  | { readonly kind: "moved"; readonly lineId: number; readonly toCheckId: string }
  | { readonly kind: "approval"; readonly pending: PendingAnswer }
  | { readonly kind: "raise"; readonly paymentId: string; readonly attemptNo: number }
  | { readonly kind: "checking"; readonly paymentId: string };

/** What a line move would do, checked again when a manager approves one. */
async function lineMovePlan(
  c: Queryable,
  venueId: string,
  input: Pick<MoveLineInput, "checkId" | "lineId" | "toTabId" | "qty" | "userId" | "now">,
) {
  const exists = await c.query("select 1 from checks where venue_id = $1 and id = $2", [
    venueId,
    input.checkId,
  ]);
  if (!exists.rowCount) throw new ApiError("not_found", "no such check");
  const from = await tabOfCheck(c, venueId, input.checkId, true);
  if (!from)
    throw new ApiError("invalid_request", "only a bar tab's line moves to another tab", {
      details: { reason: "not_a_tab" },
    });
  if (from.tab_id === input.toTabId)
    throw new ApiError("invalid_request", "the line is on this tab already");
  if (from.state !== "open")
    throw new ApiError("invalid_request", "only an open tab's lines move", {
      details: { reason: "tab_state", state: from.state },
    });
  const fromCheck = await c.query<{ status: string }>(
    "select status from checks where venue_id = $1 and id = $2 for update",
    [venueId, input.checkId],
  );
  if (!["open", "reopened"].includes(fromCheck.rows[0]?.status ?? ""))
    throw new ApiError(
      "ordering_closed",
      "this tab is being paid; once it's paid, a correction is a refund",
    );
  const line = (await movableLines(c, venueId, input.checkId, input.lineId))[0];
  if (!line)
    throw new ApiError("not_found", "no such line on this tab, or nothing of it left to move");
  const qty = input.qty ?? line.qty;
  if (!Number.isInteger(qty) || qty < 1 || qty > line.qty)
    throw new ApiError("invalid_request", `move 1 to ${line.qty} of this line`);

  const to = (
    await c.query<{
      check_id: string;
      state: string;
      cut_at: string | null;
      cut_by: string | null;
      cut_reason: string | null;
    }>(
      `select t.check_id, t.state, to_json(t.cut_off_at) #>> '{}' as cut_at,
              split_part(u.name, ' ', 1) as cut_by, t.cut_off_reason as cut_reason
         from tabs t left join users u on u.id = t.cut_off_by
        where t.venue_id = $1 and t.id = $2`,
      [venueId, input.toTabId],
    )
  ).rows[0];
  if (!to) throw new ApiError("not_found", "no such tab");
  const toTab = (await tabOfCheck(c, venueId, to.check_id, true))!;
  if (toTab.state !== "open")
    throw new ApiError("invalid_request", "a line moves only onto an open tab", {
      details: { reason: "tab_state", state: toTab.state },
    });
  const toCheck = await c.query<{ status: string }>(
    "select status from checks where venue_id = $1 and id = $2 for update",
    [venueId, to.check_id],
  );
  if (!["open", "reopened"].includes(toCheck.rows[0]?.status ?? ""))
    throw new ApiError("ordering_closed", "that tab is being paid");
  await refuseAlcohol(c, venueId, [line], {
    checkId: to.check_id,
    sessionId: null,
    cutOff: to.cut_at ? { at: to.cut_at, by: to.cut_by, reason: to.cut_reason } : null,
    by: input.userId,
    now: input.now,
  });
  return { from, toTab, line, qty };
}

/**
 * The fix panel's Move (`POST /checks/{c}/lines/{l}/move`): one line, or some of it, onto another open
 * tab. No approval, and both tabs log it (the transfer lines, each naming the other tab). The receiving
 * tab's hold is checked as a send does; a declined raise sends the move to a manager (`over_hold`).
 */
export async function moveLine(
  c: Queryable,
  venueId: string,
  input: MoveLineInput,
): Promise<MoveLineAnswer> {
  const pendingMove = await c.query(
    `select 1 from approvals where venue_id = $1 and kind = 'over_hold' and status = 'pending'
        and payload->'move'->>'from_check_id' = $2 and payload->'move'->>'line_id' = $3`,
    [venueId, input.checkId, String(input.lineId)],
  );
  if (pendingMove.rowCount)
    throw new ApiError("approval_pending", "this line's move is already waiting for approval");
  const { from, toTab, line, qty } = await lineMovePlan(c, venueId, input);
  const write = () =>
    transfer(c, venueId, line, qty, {
      fromCheckId: from.check_id,
      toCheckId: toTab.check_id,
      outReason: `Moved to ${barTab(toTab.name)}`,
      inReason: `Moved from ${barTab(from.name)}`,
      by: input.userId,
      approvedBy: null,
      at: input.now,
    });
  const card = holdCardOf(toTab);
  let lineId: number;
  if (!card) lineId = await write();
  else {
    const step = await withinHold(c, venueId, toTab, card, input, write);
    if (step.kind === "raise" || step.kind === "checking") return step;
    if (step.kind === "declined") {
      const pending = await requestApproval(c, venueId, {
        kind: "over_hold",
        targetKind: "tab",
        targetId: toTab.tab_id,
        amountCents: line.unit_cents * qty,
        reason: "Hold raise declined",
        payload: {
          check_id: toTab.check_id,
          move: {
            from_check_id: from.check_id,
            line_id: line.id,
            qty,
            to_tab_id: toTab.tab_id,
          },
          description: `${toTab.name} · ${qty > 1 ? `${qty} × ${line.description}` : line.description} · moved from ${from.name}`,
        },
        requestedBy: input.userId,
        requestedDeviceId: input.deviceId,
        now: input.now,
      });
      await emitEvent(c, { venueId, type: "tab.updated", entityId: toTab.tab_id });
      return { kind: "approval", pending };
    }
    lineId = step.value;
  }
  for (const t of [from, toTab]) {
    await emitEvent(c, { venueId, type: "tab.updated", entityId: t.tab_id });
    await emitEvent(c, { venueId, type: "check.updated", entityId: t.check_id, entityVersion: 0 });
  }
  return { kind: "moved", lineId, toCheckId: toTab.check_id };
}

/** A manager OKs a line move whose receiving tab's hold raise was declined: checked again, then written. */
export async function approvedLineMove(
  c: Queryable,
  venueId: string,
  move: { from_check_id: string; line_id: number; qty: number; to_tab_id: string },
  by: { requestedBy: string; approvedBy: string; at: Temporal.Instant },
) {
  const { from, toTab, line, qty } = await lineMovePlan(c, venueId, {
    checkId: move.from_check_id,
    lineId: move.line_id,
    toTabId: move.to_tab_id,
    qty: move.qty,
    userId: by.requestedBy,
    now: by.at,
  });
  await transfer(c, venueId, line, qty, {
    fromCheckId: from.check_id,
    toCheckId: toTab.check_id,
    outReason: `Moved to ${barTab(toTab.name)}`,
    inReason: `Moved from ${barTab(from.name)}`,
    by: by.requestedBy,
    approvedBy: by.approvedBy,
    at: by.at,
  });
  for (const t of [from, toTab]) {
    await emitEvent(c, { venueId, type: "tab.updated", entityId: t.tab_id });
    await emitEvent(c, { venueId, type: "check.updated", entityId: t.check_id, entityVersion: 0 });
  }
}
