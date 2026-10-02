import {
  addCheckLine,
  emitEvent,
  idCounts,
  insertPrintJob,
  moveOrder,
  orderById,
  readSetting,
  reasonOnlyUsed,
  type ApprovalRow,
  type OrderRow,
  type Queryable,
} from "@west4/db";
import {
  businessDate,
  orderStep,
  reasonOnly,
  type OrderStatus,
  type OrderStep,
} from "@west4/rules";
import { cents, Temporal } from "@west4/shared";
import { checkForAccept } from "../rooms/present.js";
import { ApiError } from "../http/errors.js";
import { enqueuePush } from "../push/send-push.js";
import {
  executors,
  managerOnDutyAt,
  requestApproval,
  TargetGone,
  type PendingAnswer,
} from "../approvals/service.js";
import { venueClock } from "../rooms/assignment.js";
import { writeFixLine, type FixPayload } from "../rooms/fix.js";
import { alcoholNow, checkAlcohol } from "./alcohol.js";

/**
 * The order pipeline (M3-06; spec 04 · Room orders; Money rules 6). Each
 * step checks the step before it (packages/rules orders.ts) and writes only
 * while the order still has that status, so a stale tap answers `409
 * version_conflict`. Accept is the sale: the lines join the check at that
 * moment and a ticket job is made. Delivered never charges. A returned
 * order is resolved as a void (made or not), which follows the reason-only
 * limit like any void (cautious default, flagged), or remade with a new
 * ticket and nothing charged again.
 */
export type ReturnReason = "no_id" | "too_drunk" | "nobody_there" | "other";
export type Resolution = "void_not_made" | "void_made" | "remake";

export interface StepInput {
  readonly userId: string | null;
  readonly deviceId?: string | null;
  readonly now: Temporal.Instant;
  /** A decline's reason, which the guest sees. */
  readonly reason?: string | undefined;
  /** Who a cancel is for: the guest (their own phone, the host, or staff asking for them) or staff. */
  readonly cancelledFor?: "guest" | "staff" | undefined;
  readonly returnedReason?: ReturnReason | undefined;
  readonly note?: string | null | undefined;
  readonly resolution?: Resolution | undefined;
}

export type StepAnswer = { readonly status: "done"; readonly order: OrderRow } | PendingAnswer;

const RETURN_WORDS: Record<ReturnReason, string> = {
  no_id: "No ID for someone who ordered",
  too_drunk: "Someone looks too drunk",
  nobody_there: "Nobody in the room",
  other: "Other",
};

const optionText = (item: OrderRow["items"][number]) => item.options.map((o) => o.name).join(", ");
const lineName = (item: OrderRow["items"][number]) =>
  item.options.length > 0 ? `${item.name_snapshot} · ${optionText(item)}` : item.name_snapshot;
const unitWithOptions = (item: OrderRow["items"][number]) =>
  item.unit_cents + item.options.reduce((s, o) => s + o.price_delta_cents, 0);

async function nightOfNow(c: Queryable, venueId: string, now: Temporal.Instant) {
  const v = await venueClock(c, venueId);
  return businessDate(now, v.timeZone, v.dayCutover).businessDate.toString();
}

async function ticket(
  c: Queryable,
  venueId: string,
  order: OrderRow,
  now: Temporal.Instant,
  remake: boolean,
) {
  const stations = [...new Set(order.items.map((i) => i.station))];
  // The ID status for the ticket: IDs checked of the party, as the room's tile shows it.
  let ids: { checked: number; party: number } | null = null;
  if (order.session_id) {
    const party = await c.query<{ party_size: number }>(
      "select party_size from room_sessions where venue_id = $1 and id = $2",
      [venueId, order.session_id],
    );
    const counts = await idCounts(c, venueId, [order.session_id]);
    if (party.rows[0])
      ids = { checked: counts.get(order.session_id) ?? 0, party: party.rows[0].party_size };
  }
  for (const station of stations) {
    await insertPrintJob(c, venueId, {
      orderId: order.id,
      kind: "ticket",
      station,
      createdAt: now.toString(),
      payload: {
        order_id: order.id,
        room: order.room_name,
        remake,
        accepted_by: order.accepted_by_name,
        accepted_at: order.accepted_at,
        ids,
        lines: order.items
          .filter((i) => i.station === station)
          .map((i) => ({
            qty: i.qty,
            name: i.name_snapshot,
            options: i.options.map((o) => o.name),
            notes: i.notes,
          })),
      },
    });
  }
}

