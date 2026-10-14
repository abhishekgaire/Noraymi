import { checkById, emitEvent, readSetting, reasonOnlyUsed, type Queryable } from "@west4/db";
import { businessDate, reasonOnly, type CheckDiscountSpec } from "@west4/rules";
import { cents, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import {
  declineHandlers,
  executors,
  requestApproval,
  TargetGone,
  type ApprovalAnswer,
} from "../approvals/service.js";
import { venueClock } from "./assignment.js";
import { workOut } from "./finalize.js";
import { discountWords, specOf, standingDiscount } from "./discount-spec.js";

/**
 * A % or $ discount on a whole check (P-02; Money rules 7; module check_discount), a room's or a bar
 * tab's, with a reason. It comes off room time, items and songs before tax; each finalize works its
 * `discount` lines out again (finalize.ts), so the gratuity is figured on what's left, and a cash
 * discount applies after it. It counts toward the same reason-only limits as comps and voids, at
 * what it comes to when given; over either limit it waits for approval per the venue's setting
 * (phone, PIN or none), and it's written only when approved. One stands on a check at a time;
 * removing it is allowed while the check is open, before payment. Both are in the audit log.
 */
export interface DiscountPayload {
  readonly check_id: string;
  readonly mode: "pct" | "amount";
  readonly pct: string | null;
  readonly amount_cents: number | null;
  /** What it came to when asked: the amount the limit and the approver see. */
  readonly counted_cents: number;
}

export type DiscountAnswer =
  | { readonly status: "added"; readonly discount_id: string; readonly discount_cents: number }
  | ApprovalAnswer;

/** The check, locked, if a discount may change on it now: a room's or a bar tab's, still open. */
async function openCheck(c: Queryable, venueId: string, checkId: string) {
  const locked = await c.query<{ status: string; kind: string }>(
    "select status, kind from checks where venue_id = $1 and id = $2 for update",
    [venueId, checkId],
  );
  return locked.rows[0] ?? null;
}

/** What the discount would come to on the check now (its lines and room time so far). */
async function wouldCome(
  c: Queryable,
  venueId: string,
  checkId: string,
  spec: CheckDiscountSpec,
  now: Temporal.Instant,
): Promise<number> {
  const found = (await checkById(c, venueId, checkId))!;
  const worked = await workOut(c, venueId, found.check, found.lines, now, { discount: spec });
  return worked.discount?.discountCents ?? 0;
}

async function writeDiscount(
  c: Queryable,
  venueId: string,
  p: DiscountPayload,
  who: { reason: string; addedBy: string; approvedBy: string | null; at: Temporal.Instant },
): Promise<string> {
  const v = await venueClock(c, venueId);
  const night = businessDate(who.at, v.timeZone, v.dayCutover).businessDate.toString();
  const r = await c.query<{ id: string }>(
    `insert into check_discounts (venue_id, check_id, business_date, mode, pct, amount_cents, reason,
       counted_cents, added_by, added_at, approved_by)
     values ($1, $2, open_business_date($1, $3::date), $4, $5::numeric, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      venueId,
      p.check_id,
      night,
      p.mode,
      p.pct,
      p.amount_cents,
      who.reason,
      p.counted_cents,
      who.addedBy,
      who.at.toString(),
      who.approvedBy,
    ],
  );
  await emitEvent(c, { venueId, type: "check.updated", entityId: p.check_id, entityVersion: 0 });
  return r.rows[0]!.id;
}

export async function giveDiscount(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    spec: CheckDiscountSpec;
    reason: string;
    userId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<DiscountAnswer> {
  const reason = input.reason.trim();
  if (!reason) throw new ApiError("invalid_request", "a discount needs a reason");
  const check = await openCheck(c, venueId, input.checkId);
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.kind !== "room" && check.kind !== "bar")
    throw new ApiError("invalid_request", "a discount goes on a room's check or a bar tab");
  if (check.status !== "open")
    throw new ApiError(
      "ordering_closed",
      "this check is closed; once it's paid, a correction is a refund",
    );
  if (await standingDiscount(c, venueId, input.checkId))
    throw new ApiError("invalid_request", "this check has a discount; remove it first", {
      details: { reason: "discount_standing" },
    });
  const pending = await c.query(
    `select 1 from approvals where venue_id = $1 and status = 'pending' and kind = 'discount'
        and target_id = $2`,
    [venueId, input.checkId],
  );
  if (pending.rowCount)
    throw new ApiError(
      "approval_pending",
      "a discount on this check is already waiting for approval",
    );

  const counted = await wouldCome(c, venueId, input.checkId, input.spec, input.now);
  if (counted <= 0)
    throw new ApiError("invalid_request", "nothing on this check to discount yet", {
      details: { reason: "nothing_to_discount" },
    });
  const payload: DiscountPayload = {
    check_id: input.checkId,
    mode: input.spec.mode,
    pct: input.spec.mode === "pct" ? String(input.spec.pct) : null,
    amount_cents: input.spec.mode === "amount" ? input.spec.amountCents : null,
    counted_cents: counted,
  };
  const v = await venueClock(c, venueId);
  const night = businessDate(input.now, v.timeZone, v.dayCutover).businessDate;
  const pos = await readSetting(c, venueId, "pos", night);
  const limits = pos?.value.reasonOnly ?? { eachCents: 0, perShiftCents: 0 };
  const used = await reasonOnlyUsed(c, venueId, input.userId, night.toString());
  if (reasonOnly(cents(used), cents(counted), limits).needsApproval) {
    const asked = await requestApproval(c, venueId, {
      kind: "discount",
      targetKind: "check",
      targetId: input.checkId,
      amountCents: -counted,
      reason,
      payload: { ...payload, description: discountWords(input.spec) },
      requestedBy: input.userId,
      requestedDeviceId: input.deviceId,
      now: input.now,
    });
    // Every screen showing the check reads "Waiting for Andy" at once.
    await emitEvent(c, {
      venueId,
      type: "check.updated",
      entityId: input.checkId,
      entityVersion: 0,
    });
    return asked;
  }
  const id = await writeDiscount(c, venueId, payload, {
    reason,
    addedBy: input.userId,
    approvedBy: null,
    at: input.now,
  });
  return { status: "added", discount_id: id, discount_cents: counted };
}

/** Takes the standing discount off an open check (before payment); the next finalize reverses its lines. */
export async function removeDiscount(
  c: Queryable,
  venueId: string,
  input: { checkId: string; userId: string; now: Temporal.Instant },
): Promise<void> {
  const check = await openCheck(c, venueId, input.checkId);
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.status !== "open")
    throw new ApiError(
      "ordering_closed",
      "this check is closed; once it's paid, a correction is a refund",
    );
  const d = await standingDiscount(c, venueId, input.checkId);
  if (!d) throw new ApiError("not_found", "no discount on this check");
  await c.query(
    "update check_discounts set removed_by = $3, removed_at = $4 where venue_id = $1 and id = $2",
    [venueId, d.id, input.userId, input.now.toString()],
  );
  await emitEvent(c, { venueId, type: "check.updated", entityId: input.checkId, entityVersion: 0 });
}

/** What the check view shows: the standing discount and what it comes to, or one waiting. */
export async function discountView(
  c: Queryable,
  venueId: string,
  checkId: string,
  discountCents: number | null,
) {
  const d = await standingDiscount(c, venueId, checkId);
  const waiting = (
    await c.query<{ name: string; payload: DiscountPayload }>(
      `select u.name, a.payload from approvals a join users u on u.id = a.routed_to
        where a.venue_id = $1 and a.target_id = $2 and a.status = 'pending' and a.kind = 'discount'
        limit 1`,
      [venueId, checkId],
    )
  ).rows[0];
  return {
    discount: d
      ? {
          id: d.id,
          mode: d.mode,
          pct: d.pct,
          amount_cents: d.amount_cents,
          reason: d.reason,
          cents: discountCents ?? d.counted_cents,
          added_by: d.added_by_name,
          approved_by: d.approved_by_name,
          words: discountWords(specOf(d)),
        }
      : null,
    pending_discount: waiting
      ? {
          waiting_for: waiting.name,
          mode: waiting.payload.mode,
          pct: waiting.payload.pct,
          amount_cents: waiting.payload.amount_cents,
          cents: waiting.payload.counted_cents,
        }
      : null,
  };
}

/** Approved: the discount is written as asked, if the check is still open and has none. */
executors.set("discount", async (c, venueId, approval, ctx) => {
  const p = approval.payload as unknown as DiscountPayload;
  const check = await openCheck(c, venueId, p.check_id);
  if (!check || check.status !== "open" || (await standingDiscount(c, venueId, p.check_id)))
    throw new TargetGone();
  await writeDiscount(c, venueId, p, {
    reason: approval.reason,
    addedBy: approval.requested_by,
    approvedBy: ctx.approverId,
    at: ctx.at,
  });
});

/** Declined: nothing changes on the check, but every screen showing it drops "Waiting for Andy". */
declineHandlers.set("discount", async (c, venueId, approval) => {
  const p = approval.payload as { check_id?: string };
  if (!p.check_id) return;
  await emitEvent(c, { venueId, type: "check.updated", entityId: p.check_id, entityVersion: 0 });
});
