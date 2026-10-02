import {
  checkById,
  emitEvent,
  enqueue,
  insertDrawerMove,
  insertRefund,
  latestRevision,
  paymentById,
  refundById,
  refundByStripeId,
  refundedOf,
  refundsOfApproval,
  setPaymentStatus,
  setRefundStatus,
  stripeAccountOf,
  withVenue,
  type Queryable,
  type RefundRow,
} from "@west4/db";
import { refundCap } from "@west4/rules";
import { Temporal, cents, formatMoney } from "@west4/shared";
import type pg from "pg";
import {
  declineHandlers,
  executors,
  requestApproval,
  TargetGone,
  type PendingAnswer,
} from "../approvals/service.js";
import { ApiError } from "../http/errors.js";
import { roomOfCheck } from "../rooms/guest-bill.js";
import { StripeError, StripeUnknownResult, type StripeClient } from "../stripe/client.js";
import { createRefund, retrieveRefund, type StripeRefund } from "../stripe/payments.js";
import { stripeEventHandlers } from "../stripe/webhooks.js";
import { queueText } from "../texts/queue.js";

/**
 * Refunds (M4-21; Money rules 14 and 16; Payment flows · Refunds). Owners and
 * managers ask, from a paid check (the lines, how much comes off each payment,
 * a reason) or for a deposit on a booking not yet checked in; each payment's
 * part is capped at what it captured less its earlier refunds (422
 * over_refundable). The ask answers 202 approval_pending, routed to someone
 * other than the requester. On approval the reversing lines are written first
 * (each line plus its share of tax and gratuity; anything over that is one
 * "Refund" line), then each card refund goes to Stripe from the `refund.run`
 * job, outside any transaction, keyed `<payment_id>:refund:<n>`. A refund is
 * "Refund pending" until Stripe's refund.updated says it succeeded; then a
 * negative allocation keeps the check's amount due at zero and the payment is
 * partly refunded or refunded. A failed one keeps Stripe's reason and leaves
 * the amount owed to the guest. A cash refund is a drawer move, done at once.
 */
export const REFUND_RUN_KIND = "refund.run";

export interface RefundPart {
  readonly paymentId: string;
  readonly amountCents: number;
}
export interface RefundLinePick {
  readonly lineId: number;
  readonly amountCents: number;
}
interface PlannedLine {
  readonly description: string;
  readonly amount_cents: number;
  readonly tax_category: string | null;
  readonly reverses_id: number | null;
}

/** Half up, in integers: a × b ÷ d. */
const share = (a: number, b: number, d: number) =>
  d === 0 ? 0 : Math.floor((2 * a * b + d) / (2 * d));

const REFUNDABLE = new Set(["item", "room_time", "min_spend", "song", "damage", "fee"]);
const GRATUITY_BASE = new Set(["item", "room_time", "min_spend", "song", "comp", "void"]);

/**
 * The reversing lines for what's picked: each line's part, its share of the revision's tax (per
 * category, over that category's taxable base) and of the gratuity (over the lines it was worked
 * on), each half up, so refunding a whole check gives back exactly its tax and gratuity.
 */