async function announce(c: Queryable, venueId: string, order: OrderRow, type: string) {
  await emitEvent(c, {
    venueId,
    type,
    entityId: order.id,
    entityVersion: order.version,
    roomId: order.room_id ?? undefined,
  });
}

/** Writes the void lines that resolve a returned order, and records the resolution. */
async function writeVoids(
  c: Queryable,
  venueId: string,
  order: OrderRow,
  who: {
    resolution: "void_not_made" | "void_made";
    reason: string;
    addedBy: string | null;
    approvedBy: string | null;
    at: Temporal.Instant;
  },
): Promise<void> {
  const check = await c.query<{ status: string }>(
    "select status from checks where venue_id = $1 and id = $2",
    [venueId, order.check_id],
  );
  if (!check.rows[0] || check.rows[0].status !== "open") throw new TargetGone();
  const lines = await c.query<{
    id: string;
    description: string;
    qty: string;
    unit_cents: string;
    amount_cents: string;
    tax_category: string | null;
  }>(
    `select id, description, qty, unit_cents, amount_cents, tax_category from check_lines
      where venue_id = $1 and check_id = $2 and kind = 'item' and source_id = any($3::uuid[]) order by id`,
    [venueId, order.check_id, order.items.map((i) => i.id)],
  );
  const night = await nightOfNow(c, venueId, who.at);
  for (const line of lines.rows) {
    await addCheckLine(c, venueId, order.check_id, {
      kind: "void",
      description: `Void · ${line.description}`,
      qty: Number(line.qty),
      unitCents: -Number(line.unit_cents),
      amountCents: -Number(line.amount_cents),
      taxCategory: line.tax_category,
      businessDate: night,
      reversesId: Number(line.id),
      made: who.resolution === "void_made",
      reason: who.reason,
      addedBy: who.addedBy,
      approvedBy: who.approvedBy,
      addedAt: who.at.toString(),
    });
  }
  const moved = await moveOrder(c, venueId, order.id, ["returned"], {
    return_resolution: who.resolution,
  });
  if (!moved) throw new TargetGone();
  await emitEvent(c, {
    venueId,
    type: "check.updated",
    entityId: order.check_id,
    entityVersion: 0,
  });
}

