import type { Queryable } from "./tenancy.js";

/**
 * Payments (M4-04; Data model · the money core; Money rules 11 and 12).
 * Inside a venue transaction. A payment's amounts move only through the
 * definer functions (`recordAuthorization`, `recordCapture`, `setTip`); its
 * status moves through `setPaymentStatus`, which writes the payment_events
 * row. Every allocation of a payment to a check checks `amount_due` in the
 * same transaction, with the check row locked, and refuses more than it.
 */
export type PaymentMethod =
  "card_present" | "card_online" | "card_on_file" | "cash" | "external" | "prepaid";
export type PaymentStatus =
  | "pending"
  | "requires_action"
  | "authorized"
  | "captured"
  | "capture_failed"
  | "partly_refunded"
  | "refunded"
  | "canceled"
  | "failed";
export type PaymentSource = "api" | "webhook" | "reconciler";

/** More than the check still owes (422 over_amount_due). */
export class OverAmountDue extends Error {
  constructor(
    readonly dueCents: number,
    readonly askedCents: number,
  ) {
    super(`only ${dueCents} cents are due; ${askedCents} asked`);
    this.name = "OverAmountDue";
  }
}

/** Another unfinished attempt holds this check's portion (one_open_attempt). */
export class AttemptOpen extends Error {
  constructor() {
    super("another payment for this is still going");
    this.name = "AttemptOpen";
  }
}

export interface NewPayment {
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly businessDate: string;
  readonly amountCents?: number;
  readonly tipCents?: number;
  readonly bookingId?: string | null;
  readonly stripePiId?: string | null;
  readonly tenderedCents?: number | null;
  readonly changeCents?: number | null;
  readonly drawerSessionId?: string | null;
  readonly staffBankId?: string | null;
  readonly mitReason?: string | null;
  readonly training?: boolean;
  readonly id?: string;
}