async function planLines(
  c: Queryable,
  venueId: string,
  checkId: string,
  picks: readonly RefundLinePick[],
): Promise<PlannedLine[]> {
  if (picks.length === 0) return [];
  const found = (await checkById(c, venueId, checkId))!;
  const rev = await latestRevision(c, venueId, checkId);
  const reversed = new Set(found.lines.map((l) => l.reverses_id).filter((x) => x !== null));
  const standing = found.lines.filter((l) => l.reverses_id === null && !reversed.has(l.id));
  const out: PlannedLine[] = [];
  const byCategory = new Map<string, number>();
  let gratuityPart = 0;
  for (const pick of picks) {
    const line = standing.find((l) => Number(l.id) === pick.lineId);
    if (!line || !REFUNDABLE.has(line.kind))
      throw new ApiError("invalid_request", "a picked line isn't on this check", {
        details: { line_id: pick.lineId },
      });
    if (
      !Number.isInteger(pick.amountCents) ||
      pick.amountCents <= 0 ||
      pick.amountCents > Number(line.amount_cents)
    )
      throw new ApiError("invalid_request", "a line gives back at most what it came to", {
        details: { line_id: pick.lineId, max_cents: Number(line.amount_cents) },
      });
    out.push({
      description: `Refund · ${line.kind === "room_time" ? "Room time" : line.description}`,
      amount_cents: -pick.amountCents,
      tax_category: line.tax_category,
      reverses_id: Number(line.id),
    });
    if (line.tax_category)
      byCategory.set(
        line.tax_category,
        (byCategory.get(line.tax_category) ?? 0) + pick.amountCents,
      );
    if (GRATUITY_BASE.has(line.kind)) gratuityPart += pick.amountCents;
  }
  for (const tax of standing.filter((l) => l.kind === "tax")) {
    const words = tax.description.replace(/^Tax · /, "");
    const category = [...byCategory.keys()].find((k) =>
      standing.some((l) => l.tax_category === k && l.kind !== "tax" && words === TAX_WORDS[k]),
    );
    if (!category) continue;
    const back = share(
      Number(tax.amount_cents),
      byCategory.get(category)!,
      Number(tax.taxable_base_cents ?? 0),
    );
    if (back > 0)
      out.push({
        description: `Refund · ${tax.description}`,
        amount_cents: -back,
        tax_category: null,
        reverses_id: null,
      });
  }
  const gratuity = standing
    .filter((l) => l.kind === "gratuity")
    .reduce((s, l) => s + Number(l.amount_cents), 0);
  if (gratuity > 0 && gratuityPart > 0 && rev) {
    const base = standing
      .filter((l) => GRATUITY_BASE.has(l.kind))
      .reduce((s, l) => s + Number(l.amount_cents), 0);
    const back = share(gratuity, gratuityPart, base);
    if (back > 0)
      out.push({
        description: "Refund · Gratuity",
        amount_cents: -back,
        tax_category: null,
        reverses_id: null,
      });
  }
  return out;
}
const TAX_WORDS: Record<string, string> = {
  room_time: "room time",
  drink: "drinks",
  food: "food",
  song: "songs",
  damage: "damage",
  fee: "fees",
};

/** A payment's captured money, and whether it belongs to the check or booking being refunded. */
async function refundablePayment(
  c: Queryable,
  venueId: string,
  part: RefundPart,
  target: { checkId: string | null; bookingId: string | null },
) {
  const payment = await paymentById(c, venueId, part.paymentId, true);
  if (!payment) throw new ApiError("not_found", "no such payment");
  const belongs = target.checkId
    ? (
        await c.query(
          `select 1 from payment_allocations where venue_id = $1 and payment_id = $2 and check_id = $3
              and kind = 'payment' and state = 'captured'`,
          [venueId, part.paymentId, target.checkId],
        )
      ).rows.length > 0
    : payment.booking_id === target.bookingId;
  if (!belongs) throw new ApiError("not_found", "no such payment on this check");
  if (payment.status !== "captured" && payment.status !== "partly_refunded")
    throw new ApiError("invalid_request", `this payment is ${payment.status}`);
  const captured = Number(payment.amount_cents) + Number(payment.tip_cents);
  const cap = refundCap({
    capturedCents: captured,
    earlierRefundsCents: await refundedOf(c, venueId, part.paymentId),
    requestedCents: part.amountCents,
  });
  if (!cap.allowed)
    throw new ApiError("over_refundable", "more than this payment can give back", {
      details: { payment_id: part.paymentId, max_refundable_cents: cap.maxRefundableCents },
    });
  return payment;
}

