import { emitEvent, paymentById, readSetting, type Queryable } from "@west4/db";
import { businessDate, tipPosting, tipReview, type TipReviewReason } from "@west4/rules";
import { Temporal, cents, formatMoney, type PaySettings } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { attachFile } from "../files/storage.js";
import { venueClock } from "../rooms/assignment.js";
import {
  TargetGone,
  declineHandlers,
  executors,
  requestApproval,
  type PendingAnswer,
} from "../approvals/service.js";
import { closingById, latestClosing, planCapture, type ClosingRow } from "./close.js";

/**
 * Tips to enter (M6-09; Payment flows · Bar tab with a growing hold, steps 5
 * and 7; screens N26): a tab whose paper slip printed waits as `awaiting_tip`
 * with its hold standing. A staff phone types the tip in from the signed slip,
 * with a photo of the slip (files kind slip_photo; none, no tip), and the
 * total plus the tip is captured as on the reader (close.ts · planCapture).
 *  - A tip over 25% of the tab total or over $50, or typed in more than 2 hours
 *    after the slip printed (`pay.tipReview`), answers `202 approval_pending`
 *    (kind tip_review), routed to the manager on duty, or past them when they
 *    typed it in themselves (Andy's go to Abhishek). Nothing is captured until
 *    the approver OKs it on their own phone; a decline leaves the slip to enter.
 *  - A tip typed in after its night's Z report posts to the next business date,
 *    with `adjusts_business_date` pointing at the night (Money rules 16).
 */
export type EnteredTip =
  | { readonly kind: "run"; readonly paymentId: string }
  | { readonly kind: "approval"; readonly pending: PendingAnswer };

async function slipOf(c: Queryable, venueId: string, tabId: string) {
  const tab = (
    await c.query<{ state: string; name: string }>(
      "select state, name from tabs where venue_id = $1 and id = $2 for update",
      [venueId, tabId],
    )
  ).rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  const latest = await latestClosing(c, venueId, tabId);
  const closing = latest ? await closingById(c, venueId, latest.id, true) : null;
  if (tab.state !== "awaiting_tip" || !closing || closing.state !== "slip")
    throw new ApiError("invalid_request", "this tab isn't waiting for a tip from its slip", {
      details: { reason: "tab_state", state: tab.state },
    });
  return { tab, closing };
}

/** The approval a slip waits on, while it's pending. */
async function pendingReview(c: Queryable, venueId: string, closing: ClosingRow) {
  if (!closing.tip_approval_id) return null;
  return (
    (
      await c.query<{ id: string; routed_to: string; name: string }>(
        `select a.id, a.routed_to, u.name from approvals a join users u on u.id = a.routed_to
          where a.venue_id = $1 and a.id = $2 and a.status = 'pending'`,
        [venueId, closing.tip_approval_id],
      )
    ).rows[0] ?? null
  );
}

/** The words the approver reads, from the venue's own limits (the screen shows them translated). */
const reasonText = (r: TipReviewReason, review: PaySettings["tipReview"]) =>
  r === "over_pct"
    ? `Over ${review.overPct}% of the tab`
    : r === "over_cents"
      ? `Over ${formatMoney("en", cents(review.overCents))}`
      : `Entered more than ${review.lateHours} hours after the slip`;

/**
 * Types in the tip from a signed slip (inside the caller's transaction). Answers the capture to run now, or
 * the approval it waits for.
 */