export async function insertPayment(c: Queryable, venueId: string, p: NewPayment): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into payments (id, venue_id, method, status, business_date, amount_cents, tip_cents, booking_id,
       stripe_pi_id, tendered_cents, change_cents, drawer_session_id, staff_bank_id, mit_reason, training)
     values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning id`,
    [
      p.id ?? null,
      venueId,
      p.method,
      p.status,
      p.businessDate,
      p.amountCents ?? 0,
      p.tipCents ?? 0,
      p.bookingId ?? null,
      p.stripePiId ?? null,
      p.tenderedCents ?? null,
      p.changeCents ?? null,
      p.drawerSessionId ?? null,
      p.staffBankId ?? null,
      p.mitReason ?? null,
      p.training ?? false,
    ],
  );
  await c.query(
    `insert into payment_events (venue_id, payment_id, from_status, to_status, source) values ($1, $2, null, $3, 'api')`,
    [venueId, r.rows[0]!.id, p.status],
  );
  return r.rows[0]!.id;
}

/** What the check still owes, locking its row until the transaction ends. `leaveOut` leaves one payment out (a tab's own hold). */
export async function amountDue(
  c: Queryable,
  checkId: string,
  leaveOut: string | null = null,
): Promise<number> {
  const r = await c.query<{ due: string }>("select amount_due($1, $2) as due", [checkId, leaveOut]);
  return Number(r.rows[0]!.due);
}

/**
 * Puts some of a payment on a check. A payment allocation may not be more
 * than the amount due (tips are never allocated, so they're aside); a
 * deposit or a tab hold follows the lines instead and is never refused.
 */
export async function allocate(
  c: Queryable,
  venueId: string,
  a: {
    paymentId: string;
    checkId: string;
    amountCents: number;
    state: "in_progress" | "captured";
    followsLines?: boolean;
    shareId?: string | null;
    roomGuestId?: string | null;
  },
): Promise<string> {
  if (!Number.isInteger(a.amountCents) || a.amountCents <= 0)
    throw new Error("an allocation is a positive whole number of cents");
  const due = await amountDue(c, a.checkId);
  if (!a.followsLines && a.amountCents > due) throw new OverAmountDue(due, a.amountCents);
  const r = await c.query<{ id: string }>(
    `insert into payment_allocations (venue_id, payment_id, check_id, amount_cents, kind, state, follows_lines,
       share_id, room_guest_id)
     values ($1, $2, $3, $4, 'payment', $5, $6, $7, $8) returning id`,
    [
      venueId,
      a.paymentId,
      a.checkId,
      a.amountCents,
      a.state,
      a.followsLines ?? false,
      a.shareId ?? null,
      a.roomGuestId ?? null,
    ],
  );
  return r.rows[0]!.id;
}

export async function setAllocationState(
  c: Queryable,
  venueId: string,
  paymentId: string,
  from: "in_progress" | "captured",
  to: "captured" | "released",
): Promise<number> {
  const r = await c.query(
    "update payment_allocations set state = $4 where venue_id = $1 and payment_id = $2 and state = $3",
    [venueId, paymentId, from, to],
  );
  return r.rowCount ?? 0;
}

export interface NewAttempt {
  readonly paymentId: string;
  readonly checkId?: string | null;
  readonly bookingId?: string | null;
  readonly portionKey: string;
  readonly action: string;
  readonly readerId?: string | null;
  readonly amountCents: number;
}

/** A new attempt, numbered after the payment's last; its key is `<payment_id>:<action>:<attempt_no>`. */
export async function startAttempt(
  c: Queryable,
  venueId: string,
  a: NewAttempt,
): Promise<{ attemptNo: number; idemKey: string }> {
  const n = await c.query<{ n: number }>(
    "select coalesce(max(attempt_no), 0) + 1 as n from payment_attempts where venue_id = $1 and payment_id = $2",
    [venueId, a.paymentId],
  );
  const attemptNo = n.rows[0]!.n;
  const idemKey = `${a.paymentId}:${a.action}:${attemptNo}`;
  try {
    await c.query("savepoint one_open_attempt");
    await c.query(
      `insert into payment_attempts (venue_id, payment_id, attempt_no, check_id, booking_id, portion_key, action,
         reader_id, idem_key, amount_cents, state)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'started')`,
      [
        venueId,
        a.paymentId,
        attemptNo,
        a.checkId ?? null,
        a.bookingId ?? null,
        a.portionKey,
        a.action,
        a.readerId ?? null,
        idemKey,
        a.amountCents,
      ],
    );
    await c.query("release savepoint one_open_attempt");
  } catch (e) {
    await c.query("rollback to savepoint one_open_attempt");
    if ((e as { constraint?: string }).constraint === "one_open_attempt") throw new AttemptOpen();
    throw e;
  }
  return { attemptNo, idemKey };
}

/** Moves a payment's status and records the move. Returns the status it had, or null if there's no such payment. */
export async function setPaymentStatus(
  c: Queryable,
  venueId: string,
  paymentId: string,
  to: PaymentStatus,
  source: PaymentSource,
  stripeEventId: string | null = null,
): Promise<PaymentStatus | null> {
  const before = await c.query<{ status: PaymentStatus }>(
    "select status from payments where venue_id = $1 and id = $2 for update",
    [venueId, paymentId],
  );
  const from = before.rows[0]?.status;
  if (!from) return null;
  if (from === to) return from;
  await c.query("update payments set status = $3 where venue_id = $1 and id = $2", [
    venueId,
    paymentId,
    to,
  ]);
  await c.query(
    `insert into payment_events (venue_id, payment_id, from_status, to_status, source, stripe_event_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [venueId, paymentId, from, to, source, stripeEventId],
  );
  return from;
}

export async function recordAuthorization(
  c: Queryable,
  paymentId: string,
  authorizedCents: number,
): Promise<void> {
  await c.query("select record_authorization($1, $2)", [paymentId, authorizedCents]);
}

export async function recordCapture(
  c: Queryable,
  paymentId: string,
  a: { amountCents: number; tipCents: number; surchargeCents: number },
): Promise<void> {
  await c.query("select record_capture($1, $2, $3, $4)", [
    paymentId,
    a.amountCents,
    a.tipCents,
    a.surchargeCents,
  ]);
}

export async function setTip(c: Queryable, paymentId: string, tipCents: number): Promise<void> {
  await c.query("select set_tip($1, $2)", [paymentId, tipCents]);
}
