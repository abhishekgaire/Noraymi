import { syncCheckCredits } from "../songs/queue.js";
import { addCheckLine, emitEvent, readSetting, reasonOnlyUsed, type Queryable } from "@west4/db";
import { businessDate, reasonOnly, reverseWithParts } from "@west4/rules";
import { cents, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import {
  declineHandlers,
  requestApproval,
  TargetGone,
  type PendingAnswer,
} from "../approvals/service.js";
import { venueClock } from "./assignment.js";

/**
 * The fix panel (M3-19; spec 10 · Changing a sent drink; Money rules 7): a
 * comp (the house pays for a drink the guest had) or a void (the sale is taken
 * back) of a sent line is a negative line pointing at it (`reverses_id`), with
 * its reason, whether it was made, and who did it. Within the reason-only
 * limit, counted per person across every screen, a reason is enough; over
 * either limit it waits for a manager other than the requester, on their own
 * phone (a manager's own request goes to an owner), and the line is written
 * only when they approve.
 *
 * A line with components (K-12: a meal's fries and Coke, a combo's side and soda) takes them with
 * it in the same action: one reason, one approval for the whole amount, and each component's comp
 * or void pointing at the line's (`part_of_id`), so the reports show one entry naming them. A
 * component on its own can still be comped or voided alone.
 */
export interface FixPayload {
  readonly check_id: string;
  readonly line_id: number;
  readonly kind: "comp" | "void";
  readonly made: boolean;
  /** How many of the line's drinks: one Margarita of two. The whole line when absent. */
  readonly qty?: number;
}

export type FixAnswer = { readonly status: "added"; readonly line_id: number } | PendingAnswer;

async function lineToFix(c: Queryable, venueId: string, checkId: string, lineId: number) {
  const r = await c.query<{
    id: string;
    description: string;
    qty: string;
    unit_cents: string;
    amount_cents: string;
    tax_category: string | null;
    kind: string;
    status: string;
    reversed: string;
  }>(
    `select l.id, l.description, l.qty, l.unit_cents, l.amount_cents, l.tax_category, l.kind, k.status,
            (select coalesce(sum(x.qty), 0) from check_lines x
              where x.venue_id = l.venue_id and x.reverses_id = l.id) as reversed
       from check_lines l join checks k on k.venue_id = l.venue_id and k.id = l.check_id
      where l.venue_id = $1 and l.check_id = $2 and l.id = $3`,
    [venueId, checkId, lineId],
  );
  return r.rows[0] ?? null;
}

/**
 * A line's components still on the same check (K-12), in the order they were rung, with how many
 * of each aren't comped, voided or moved yet.
 */
export async function lineParts(c: Queryable, venueId: string, checkId: string, lineId: number) {
  const r = await c.query<{
    id: string;
    description: string;
    name: string;
    unit_cents: string;
    tax_category: string | null;
    open_qty: string;
    station: string;
    kitchen_sent: boolean;
  }>(
    `select p.id, p.description, coalesce(oi.component->>'name', p.description) as name,
            p.unit_cents, p.tax_category, oi.station, oi.kitchen_sent_at is not null as kitchen_sent,
            p.qty - coalesce((select sum(x.qty) from check_lines x
                               where x.venue_id = p.venue_id and x.reverses_id = p.id), 0) as open_qty
       from check_lines l
       join order_items oi on oi.venue_id = l.venue_id and oi.parent_item_id = l.source_id
       join check_lines p on p.venue_id = l.venue_id and p.check_id = l.check_id
                         and p.source_id = oi.id and p.kind = 'item'
      where l.venue_id = $1 and l.check_id = $2 and l.id = $3 and l.kind = 'item'
      order by p.id`,
    [venueId, checkId, lineId],
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    description: x.description,
    name: x.name,
    unitCents: Number(x.unit_cents),
    taxCategory: x.tax_category,
    openQty: Number(x.open_qty),
    station: x.station,
    kitchenSent: x.kitchen_sent,
  }));
}
export type LinePart = Awaited<ReturnType<typeof lineParts>>[number];

/**
 * Writes a line's comp or void and its components' (K-12) as one action: the line's first, each
 * component's pointing at it. Returns the line's comp or void.
 */
export async function writeWithParts(
  c: Queryable,
  venueId: string,
  checkId: string,
  line: {
    id: number;
    description: string;
    unitCents: number;
    taxCategory: string | null;
    openQty: number;
  },
  parts: readonly LinePart[],
  w: {
    kind: "comp" | "void";
    qty: number;
    made: boolean;
    reason: string;
    addedBy: string;
    approvedBy: string | null;
    at: Temporal.Instant;
  },
): Promise<number> {
  const v = await venueClock(c, venueId);
  const night = businessDate(w.at, v.timeZone, v.dayCutover).businessDate.toString();
  const label = w.kind === "void" ? "VOID" : "COMP";
  const plan = reverseWithParts(line, parts, w.qty);
  const byId = new Map<
    number,
    { description: string; unitCents: number; taxCategory: string | null }
  >([line, ...parts].map((l) => [l.id, l]));
  let first = 0;
  for (const x of plan.lines) {
    const l = byId.get(x.id)!;
    const id = await addCheckLine(c, venueId, checkId, {
      kind: w.kind,
      description: `${label} · ${l.description}`,
      qty: x.qty,
      unitCents: -l.unitCents,
      amountCents: x.amountCents,
      taxCategory: l.taxCategory,
      businessDate: night,
      reversesId: x.id,
      made: w.made,
      reason: w.reason,
      addedBy: w.addedBy,
      approvedBy: w.approvedBy,
      addedAt: w.at.toString(),
      partOfId: first || null,
      withPartsCents: first ? null : plan.totalCents,
    });
    first ||= id;
  }
  return first;
}

