import {
  emitEvent,
  latePostingAt,
  moduleOn,
  paymentById,
  readSetting,
  type Queryable,
} from "@west4/db";
import { businessDate, tipReview, type TipReviewReason } from "@west4/rules";
import { Temporal, cents, formatMoney, type PaySettings } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { roomOfCheck } from "../rooms/guest-bill.js";
import {
  TargetGone,
  executors,
  requestApproval,
  type ApprovalAnswer,
} from "../approvals/service.js";
import { closingById, latestClosing } from "../tabs/close.js";
import { enterSlipTip, type EnteredTip } from "../tabs/tip.js";

/**
 * Change a tip after paying (P-06; spec 07 · Outside card machine · Changing a tip after paying).
 *  - On the outside card machine: the tip was adjusted on the machine, and the record is fixed to
 *    match. The payment's `tip_cents` changes and a `tip_changes` row keeps from what, to what, who
 *    and when. The tip ledger writes the difference (0163's trigger), credited to whoever the tip
 *    was credited to; after the payment's night closed (or its date passed) it posts to tonight,
 *    pointing back (Money rules 16; closed nights never reopen, D88).
 *  - On a held card before it's captured (a bar tab waiting on its slip): the tip is typed again
 *    through Tips to enter's own path (tabs/tip.ts), replacing one still waiting for approval.
 *  - A Stripe card already captured: refused (a captured charge can't be raised). Cash, a refunded
 *    payment and anything else: refused with the reason.
 * The usual tip checks (`pay.tipReview`: over 25% of the payment, over $50, more than 2 hours after
 * the check was paid) ask for approval per the venue's approval setting (kind tip_change).
 */
export type TipChangeRefusal =
  "captured_card" | "cash" | "refunded" | "not_changeable" | "unchanged" | "tip_waiting";

const refuse = (reason: TipChangeRefusal, message: string, extra: Record<string, unknown> = {}) =>
  new ApiError("invalid_request", message, { details: { reason, ...extra } });

export type ChangedTip =
  | { readonly kind: "changed"; readonly paymentId: string }
  | { readonly kind: "approval"; readonly pending: ApprovalAnswer }
  | { readonly kind: "held"; readonly entered: EnteredTip };

/** The tab whose hold this payment is, and its state. */
async function tabOfHold(c: Queryable, venueId: string, paymentId: string) {
  return (
    (
      await c.query<{ id: string; state: string }>(
        "select id, state from tabs where venue_id = $1 and payment_id = $2 for update",
        [venueId, paymentId],
      )
    ).rows[0] ?? null
  );
}

/** A pending tip change on this payment, with the approver's name. */
async function pendingChange(c: Queryable, venueId: string, paymentId: string) {
  return (
    (
      await c.query<{ id: string; name: string }>(
        `select a.id, u.name from approvals a join users u on u.id = a.routed_to
          where a.venue_id = $1 and a.kind = 'tip_change' and a.target_kind = 'payment'
            and a.target_id = $2 and a.status = 'pending'`,
        [venueId, paymentId],
      )
    ).rows[0] ?? null
  );
}

/** Why this payment's tip can't change here, or null when it can (outside) or goes to the slip (held). */
export function refusalOf(p: {
  method: string;
  status: string;
  heldTabState: string | null;
}): TipChangeRefusal | "outside" | "held" {
  if (p.heldTabState !== null && p.status === "authorized")
    return p.heldTabState === "awaiting_tip" ? "held" : "not_changeable";
  if (p.method === "outside_card")
    return p.status === "captured"
      ? "outside"
      : ["partly_refunded", "refunded"].includes(p.status)
        ? "refunded"
        : "not_changeable";
  if (p.method === "cash") return "cash";
  if (["captured", "partly_refunded", "refunded"].includes(p.status)) return "captured_card";
  return "not_changeable";
}

const MESSAGES: Record<TipChangeRefusal, string> = {
  captured_card: "this card was already charged, and a captured charge can't be raised",
  cash: "a cash tip is in the drawer: count it there",
  refunded: "this payment has a refund, so its tip can't change",
  not_changeable: "this payment's tip can't change",
  unchanged: "that's the tip it already has",
  tip_waiting: "a change to this tip is already waiting",
};

/** When the check this payment paid was paid (the simulated clock's time), for the late check. */
async function paidAt(c: Queryable, venueId: string, paymentId: string) {
  const r = await c.query<{ paid_at: Date | null }>(
    `select k.paid_at from payment_allocations a join checks k on k.venue_id = a.venue_id and k.id = a.check_id
      where a.venue_id = $1 and a.payment_id = $2 order by a.created_at limit 1`,
    [venueId, paymentId],
  );
  const at = r.rows[0]?.paid_at;
  return at ? Temporal.Instant.fromEpochMilliseconds(new Date(at).getTime()) : null;
}