/** The ask: checked, capped, planned, and sent for approval. Answers 202 approval_pending. */
export async function askRefund(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string | null;
    bookingId: string | null;
    lines: readonly RefundLinePick[];
    parts: readonly RefundPart[];
    reason: string;
    userId: string;
    deviceId: string | null;
    businessDate: string;
    now: Temporal.Instant;
  },
): Promise<PendingAnswer & { refund_ids: string[] }> {
  if (!input.reason.trim()) throw new ApiError("invalid_request", "a refund needs a reason");
  if (input.parts.length === 0)
    throw new ApiError("invalid_request", "pick the payment it comes off");
  if (new Set(input.parts.map((p) => p.paymentId)).size !== input.parts.length)
    throw new ApiError("invalid_request", "name each payment once");
  if (input.checkId) {
    const check = (
      await c.query<{ status: string }>(
        "select status from checks where venue_id = $1 and id = $2 for update",
        [venueId, input.checkId],
      )
    ).rows[0];
    if (!check) throw new ApiError("not_found", "no such check");
    if (check.status !== "paid" && check.status !== "partly_paid")
      throw new ApiError("invalid_request", "a refund starts from a paid check");
  } else {
    const booking = (
      await c.query<{ status: string }>(
        "select status from bookings where venue_id = $1 and id = $2 for update",
        [venueId, input.bookingId],
      )
    ).rows[0];
    if (!booking) throw new ApiError("not_found", "no such booking");
    if (booking.status === "checked_in" || booking.status === "completed")
      throw new ApiError("invalid_request", "this booking is checked in: refund from its check");
  }
  const payments = [];
  for (const part of input.parts)
    payments.push(
      await refundablePayment(c, venueId, part, {
        checkId: input.checkId,
        bookingId: input.bookingId,
      }),
    );
  const total = input.parts.reduce((s, p) => s + p.amountCents, 0);
  const plan = input.checkId ? await planLines(c, venueId, input.checkId, input.lines) : [];
  const planned = -plan.reduce((s, l) => s + l.amount_cents, 0);
  if (planned > total)
    throw new ApiError("invalid_request", "the lines come to more than the payments give back", {
      details: { lines_cents: planned, payments_cents: total },
    });
  // What the payments give back beyond the picked lines is one refund line, so the check still adds up.
  if (input.checkId && total > planned)
    plan.push({
      description: `Refund · ${input.reason.trim().slice(0, 80)}`,
      amount_cents: -(total - planned),
      tax_category: null,
      reverses_id: null,
    });
  const ids = input.parts.map(() => crypto.randomUUID());
  const pending = await requestApproval(c, venueId, {
    kind: "refund",
    targetKind: input.checkId ? "check" : "booking",
    targetId: (input.checkId ?? input.bookingId)!,
    amountCents: total,
    reason: input.reason.trim(),
    payload: { refund_ids: ids, plan, check_id: input.checkId, booking_id: input.bookingId },
    requestedBy: input.userId,
    requestedDeviceId: input.deviceId,
    now: input.now,
  });
  for (const [i, part] of input.parts.entries())
    await insertRefund(c, venueId, {
      id: ids[i]!,
      paymentId: part.paymentId,
      checkId: input.checkId,
      bookingId: input.bookingId,
      amountCents: part.amountCents,
      reason: input.reason.trim(),
      requestedBy: input.userId,
      approvalId: pending.approval_id,
      businessDate: input.businessDate,
      adjustsBusinessDate:
        payments[i]!.business_date !== input.businessDate ? payments[i]!.business_date : null,
      requestedAt: input.now.toString(),
    });
  return { ...pending, refund_ids: ids };
}

/** A succeeded refund: its negative allocation, and the payment partly refunded or refunded. */
async function landRefund(c: Queryable, venueId: string, refund: RefundRow, at: string) {
  if (refund.check_id)
    await c.query(
      `insert into payment_allocations (venue_id, payment_id, check_id, amount_cents, kind, state, refund_id)
       values ($1, $2, $3, $4, 'refund', 'captured', $5)`,
      [venueId, refund.payment_id, refund.check_id, -refund.amount_cents, refund.id],
    );
  const payment = (await paymentById(c, venueId, refund.payment_id))!;
  const back = (
    await c.query<{ s: string }>(
      "select coalesce(sum(amount_cents), 0) as s from refunds where venue_id = $1 and payment_id = $2 and status = 'succeeded'",
      [venueId, refund.payment_id],
    )
  ).rows[0]!.s;
  const captured = Number(payment.amount_cents) + Number(payment.tip_cents);
  const to = Number(back) >= captured ? "refunded" : "partly_refunded";
  if (payment.status !== to) {
    if (payment.status === "captured" && to === "refunded")
      await setPaymentStatus(c, venueId, refund.payment_id, "refunded", "api");
    else await setPaymentStatus(c, venueId, refund.payment_id, to, "api");
  }
  await announce(c, venueId, refund);
  void at;
}

async function announce(c: Queryable, venueId: string, refund: RefundRow) {
  const roomId = refund.check_id ? await roomOfCheck(c, venueId, refund.check_id) : undefined;
  await emitEvent(c, { venueId, type: "payment.updated", entityId: refund.payment_id, roomId });
  if (refund.check_id)
    await emitEvent(c, { venueId, type: "check.updated", entityId: refund.check_id, roomId });
  await emitEvent(c, {
    venueId,
    type: "refund.updated",
    entityId: refund.id,
    entityVersion: 0,
    audience: "user",
    userId: refund.requested_by,
  });
}

