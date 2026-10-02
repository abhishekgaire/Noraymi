import { addCheckLine, emitEvent, readSetting, reasonOnlyUsed, type Queryable } from "@west4/db";
import { businessDate, reasonOnly } from "@west4/rules";
import { cents, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { requestApproval, TargetGone, type PendingAnswer } from "../approvals/service.js";
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

/** Writes the comp or void line itself (reason-only, or approved). */
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
  const v = await venueClock(c, venueId);
  const night = businessDate(who.at, v.timeZone, v.dayCutover).businessDate.toString();
  const label = p.kind === "void" ? "VOID" : "COMP";
  const id = await addCheckLine(c, venueId, p.check_id, {
    kind: p.kind,
    description: `${label} · ${line.description}`,
    qty,
    unitCents: -Number(line.unit_cents),
    amountCents: -Number(line.unit_cents) * qty,
    taxCategory: line.tax_category,
    businessDate: night,
    reversesId: Number(line.id),
    made: p.made,
    reason: who.reason,
    addedBy: who.addedBy,
    approvedBy: who.approvedBy,
    addedAt: who.at.toString(),
  });
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

  const amount = Number(line.unit_cents) * qty;
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
  if (reasonOnly(cents(used), cents(-amount), limits).needsApproval)
    return requestApproval(c, venueId, {
      kind: input.kind,
      targetKind: "check",
      targetId: input.checkId,
      amountCents: amount,
      reason,
      payload: { ...payload, description: line.description },
      requestedBy: input.userId,
      requestedDeviceId: input.deviceId,
      now: input.now,
    });
  const id = await writeFixLine(c, venueId, payload, {
    reason,
    addedBy: input.userId,
    approvedBy: null,
    at: input.now,
  });
  return { status: "added", line_id: id };
}