export async function enterSlipTip(
  c: Queryable,
  venueId: string,
  tabId: string,
  input: {
    tipCents: number;
    photoFileId: string | null;
    userId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<EnteredTip> {
  const { tab, closing } = await slipOf(c, venueId, tabId);
  const waiting = await pendingReview(c, venueId, closing);
  if (waiting)
    throw new ApiError("invalid_request", `this tip is waiting for ${waiting.name}`, {
      details: { reason: "tip_waiting", approval_id: waiting.id },
    });
  // No tip goes in without the slip's photo: a new one, or the one already kept with the slip.
  let photo = closing.slip_photo_file_id;
  if (input.photoFileId) {
    const file = (
      await c.query<{ kind: string }>(
        "select kind from files where venue_id = $1 and id = $2 and removed_at is null",
        [venueId, input.photoFileId],
      )
    ).rows[0];
    if (file?.kind !== "slip_photo")
      throw new ApiError("invalid_request", "the photo must be a slip_photo upload", {
        details: { reason: "photo_kind" },
      });
    await attachFile(c, venueId, input.photoFileId, input.now);
    await c.query(
      "update tab_closings set slip_photo_file_id = $3 where venue_id = $1 and id = $2",
      [venueId, closing.id, input.photoFileId],
    );
    photo = input.photoFileId;
  }
  if (!photo)
    throw new ApiError("invalid_request", "take a photo of the signed slip first", {
      details: { reason: "photo_required" },
    });

  const venue = await venueClock(c, venueId);
  const today = businessDate(input.now, venue.timeZone, venue.dayCutover).businessDate;
  const review = (await readSetting(c, venueId, "pay", today))?.value.tipReview;
  if (!review) throw new ApiError("internal", "the tip review limits aren't set");
  const printed = Temporal.Instant.from(closing.slip_printed_at ?? input.now.toString());
  const decision = tipReview({
    tabTotalCents: closing.balance_cents,
    tipCents: input.tipCents,
    enteredAfterMinutes: (input.now.epochMilliseconds - printed.epochMilliseconds) / 60_000,
    review,
  });
  if (decision.needsApproval) {
    const pending = await requestApproval(c, venueId, {
      kind: "tip_review",
      targetKind: "tab",
      targetId: tabId,
      amountCents: input.tipCents,
      reason: decision.reasons.map((r) => reasonText(r, review)).join(" · "),
      payload: {
        closing_id: closing.id,
        tip_cents: input.tipCents,
        reasons: decision.reasons,
        limits: {
          over_pct: review.overPct,
          over_cents: review.overCents,
          late_hours: review.lateHours,
        },
        photo_file_id: photo,
        entered_at: input.now.toString(),
        // The tab and its total; the approval's amount is the tip.
        description: `${tab.name} · ${formatMoney("en", cents(closing.balance_cents))}`,
      },
      requestedBy: input.userId,
      requestedDeviceId: input.deviceId,
      now: input.now,
    });
    await c.query("update tab_closings set tip_approval_id = $3 where venue_id = $1 and id = $2", [
      venueId,
      closing.id,
      pending.approval_id,
    ]);
    await emitEvent(c, { venueId, type: "tab.updated", entityId: tabId });
    return { kind: "approval", pending };
  }
  await captureSlip(c, venueId, closing, {
    tipCents: input.tipCents,
    userId: input.userId,
    now: input.now,
  });
  return { kind: "run", paymentId: closing.payment_id };
}

/**
 * The tip is in: who typed it and when, the business date it posts to, and the capture of the total plus
 * the tip (or the raise before it), as on the reader.
 */
async function captureSlip(
  c: Queryable,
  venueId: string,
  closing: ClosingRow,
  input: { tipCents: number; userId: string; now: Temporal.Instant },
) {
  const payment = (await paymentById(c, venueId, closing.payment_id))!;
  const venue = await venueClock(c, venueId);
  const today = businessDate(input.now, venue.timeZone, venue.dayCutover).businessDate.toString();
  const posting = tipPosting({
    night: payment.business_date,
    today,
    // Whether the night's Z report has posted comes with Close the night (M7); until then a night is closed
    // only once its business date has passed.
    nightClosed: false,
  });
  if (posting.adjustsBusinessDate)
    await c.query(
      `update payments set business_date = $3, adjusts_business_date = $4
        where venue_id = $1 and id = $2`,
      [venueId, payment.id, posting.businessDate, posting.adjustsBusinessDate],
    );
  await c.query(
    `update tab_closings set tip_entered_by = $3, tip_entered_at = $4 where venue_id = $1 and id = $2`,
    [venueId, closing.id, input.userId, input.now.toString()],
  );
  await planCapture(c, venueId, closing, { tipCents: input.tipCents, choice: "slip" }, input.now);
  await emitEvent(c, { venueId, type: "tab.updated", entityId: closing.tab_id });
}

/** The approver OKs a slip's tip: it's captured as typed, by the person who typed it. */
executors.set("tip_review", async (c, venueId, approval, ctx) => {
  const p = approval.payload as { closing_id: string; tip_cents: number };
  const closing = await closingById(c, venueId, p.closing_id, true);
  const tab = closing
    ? (
        await c.query<{ state: string }>(
          "select state from tabs where venue_id = $1 and id = $2 for update",
          [venueId, closing.tab_id],
        )
      ).rows[0]
    : null;
  if (!closing || closing.state !== "slip" || tab?.state !== "awaiting_tip") throw new TargetGone();
  await captureSlip(c, venueId, closing, {
    tipCents: p.tip_cents,
    userId: approval.requested_by,
    now: ctx.at,
  });
});

/** Declined: nothing is captured, and the slip waits in Tips to enter for its tip again. */
declineHandlers.set("tip_review", async (c, venueId, approval) => {
  const p = approval.payload as { closing_id: string };
  const closing = await closingById(c, venueId, p.closing_id, true);
  if (!closing) return;
  await c.query(
    "update tab_closings set tip_approval_id = null where venue_id = $1 and id = $2 and tip_approval_id = $3",
    [venueId, closing.id, approval.id],
  );
  await emitEvent(c, { venueId, type: "tab.updated", entityId: closing.tab_id });
});

/** A slip as Tips to enter lists it: its total, when it printed, its photo, and an approval it waits on. */
export async function slipView(c: Queryable, venueId: string, tabId: string) {
  const closing = await latestClosing(c, venueId, tabId);
  if (!closing || closing.state !== "slip") return null;
  const waiting = await pendingReview(c, venueId, closing);
  return {
    closing_id: closing.id,
    total_cents: closing.balance_cents,
    printed_at: closing.slip_printed_at,
    photo_file_id: closing.slip_photo_file_id,
    waiting_for: waiting ? waiting.name : null,
  };
}