// Approved on another person's own phone: the reversing lines first, then each refund.
executors.set("refund", async (c, venueId, approval, ctx) => {
  const refunds = (await refundsOfApproval(c, venueId, approval.id)).filter(
    (r) => r.status === "pending",
  );
  if (refunds.length === 0) throw new TargetGone();
  const payload = approval.payload as { plan?: PlannedLine[]; check_id?: string | null };
  const at = ctx.at.toString();
  const businessDate = refunds[0]!.business_date;
  if (payload.check_id)
    for (const l of payload.plan ?? [])
      await c.query(
        `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category,
           reverses_id, business_date, added_by, added_at, reason)
         values ($1, $2, 'refund', $3, 1, $4, $4, $5, $6, $7, $8, $9, $10)`,
        [
          venueId,
          payload.check_id,
          l.description,
          l.amount_cents,
          l.tax_category,
          l.reverses_id,
          businessDate,
          ctx.approverId,
          at,
          approval.reason,
        ],
      );
  for (const refund of refunds) {
    await c.query("update refunds set approved_by = $3 where venue_id = $1 and id = $2", [
      venueId,
      refund.id,
      ctx.approverId,
    ]);
    const payment = (await paymentById(c, venueId, refund.payment_id))!;
    if (payment.method === "cash") {
      // Cash goes back out of the drawer (or staff bank) that took it.
      const held = (
        await c.query<{ drawer_session_id: string | null; staff_bank_id: string | null }>(
          "select drawer_session_id, staff_bank_id from payments where venue_id = $1 and id = $2",
          [venueId, payment.id],
        )
      ).rows[0]!;
      await insertDrawerMove(c, venueId, {
        drawerSessionId: held.drawer_session_id,
        staffBankId: held.staff_bank_id,
        kind: "refund",
        amountCents: -refund.amount_cents,
        paymentId: payment.id,
        takenBy: ctx.approverId,
        reason: refund.reason,
        at,
      });
      await setRefundStatus(c, venueId, refund.id, { status: "succeeded", at });
      await landRefund(c, venueId, { ...refund, status: "succeeded" }, at);
    } else {
      await enqueue(c, {
        venueId,
        kind: REFUND_RUN_KIND,
        pool: "critical",
        dedupeKey: `${REFUND_RUN_KIND}:${refund.id}`,
        payload: { refund_id: refund.id },
        runAt: ctx.at,
        maxAttempts: 5,
      });
      await announce(c, venueId, refund);
    }
  }
});

// Declined: nothing is given back.
declineHandlers.set("refund", async (c, venueId, approval, ctx) => {
  for (const r of await refundsOfApproval(c, venueId, approval.id))
    await setRefundStatus(c, venueId, r.id, { status: "canceled", at: ctx.at.toString() });
});

export interface RefundDeps {
  readonly pool: pg.Pool;
  readonly stripe: StripeClient;
  readonly clock: { now(): Temporal.Instant };
}

/** The `refund.run` job: sends one approved card refund to Stripe and keeps its id. */
export async function runRefund(deps: RefundDeps, venueId: string, refundId: string) {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `refund:${refundId}` }, work);
  const ctx = await inVenue(async (c) => {
    const refund = await refundById(c, venueId, refundId);
    if (!refund || refund.status !== "pending" || refund.stripe_refund_id || !refund.approved_by)
      return null;
    const payment = await paymentById(c, venueId, refund.payment_id);
    return {
      refund,
      piId: payment?.stripe_pi_id ?? null,
      account: await stripeAccountOf(c, venueId),
    };
  });
  if (!ctx) return;
  const now = deps.clock.now().toString();
  if (!ctx.piId || !ctx.account) {
    await inVenue((c) =>
      setRefundStatus(c, venueId, refundId, {
        status: "failed",
        failureReason: "no_payment_at_stripe",
        at: now,
      }),
    );
    return;
  }
  let sent: StripeRefund;
  try {
    sent = await createRefund(
      deps.stripe,
      ctx.account,
      { piId: ctx.piId, amountCents: ctx.refund.amount_cents, refundId },
      `${ctx.refund.payment_id}:refund:${ctx.refund.n}`,
    );
  } catch (e) {
    // No answer: the job runs again with the same key, which can only ever make one refund.
    if (e instanceof StripeUnknownResult) throw e;
    if (!(e instanceof StripeError)) throw e;
    await inVenue(async (c) => {
      await setRefundStatus(c, venueId, refundId, {
        status: "failed",
        failureReason: e.code ?? e.message,
        at: now,
      });
      await announce(c, venueId, ctx.refund);
    });
    return;
  }
  await inVenue((c) =>
    setRefundStatus(c, venueId, refundId, { status: "pending", stripeRefundId: sent.id, at: now }),
  );
}