export async function stepOrder(
  c: Queryable,
  venueId: string,
  orderId: string,
  step: Exclude<OrderStep, "remake">,
  input: StepInput,
): Promise<StepAnswer> {
  const order = await orderById(c, venueId, orderId);
  if (!order) throw new ApiError("not_found", "no such order");
  const machineStep: OrderStep =
    step === "resolve" && input.resolution === "remake" ? "remake" : step;
  const check = orderStep(order.status as OrderStatus, machineStep);
  if (!check.ok)
    throw new ApiError("version_conflict", check.why, { details: { status: order.status } });
  const now = input.now.toString();
  const by = input.userId;
  const move = async (set: Record<string, unknown>) => {
    if (!(await moveOrder(c, venueId, order.id, [order.status], { status: check.to, ...set })))
      throw new ApiError("version_conflict", "someone else moved this order first; refresh", {
        details: { status: order.status },
      });
    return (await orderById(c, venueId, order.id))!;
  };

  switch (step) {
    case "accept": {
      // Accept runs the alcohol check again: the window may have closed, or the room been cut off (M3-20).
      await checkAlcohol(c, venueId, {
        items: order.items.map((i) => ({ name: lineName(i), alcohol: i.alcohol })),
        sessionId: order.session_id,
        checkId: order.check_id,
        roomGuestId: order.room_guest_id,
        orderId: order.id,
        refusedBy: by,
        now: input.now,
      });
      const moved = await move({ accepted_by: by, accepted_at: now });
      // After the room's check is paid, an accepted order opens a new check on the session (M4-08).
      const target = await checkForAccept(c, venueId, {
        checkId: moved.check_id,
        openedBy: by ?? moved.placed_by ?? "",
        now: input.now,
      });
      if (target !== moved.check_id)
        await c.query("update orders set check_id = $3 where venue_id = $1 and id = $2", [
          venueId,
          moved.id,
          target,
        ]);
      const done = target === moved.check_id ? moved : { ...moved, check_id: target };
      // The sale: the lines join the check now, at the price copied when it was ordered.
      const night = await nightOfNow(c, venueId, input.now);
      for (const item of done.items) {
        const unit = unitWithOptions(item);
        await addCheckLine(c, venueId, done.check_id, {
          kind: "item",
          description: lineName(item),
          qty: item.qty,
          unitCents: unit,
          amountCents: unit * item.qty,
          taxCategory: item.tax_category,
          businessDate: night,
          sourceId: item.id,
          addedBy: by,
          addedAt: now,
        });
      }
      await ticket(c, venueId, done, input.now, false);
      await announce(c, venueId, done, "order.accepted");
      await emitEvent(c, {
        venueId,
        type: "check.updated",
        entityId: done.check_id,
        entityVersion: 0,
      });
      return { status: "done", order: done };
    }
    case "hold": {
      const done = await move({ held_by: by, held_at: now });
      await announce(c, venueId, done, "order.held");
      return { status: "done", order: done };
    }
    case "decline": {
      // After the alcohol window closes there's no Decline: alcohol nobody accepted cancels itself (M3-22).
      if (
        order.items.some((i) => i.alcohol) &&
        (await alcoholNow(c, venueId, input.now)).state === "closed"
      )
        throw new ApiError(
          "alcohol_closed",
          "after the close there's no decline; the order cancels itself",
        );
      const reason = input.reason?.trim() ?? "";
      if (!reason)
        throw new ApiError("invalid_request", "a decline needs a reason the guest will see");
      const done = await move({
        cancel_reason: "declined",
        decline_reason: reason.slice(0, 200),
        cancelled_by: by,
        cancelled_at: now,
      });
      await announce(c, venueId, done, "order.cancelled");
      return { status: "done", order: done };
    }
    case "cancel": {
      const done = await move({
        cancel_reason: input.cancelledFor ?? "staff",
        cancelled_by: by,
        cancelled_at: now,
      });
      await announce(c, venueId, done, "order.cancelled");
      return { status: "done", order: done };
    }
    case "ready": {
      const done = await move({ ready_by: by, ready_at: now });
      await announce(c, venueId, done, "order.ready");
      // Every role carries runs, so every signed-in staff phone hears a run is ready (M3-18, flagged).
      await enqueuePush(c, {
        venueId,
        audience: { kind: "everyone" },
        message: {
          key: "orders.push.ready",
          params: { room: done.room_name ?? "" },
          url: "/runs",
          tag: `run-${done.id}`,
        },
        runAt: input.now,
      });
      return { status: "done", order: done };
    }
    case "claim": {
      const done = await move({ claimed_by: by, claimed_at: now });
      await announce(c, venueId, done, "order.claimed");
      return { status: "done", order: done };
    }
    case "deliver": {
      // Delivered only ends the run: nothing is charged here.
      const done = await move({ delivered_by: by, delivered_at: now });
      await announce(c, venueId, done, "order.delivered");
      return { status: "done", order: done };
    }
    case "return": {
      if (!input.returnedReason) throw new ApiError("invalid_request", "a return needs the reason");
      const done = await move({
        returned_by: by,
        returned_at: now,
        returned_reason: input.returnedReason,
        returned_note: input.note?.trim() ? input.note.trim().slice(0, 300) : null,
      });
      await announce(c, venueId, done, "order.returned");
      // No ID or too drunk is an alcohol refusal (M3-18), logged once per alcohol item.
      if (input.returnedReason === "no_id" || input.returnedReason === "too_drunk") {
        const night = await nightOfNow(c, venueId, input.now);
        for (const item of done.items.filter((i) => i.alcohol))
          await c.query(
            `insert into alcohol_refusals (venue_id, session_id, check_id, room_guest_id, order_id, reason, item, refused_by, at, business_date)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              venueId,
              done.session_id,
              done.check_id,
              done.room_guest_id,
              done.id,
              input.returnedReason,
              lineName(item),
              by,
              now,
              night,
            ],
          );
      }
      const manager = await managerOnDutyAt(c, venueId, input.now);
      if (manager)
        await enqueuePush(c, {
          venueId,
          audience: { kind: "person", userId: manager },
          message: {
            key: "orders.returned.push",
            params: { room: done.room_name ?? "", reason: RETURN_WORDS[input.returnedReason] },
            url: "/runs",
            tag: `order-returned-${done.id}`,
          },
          runAt: input.now,
        });
      return { status: "done", order: done };
    }
    case "resolve": {
      const resolution = input.resolution;
      if (!resolution)
        throw new ApiError("invalid_request", "resolve takes void_not_made, void_made or remake");
      if (resolution === "remake") {
        const done = await move({
          return_resolution: "remake",
          ready_by: null,
          ready_at: null,
          claimed_by: null,
          claimed_at: null,
        });
        await ticket(c, venueId, done, input.now, true);
        await announce(c, venueId, done, "order.accepted");
        return { status: "done", order: done };
      }
      if (order.approval_waiting_for)
        throw new ApiError("approval_pending", "this return is already waiting for approval");
      const reason = `Couldn't serve: ${RETURN_WORDS[(order.returned_reason ?? "other") as ReturnReason]}`;
      const amount = order.amount_cents;
      const night = await nightOfNow(c, venueId, input.now);
      const pos = await readSetting(c, venueId, "pos", Temporal.PlainDate.from(night));
      const limits = pos?.value.reasonOnly ?? { eachCents: 0, perShiftCents: 0 };
      const used = by ? await reasonOnlyUsed(c, venueId, by, night) : 0;
      if (!by || reasonOnly(cents(used), cents(-amount), limits).needsApproval)
        return requestApproval(c, venueId, {
          kind: "void",
          targetKind: "order",
          targetId: order.id,
          amountCents: amount,
          reason,
          payload: { order_id: order.id, resolution },
          requestedBy: by ?? "",
          requestedDeviceId: input.deviceId ?? null,
          now: input.now,
        });
      await writeVoids(c, venueId, order, {
        resolution,
        reason,
        addedBy: by,
        approvedBy: null,
        at: input.now,
      });
      const done = (await orderById(c, venueId, order.id))!;
      await announce(c, venueId, done, "order.resolved");
      return { status: "done", order: done };
    }
  }
}

/** An approved void of a returned order (over the reason-only limit) runs here, on the approver's phone. */
executors.set("void", async (c, venueId, approval: ApprovalRow, ctx) => {
  // A void of a sent line from the fix panel (M3-19) carries the line it reverses.
  if ((approval.payload as { line_id?: number }).line_id !== undefined) {
    await writeFixLine(c, venueId, approval.payload as unknown as FixPayload, {
      reason: approval.reason,
      addedBy: approval.requested_by,
      approvedBy: ctx.approverId,
      at: ctx.at,
    });
    return;
  }
  const p = approval.payload as { order_id?: string; resolution?: "void_not_made" | "void_made" };
  if (!p.order_id || !p.resolution) throw new TargetGone();
  const order = await orderById(c, venueId, p.order_id);
  if (!order || order.status !== "returned" || order.return_resolution) throw new TargetGone();
  await writeVoids(c, venueId, order, {
    resolution: p.resolution,
    reason: approval.reason,
    addedBy: approval.requested_by,
    approvedBy: ctx.approverId,
    at: ctx.at,
  });
  await announce(c, venueId, (await orderById(c, venueId, order.id))!, "order.resolved");
});