/** The words the approver reads, from the venue's own limits (the screen shows them translated). */
const reasonText = (r: TipReviewReason, review: PaySettings["tipReview"]) =>
  r === "over_pct"
    ? `Over ${review.overPct}% of the payment`
    : r === "over_cents"
      ? `Over ${formatMoney("en", cents(review.overCents))}`
      : `Changed more than ${review.lateHours} hours after paying`;

/** Changes a payment's tip (inside the caller's transaction). */
export async function changeTip(
  c: Queryable,
  venueId: string,
  paymentId: string,
  input: { tipCents: number; userId: string; deviceId: string | null; now: Temporal.Instant },
): Promise<ChangedTip> {
  if (!Number.isSafeInteger(input.tipCents) || input.tipCents < 0)
    throw new ApiError("invalid_request", "the tip is a whole number of cents, zero or more");
  const payment = await paymentById(c, venueId, paymentId, true);
  if (!payment) throw new ApiError("not_found", "no such payment");
  const tab = await tabOfHold(c, venueId, paymentId);
  const kind = refusalOf({
    method: payment.method,
    status: payment.status,
    heldTabState: tab?.state ?? null,
  });

  // A switched-off feature is refused on the server (the register's tabs are core).
  if (kind === "outside" && !(await moduleOn(c, venueId, "outside_card")))
    throw new ApiError("module_off", "the outside card machine is off at this venue", {
      details: { reason: "outside_card_off" },
    });
  if (kind === "held") {
    // A held card before capture: a tip still waiting for approval is replaced by this one.
    const latest = await latestClosing(c, venueId, tab!.id);
    const closing = latest ? await closingById(c, venueId, latest.id, true) : null;
    if (closing?.tip_approval_id) {
      await c.query(
        "update approvals set status = 'expired', decided_at = $3 where venue_id = $1 and id = $2 and status = 'pending'",
        [venueId, closing.tip_approval_id, input.now.toString()],
      );
      await c.query(
        "update tab_closings set tip_approval_id = null where venue_id = $1 and id = $2",
        [venueId, closing.id],
      );
    }
    const entered = await enterSlipTip(c, venueId, tab!.id, {
      tipCents: input.tipCents,
      photoFileId: null,
      userId: input.userId,
      deviceId: input.deviceId,
      now: input.now,
    });
    return { kind: "held", entered };
  }
  if (kind !== "outside") throw refuse(kind, MESSAGES[kind]);
  if (input.tipCents === payment.tip_cents) throw refuse("unchanged", MESSAGES.unchanged);
  const waiting = await pendingChange(c, venueId, paymentId);
  if (waiting)
    throw refuse("tip_waiting", `a change to this tip is waiting for ${waiting.name}`, {
      approval_id: waiting.id,
    });

  const venue = await venueClock(c, venueId);
  const today = businessDate(input.now, venue.timeZone, venue.dayCutover).businessDate;
  const review = (await readSetting(c, venueId, "pay", today))?.value.tipReview;
  if (!review) throw new ApiError("internal", "the tip review limits aren't set");
  const paid = await paidAt(c, venueId, paymentId);
  const decision = tipReview({
    tabTotalCents: payment.amount_cents,
    tipCents: input.tipCents,
    enteredAfterMinutes: paid
      ? Math.max(0, (input.now.epochMilliseconds - paid.epochMilliseconds) / 60_000)
      : 0,
    review,
  });
  if (decision.needsApproval) {
    const pending = await requestApproval(c, venueId, {
      kind: "tip_change",
      targetKind: "payment",
      targetId: paymentId,
      amountCents: input.tipCents,
      reason: decision.reasons.map((r) => reasonText(r, review)).join(" · "),
      payload: {
        payment_id: paymentId,
        from_cents: payment.tip_cents,
        to_cents: input.tipCents,
        reasons: decision.reasons,
        limits: {
          over_pct: review.overPct,
          over_cents: review.overCents,
          late_hours: review.lateHours,
        },
        entered_at: input.now.toString(),
        description: `${formatMoney("en", cents(payment.amount_cents))} · tip ${formatMoney(
          "en",
          cents(payment.tip_cents),
        )} → ${formatMoney("en", cents(input.tipCents))}`,
      },
      requestedBy: input.userId,
      requestedDeviceId: input.deviceId,
      now: input.now,
    });
    await emitEvent(c, { venueId, type: "payment.updated", entityId: paymentId });
    return { kind: "approval", pending };
  }
  await applyTipChange(c, venueId, paymentId, {
    fromCents: payment.tip_cents,
    toCents: input.tipCents,
    userId: input.userId,
    approvalId: null,
    now: input.now,
  });
  return { kind: "changed", paymentId };
}

/**
 * The change itself: its row, then the payment's tip (the ledger's trigger writes the difference
 * on the row's date at commit). Refused if the tip moved since it was asked.
 */