/** What Stripe says now about one refund, applied once: succeeded, failed or canceled. */
export async function applyRefund(
  deps: RefundDeps,
  venueId: string,
  stripeRefundId: string,
  refundIdHint: string | null,
  texts: { allowList: readonly string[] | null } = { allowList: null },
) {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `refund:${stripeRefundId}` }, work);
  const known = await inVenue(async (c) => {
    const byStripe = await refundByStripeId(c, venueId, stripeRefundId);
    if (byStripe) return byStripe;
    // Our process stopped after Stripe made the refund and before we kept its id (the chaos case).
    return refundIdHint ? refundById(c, venueId, refundIdHint) : null;
  });
  if (!known || known.status !== "pending") return;
  const account = await inVenue((c) => stripeAccountOf(c, venueId));
  if (!account) return;
  const fresh = await retrieveRefund(deps.stripe, account, stripeRefundId);
  const at = deps.clock.now().toString();
  await inVenue(async (c) => {
    const refund = await refundById(c, venueId, known.id, true);
    if (!refund || refund.status !== "pending") return;
    if (fresh.status === "succeeded") {
      await setRefundStatus(c, venueId, refund.id, {
        status: "succeeded",
        stripeRefundId,
        at,
      });
      await landRefund(c, venueId, { ...refund, status: "succeeded" }, at);
      if (refund.booking_id) await depositRefundText(c, venueId, refund, texts, deps.clock.now());
    } else if (fresh.status === "failed" || fresh.status === "canceled") {
      await setRefundStatus(c, venueId, refund.id, {
        status: fresh.status,
        stripeRefundId,
        failureReason: fresh.failure_reason ?? fresh.status,
        at,
      });
      await announce(c, venueId, refund);
    } else await setRefundStatus(c, venueId, refund.id, { status: "pending", stripeRefundId, at });
  });
}

/** The Deposit refund text, to the booking's guest (Song systems and texts, text 9). */
async function depositRefundText(
  c: Queryable,
  venueId: string,
  refund: RefundRow,
  texts: { allowList: readonly string[] | null },
  now: Temporal.Instant,
) {
  const b = (
    await c.query<{
      phone: string | null;
      guest_id: string | null;
      starts_at: string;
      time_zone: string;
    }>(
      `select g.phone_e164 as phone, g.id as guest_id, to_json(b.starts_at) #>> '{}' as starts_at, v.time_zone
         from bookings b join venues v on v.id = b.venue_id
         left join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
        where b.venue_id = $1 and b.id = $2`,
      [venueId, refund.booking_id],
    )
  ).rows[0];
  if (!b?.phone) return;
  const z = Temporal.Instant.from(b.starts_at).toZonedDateTimeISO(b.time_zone);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  await queueText(
    c,
    venueId,
    {
      templateKey: "deposit_refund",
      to: b.phone,
      params: {
        amount: formatMoney("en", cents(refund.amount_cents)),
        date: `${days[z.dayOfWeek - 1]} ${months[z.month - 1]} ${z.day}`,
      },
      guestId: b.guest_id,
      context: { kind: "booking", id: refund.booking_id! },
      sentBy: null,
      now,
    },
    texts,
  ).catch(() => undefined); // A text that can't go out never undoes the refund.
}

// refund.updated and refund.failed: read the refund from Stripe now, so events in any order land right.
for (const type of ["refund.updated", "refund.failed"])
  stripeEventHandlers.set(type, async (ctx) => {
    const object = (ctx.event.payload["data"] as { object?: StripeRefund } | undefined)?.object;
    if (!object?.id) return;
    await applyRefund(
      { pool: ctx.pool, stripe: ctx.stripe, clock: { now: () => ctx.now } },
      ctx.venueId,
      object.id,
      object.metadata?.["refund_id"] ?? null,
    );
  });

/** A refund as the requester's screen shows it: waiting for the approver, pending, refunded or failed. */
export async function refundView(c: Queryable, venueId: string, refundId: string) {
  const refund = await refundById(c, venueId, refundId);
  if (!refund) throw new ApiError("not_found", "no such refund");
  const approval = refund.approval_id
    ? (
        await c.query<{ status: string; waiting_for: string }>(
          `select a.status, u.name as waiting_for from approvals a join users u on u.id = a.routed_to
            where a.venue_id = $1 and a.id = $2`,
          [venueId, refund.approval_id],
        )
      ).rows[0]
    : undefined;
  return {
    id: refund.id,
    payment_id: refund.payment_id,
    check_id: refund.check_id,
    booking_id: refund.booking_id,
    amount_cents: refund.amount_cents,
    reason: refund.reason,
    status: refund.status,
    state:
      refund.status === "pending" && approval?.status === "pending"
        ? ("waiting_approval" as const)
        : refund.status,
    waiting_for: approval?.status === "pending" ? approval.waiting_for : null,
    failure_reason: refund.failure_reason,
  };
}