/** Writes the comp or void line itself (reason-only, or approved), with its components. */
export async function writeFixLine(
  c: Queryable,
  venueId: string,
  p: FixPayload,
  who: { reason: string; addedBy: string; approvedBy: string | null; at: Temporal.Instant },
): Promise<number> {
  const line = await lineToFix(c, venueId, p.check_id, p.line_id);
  const qty = p.qty ?? Number(line?.qty ?? 0);
  if (!line || line.status !== "open" || Number(line.reversed) + qty > Number(line.qty))
    throw new TargetGone();
  const parts = await lineParts(c, venueId, p.check_id, p.line_id);
  const id = await writeWithParts(
    c,
    venueId,
    p.check_id,
    {
      id: Number(line.id),
      description: line.description,
      unitCents: Number(line.unit_cents),
      taxCategory: line.tax_category,
      openQty: Number(line.qty) - Number(line.reversed),
    },
    parts,
    {
      kind: p.kind,
      qty,
      made: p.made,
      reason: who.reason,
      addedBy: who.addedBy,
      approvedBy: who.approvedBy,
      at: who.at,
    },
  );
  // A comped or voided drink on a singer's tab takes back the credit it earned, if not yet spent (M6-18).
  await syncCheckCredits(c, venueId, p.check_id, who.at);
  await emitEvent(c, { venueId, type: "check.updated", entityId: p.check_id, entityVersion: 0 });
  return id;
}

export async function fixLine(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    lineId: number;
    kind: "comp" | "void";
    made: boolean;
    qty?: number | undefined;
    reason: string;
    userId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<FixAnswer> {
  const reason = input.reason.trim();
  if (!reason) throw new ApiError("invalid_request", `a ${input.kind} needs a reason`);
  const line = await lineToFix(c, venueId, input.checkId, input.lineId);
  if (!line) throw new ApiError("not_found", "no such line on this check");
  if (line.status !== "open")
    throw new ApiError(
      "ordering_closed",
      "this check is closed; once it's paid, a correction is a refund",
    );
  if (
    ["comp", "void", "tax", "gratuity", "refund", "transfer_out"].includes(line.kind) ||
    Number(line.amount_cents) <= 0
  )
    throw new ApiError("invalid_request", "only a sent line can be comped or voided");
  const qty = input.qty ?? Number(line.qty) - Number(line.reversed);
  if (qty <= 0 || Number(line.reversed) + qty > Number(line.qty))
    throw new ApiError("invalid_request", "this line is already comped or voided");
  const pending = await c.query(
    `select 1 from approvals where venue_id = $1 and status = 'pending' and kind in ('comp', 'void')
        and target_id = $2 and payload->>'line_id' = $3`,
    [venueId, input.checkId, String(input.lineId)],
  );
  if (pending.rowCount)
    throw new ApiError("approval_pending", "this line is already waiting for approval");

  // The line and its components (K-12) are one comp or void: the limit and the approval see the whole.
  const parts = (await lineParts(c, venueId, input.checkId, input.lineId)).filter(
    (x) => x.openQty > 0,
  );
  const amount = -reverseWithParts(
    {
      id: input.lineId,
      unitCents: Number(line.unit_cents),
      openQty: Number(line.qty) - Number(line.reversed),
    },
    parts,
    qty,
  ).totalCents;
  const v = await venueClock(c, venueId);
  const night = businessDate(input.now, v.timeZone, v.dayCutover).businessDate;
  const pos = await readSetting(c, venueId, "pos", night);
  const limits = pos?.value.reasonOnly ?? { eachCents: 0, perShiftCents: 0 };
  const used = await reasonOnlyUsed(c, venueId, input.userId, night.toString());
  const payload: FixPayload = {
    check_id: input.checkId,
    line_id: input.lineId,
    kind: input.kind,
    made: input.made,
    qty,
  };
  if (reasonOnly(cents(used), cents(-amount), limits).needsApproval) {
    const asked = await requestApproval(c, venueId, {
      kind: input.kind,
      targetKind: "check",
      targetId: input.checkId,
      amountCents: amount,
      reason,
      payload: {
        ...payload,
        // The approver sees the parts named: "Classic Cheese + French Fries + Coke".
        description: [line.description, ...parts.map((x) => x.name)].join(" + "),
        ...(parts.length ? { parts: parts.map((x) => x.id) } : {}),
      },
      requestedBy: input.userId,
      requestedDeviceId: input.deviceId,
      now: input.now,
    });
    // Every screen showing the check (the bar POS's tab row too) reads "Waiting for Andy" at once.
    await emitEvent(c, {
      venueId,
      type: "check.updated",
      entityId: input.checkId,
      entityVersion: 0,
    });
    return asked;
  }
  const id = await writeFixLine(c, venueId, payload, {
    reason,
    addedBy: input.userId,
    approvedBy: null,
    at: input.now,
  });
  return { status: "added", line_id: id };
}

/**
 * A comp or void of a sent line that a manager declines changes nothing on the
 * check, but every screen showing it drops "Waiting for Andy" (M6-15).
 */
for (const kind of ["comp", "void"])
  declineHandlers.set(kind, async (c, venueId, approval) => {
    const p = approval.payload as { line_id?: number; check_id?: string };
    if (p.line_id === undefined || !p.check_id) return;
    await emitEvent(c, { venueId, type: "check.updated", entityId: p.check_id, entityVersion: 0 });
  });