export async function applyTipChange(
  c: Queryable,
  venueId: string,
  paymentId: string,
  input: {
    fromCents: number;
    toCents: number;
    userId: string;
    approvalId: string | null;
    now: Temporal.Instant;
  },
): Promise<boolean> {
  const payment = await paymentById(c, venueId, paymentId, true);
  if (
    !payment ||
    payment.method !== "outside_card" ||
    payment.status !== "captured" ||
    payment.tip_cents !== input.fromCents
  )
    return false;
  // Where it posts (M7-02): the payment's own night while money still posts there; after that night
  // closes, or once its date has passed, tonight, pointing back.
  const posting = await latePostingAt(c, venueId, payment.business_date, input.now);
  // Whoever the tip was credited to keeps it: the ledger's first row for it, or who took it.
  const credited = (
    await c.query<{ user_id: string | null }>(
      `select coalesce(
         (select user_id from tip_ledger where venue_id = $1 and payment_id = $2 and amount_cents > 0
            and refund_id is null order by created_at limit 1),
         (select taken_by from payments where venue_id = $1 and id = $2)) as user_id`,
      [venueId, paymentId],
    )
  ).rows[0]?.user_id;
  await c.query(
    `insert into tip_changes (venue_id, payment_id, from_cents, to_cents, business_date,
                              adjusts_business_date, credited_to, changed_by, changed_at, approval_id)
     values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10)`,
    [
      venueId,
      paymentId,
      input.fromCents,
      input.toCents,
      posting.businessDate,
      posting.adjustsBusinessDate,
      credited ?? null,
      input.userId,
      input.now.toString(),
      input.approvalId,
    ],
  );
  // app_rw never updates a tip itself: set_tip (0055) does, inside the venue.
  await c.query("select set_tip($1, $2)", [paymentId, input.toCents]);
  const checkId = (
    await c.query<{ check_id: string | null }>(
      "select check_id from payment_allocations where venue_id = $1 and payment_id = $2 order by created_at limit 1",
      [venueId, paymentId],
    )
  ).rows[0]?.check_id;
  const roomId = (checkId ? await roomOfCheck(c, venueId, checkId) : null) ?? undefined;
  await emitEvent(c, { venueId, type: "payment.updated", entityId: paymentId, roomId });
  if (checkId) await emitEvent(c, { venueId, type: "check.updated", entityId: checkId, roomId });
  return true;
}

/** The approver OKs a change: it's made as asked, by the person who asked. */
executors.set("tip_change", async (c, venueId, approval, ctx) => {
  const p = approval.payload as { payment_id: string; from_cents: number; to_cents: number };
  const done = await applyTipChange(c, venueId, p.payment_id, {
    fromCents: p.from_cents,
    toCents: p.to_cents,
    userId: approval.requested_by,
    approvalId: approval.id,
    now: ctx.at,
  });
  if (!done) throw new TargetGone();
});

/** A check's payments as Change tip lists them: each one's tip, and whether and why not it can change. */
export async function checkTips(c: Queryable, venueId: string, checkId: string) {
  const rows = (
    await c.query<{
      id: string;
      method: string;
      status: string;
      amount_cents: string;
      tip_cents: string;
      card_brand: string | null;
      card_last4: string | null;
      outside_note: string | null;
      tab_state: string | null;
    }>(
      `select p.id, p.method, p.status, p.amount_cents::text, p.tip_cents::text, p.card_brand,
              p.card_last4, p.outside_note, t.state as tab_state
         from payments p
         left join tabs t on t.venue_id = p.venue_id and t.payment_id = p.id
        where p.venue_id = $1
          and (p.id in (select payment_id from payment_allocations
                         where venue_id = $1 and check_id = $2 and state = 'captured')
               or (t.check_id = $2 and t.state = 'awaiting_tip' and p.status = 'authorized'))
        order by p.created_at`,
      [venueId, checkId],
    )
  ).rows;
  const out = [];
  for (const r of rows) {
    const kind = refusalOf({ method: r.method, status: r.status, heldTabState: r.tab_state });
    const waiting =
      kind === "outside"
        ? await pendingChange(c, venueId, r.id)
        : kind === "held"
          ? ((
              await c.query<{ name: string }>(
                `select u.name from tabs t join tab_closings k on k.venue_id = t.venue_id and k.tab_id = t.id
                   join approvals a on a.venue_id = k.venue_id and a.id = k.tip_approval_id and a.status = 'pending'
                   join users u on u.id = a.routed_to
                  where t.venue_id = $1 and t.payment_id = $2 limit 1`,
                [venueId, r.id],
              )
            ).rows[0] ?? null)
          : null;
    out.push({
      payment_id: r.id,
      method: r.method,
      label:
        r.method === "outside_card"
          ? r.outside_note
          : r.card_last4
            ? `${r.card_brand ?? ""} ${r.card_last4}`.trim()
            : null,
      amount_cents: Number(r.amount_cents),
      tip_cents: Number(r.tip_cents),
      change: kind === "outside" || kind === "held" ? kind : null,
      refused: kind === "outside" || kind === "held" ? null : kind,
      waiting_for: waiting ? waiting.name : null,
    });
  }
  return { check_id: checkId, payments: out };
}
