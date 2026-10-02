import type { Queryable } from "./tenancy.js";

/** Refunds (M4-21): one row per payment a refund comes off, with its Stripe refund and status. */
export type RefundStatus = "pending" | "succeeded" | "failed" | "canceled";
export interface RefundRow {
  readonly id: string;
  readonly payment_id: string;
  readonly check_id: string | null;
  readonly booking_id: string | null;
  readonly amount_cents: number;
  readonly reason: string;
  readonly status: RefundStatus;
  readonly n: number;
  readonly stripe_refund_id: string | null;
  readonly failure_reason: string | null;
  readonly requested_by: string;
  readonly approval_id: string | null;
  readonly approved_by: string | null;
  readonly business_date: string;
}

const COLS = `id, payment_id, check_id, booking_id, amount_cents::int as amount_cents, reason, status, n,
  stripe_refund_id, failure_reason, requested_by, approval_id, approved_by, business_date::text`;

export async function insertRefund(
  c: Queryable,
  venueId: string,
  r: {
    id: string;
    paymentId: string;
    checkId: string | null;
    bookingId: string | null;
    amountCents: number;
    reason: string;
    requestedBy: string;
    approvalId: string | null;
    businessDate: string;
    adjustsBusinessDate: string | null;
    requestedAt: string;
  },
): Promise<void> {
  await c.query(
    `insert into refunds (id, venue_id, payment_id, check_id, booking_id, amount_cents, reason, n, requested_by,
       approval_id, business_date, adjusts_business_date, requested_at)
     values ($1, $2, $3, $4, $5, $6, $7,
       (select coalesce(max(n), 0) + 1 from refunds where venue_id = $2 and payment_id = $3),
       $8, $9, $10, $11, $12)`,
    [
      r.id,
      venueId,
      r.paymentId,
      r.checkId,
      r.bookingId,
      r.amountCents,
      r.reason,
      r.requestedBy,
      r.approvalId,
      r.businessDate,
      r.adjustsBusinessDate,
      r.requestedAt,
    ],
  );
}

export async function refundById(
  c: Queryable,
  venueId: string,
  id: string,
  forUpdate = false,
): Promise<RefundRow | null> {
  const r = await c.query<RefundRow>(
    `select ${COLS} from refunds where venue_id = $1 and id = $2${forUpdate ? " for update" : ""}`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

export async function refundByStripeId(
  c: Queryable,
  venueId: string,
  stripeRefundId: string,
): Promise<RefundRow | null> {
  const r = await c.query<RefundRow>(
    `select ${COLS} from refunds where venue_id = $1 and stripe_refund_id = $2`,
    [venueId, stripeRefundId],
  );
  return r.rows[0] ?? null;
}

export async function refundsOfApproval(
  c: Queryable,
  venueId: string,
  approvalId: string,
): Promise<RefundRow[]> {
  const r = await c.query<RefundRow>(
    `select ${COLS} from refunds where venue_id = $1 and approval_id = $2 order by n, id`,
    [venueId, approvalId],
  );
  return r.rows;
}

/** What's been given back or is on its way back from a payment: pending and succeeded refunds. */
export async function refundedOf(c: Queryable, venueId: string, paymentId: string) {
  const r = await c.query<{ s: string }>(
    `select coalesce(sum(amount_cents), 0) as s from refunds
      where venue_id = $1 and payment_id = $2 and status in ('pending', 'succeeded')`,
    [venueId, paymentId],
  );
  return Number(r.rows[0]!.s);
}

/** Moves a refund on; a finished refund (succeeded, failed or canceled) never moves again. */
export async function setRefundStatus(
  c: Queryable,
  venueId: string,
  id: string,
  to: {
    status: RefundStatus;
    stripeRefundId?: string | null;
    failureReason?: string | null;
    approvedBy?: string | null;
    at: string;
  },
): Promise<boolean> {
  const r = await c.query(
    `update refunds set status = $3,
            stripe_refund_id = coalesce($4, stripe_refund_id),
            failure_reason = coalesce($5, failure_reason),
            approved_by = coalesce($6, approved_by),
            resolved_at = case when $3 = 'pending' then resolved_at else $7::timestamptz end
      where venue_id = $1 and id = $2 and status = 'pending'`,
    [
      venueId,
      id,
      to.status,
      to.stripeRefundId ?? null,
      to.failureReason ?? null,
      to.approvedBy ?? null,
      to.at,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}
