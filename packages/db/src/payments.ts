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
    `insert into payments (id, venue_id, method, status, business_date, adjusts_business_date, amount_cents,
       tip_cents, booking_id, stripe_pi_id, tendered_cents, change_cents, drawer_session_id, staff_bank_id,
       mit_reason, training)
     values (coalesce($1, gen_random_uuid()), $2, $3, $4, open_business_date($2, $5::date),
       nullif($5::date, open_business_date($2, $5::date)), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
 * What the check owes beside the tab holds on it (M6-13; Money rules 12): a bar tab's own hold, or the
 * holds of tabs moved into a room, are guarantees following the lines, so they're left out. Locks the row.
 */
export async function amountDueBesideHolds(c: Queryable, checkId: string): Promise<number> {
  const r = await c.query<{ due: string }>("select amount_due_beside_holds($1) as due", [checkId]);
  return Number(r.rows[0]!.due);
}

/** What a check owes: beside the holds of tabs moved into it, when it's a room holding some (M6-13). */
export async function checkDue(c: Queryable, venueId: string, checkId: string): Promise<number> {
  return (await hasMovedHolds(c, venueId, checkId))
    ? amountDueBesideHolds(c, checkId)
    : amountDue(c, checkId);
}

/** Whether a room's check holds the hold of a tab moved into it (M6-13; Money rules 12). */
export async function hasMovedHolds(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<boolean> {
  const r = await c.query(
    `select 1 from payment_allocations a join tabs t on t.venue_id = a.venue_id and t.payment_id = a.payment_id
      where a.venue_id = $1 and a.check_id = $2 and a.state = 'in_progress' and a.follows_lines
        and t.check_id <> a.check_id limit 1`,
    [venueId, checkId],
  );
  return (r.rowCount ?? 0) > 0;
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
    /** A payment whose allocation doesn't count against what's due (a bar tab's hold while a split share is paid, M6-10). */
    leaveOut?: string | null;
    /** Every tab hold on the check is left out; by default, when it's a room holding moved holds (M6-13). */
    besideHolds?: boolean;
  },
): Promise<string> {
  if (!Number.isInteger(a.amountCents) || a.amountCents <= 0)
    throw new Error("an allocation is a positive whole number of cents");
  // A room holding a moved tab's hold (M6-13): paying it replaces the hold, so the hold is left out.
  const beside = a.besideHolds ?? (!a.leaveOut && (await hasMovedHolds(c, venueId, a.checkId)));
  const due = beside
    ? await amountDueBesideHolds(c, a.checkId)
    : await amountDue(c, a.checkId, a.leaveOut ?? null);
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
  /** The venue's clock when it starts (the simulated one in demos and tests), never the database's. */
  readonly startedAt?: string;
  /** Named in the key after the attempt number: an increment's target amount (Stripe setup 5, M6-07). */
  readonly keySuffix?: string;
}

/**
 * A new attempt, numbered after the payment's last; its key is `<payment_id>:<action>:<attempt_no>`,
 * and an increment's also names its target amount (`<payment_id>:increment:<attempt_no>:<cents>`).
 */
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
  const idemKey = `${a.paymentId}:${a.action}:${attemptNo}${a.keySuffix ? `:${a.keySuffix}` : ""}`;
  try {
    await c.query("savepoint one_open_attempt");
    await c.query(
      `insert into payment_attempts (venue_id, payment_id, attempt_no, check_id, booking_id, portion_key, action,
         reader_id, idem_key, amount_cents, state, started_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'started', coalesce($11::timestamptz, now()))`,
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
        a.startedAt ?? null,
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

export interface PaymentRow {
  readonly id: string;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly stripe_pi_id: string | null;
  readonly amount_cents: number;
  readonly tip_cents: number;
  /** A card surcharge the card paid on top (M4-25). */
  readonly surcharge_cents: number;
  readonly authorized_cents: number | null;
  readonly card_brand: string | null;
  readonly card_last4: string | null;
  readonly business_date: string;
  readonly booking_id: string | null;
  readonly training: boolean;
  readonly created_at: string;
}

export interface AttemptRow {
  readonly attempt_no: number;
  readonly check_id: string | null;
  readonly booking_id: string | null;
  readonly portion_key: string;
  readonly action: string;
  readonly reader_id: string | null;
  readonly idem_key: string;
  readonly amount_cents: number;
  readonly state: "started" | "unknown" | "succeeded" | "failed" | "canceled";
  readonly decline_code: string | null;
  readonly started_at: string;
  readonly resolved_at: string | null;
}

const PAYMENT_COLS = `id, method, status, stripe_pi_id, amount_cents::int, tip_cents::int,
  surcharge_cents::int, authorized_cents::int, card_brand, card_last4, business_date::text, booking_id, training,
  to_json(created_at) #>> '{}' as created_at`;

/** A payment of this venue; `lock` holds its row for the state machine. */
export async function paymentById(
  c: Queryable,
  venueId: string,
  id: string,
  lock = false,
): Promise<PaymentRow | null> {
  const r = await c.query<PaymentRow>(
    `select ${PAYMENT_COLS} from payments where venue_id = $1 and id = $2${lock ? " for update" : ""}`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** The venue's payment behind a PaymentIntent: by Stripe's id, never by metadata. */
export async function paymentByIntent(
  c: Queryable,
  venueId: string,
  piId: string,
): Promise<PaymentRow | null> {
  const r = await c.query<PaymentRow>(
    `select ${PAYMENT_COLS} from payments where venue_id = $1 and stripe_pi_id = $2`,
    [venueId, piId],
  );
  return r.rows[0] ?? null;
}

export async function latestAttempt(
  c: Queryable,
  venueId: string,
  paymentId: string,
): Promise<AttemptRow | null> {
  const r = await c.query<AttemptRow>(
    `select attempt_no, check_id, booking_id, portion_key, action, reader_id, idem_key, amount_cents::int, state,
            decline_code, to_json(started_at) #>> '{}' as started_at, to_json(resolved_at) #>> '{}' as resolved_at
       from payment_attempts where venue_id = $1 and payment_id = $2 order by attempt_no desc limit 1`,
    [venueId, paymentId],
  );
  return r.rows[0] ?? null;
}

export async function setAttemptState(
  c: Queryable,
  venueId: string,
  paymentId: string,
  attemptNo: number,
  state: AttemptRow["state"],
  declineCode: string | null = null,
): Promise<void> {
  await c.query(
    `update payment_attempts set state = $4, decline_code = coalesce($5, decline_code),
            resolved_at = case when $4 in ('succeeded', 'failed', 'canceled') then now() else resolved_at end
      where venue_id = $1 and payment_id = $2 and attempt_no = $3`,
    [venueId, paymentId, attemptNo, state, declineCode],
  );
}

/** The checks a payment is allocated to. */
export async function allocatedChecks(
  c: Queryable,
  venueId: string,
  paymentId: string,
): Promise<string[]> {
  const r = await c.query<{ check_id: string }>(
    "select distinct check_id from payment_allocations where venue_id = $1 and payment_id = $2",
    [venueId, paymentId],
  );
  return r.rows.map((x) => x.check_id);
}

export async function setPaymentIntent(
  c: Queryable,
  paymentId: string,
  piId: string,
): Promise<void> {
  await c.query("select set_payment_intent($1, $2)", [paymentId, piId]);
}

export async function setPaymentCard(
  c: Queryable,
  venueId: string,
  paymentId: string,
  card: {
    brand: string | null;
    last4: string | null;
    funding: string | null;
    generatedCard: string | null;
  },
): Promise<void> {
  await c.query(
    `update payments set card_brand = coalesce($3, card_brand), card_last4 = coalesce($4, card_last4),
            card_funding = coalesce($5, card_funding), generated_card_pm = coalesce($6, generated_card_pm)
      where venue_id = $1 and id = $2`,
    [venueId, paymentId, card.brand, card.last4, card.funding, card.generatedCard],
  );
}

/**
 * Check-in applies the booking's deposit (M4-09; Money rules 11): each captured payment of the booking
 * that isn't allocated yet goes onto the check, following the check's lines up to its amount, so the
 * check never shows a negative amount due. Returns the cents applied.
 */
export async function applyDeposits(
  c: Queryable,
  venueId: string,
  input: { bookingId: string; checkId: string },
): Promise<number> {
  const r = await c.query<{ id: string }>(
    `select p.id from payments p
      where p.venue_id = $1 and p.booking_id = $2
        and not exists (select 1 from payment_allocations a where a.venue_id = p.venue_id and a.payment_id = p.id
                         and a.state <> 'released')`,
    [venueId, input.bookingId],
  );
  const free = new Set(r.rows.map((x) => x.id));
  let applied = 0;
  // A deposit partly refunded before check-in (M5-11: a smaller party before the cut-off) applies what's left.
  for (const p of await heldDeposits(c, venueId, input.bookingId)) {
    if (!free.has(p.payment_id) || p.held_cents <= 0) continue;
    await allocate(c, venueId, {
      paymentId: p.payment_id,
      checkId: input.checkId,
      amountCents: p.held_cents,
      state: "captured",
      followsLines: true,
    });
    applied += p.held_cents;
  }
  return applied;
}

/**
 * What a booking's guest holds with us as a deposit (M5-11; Money rules 11): each captured (or partly
 * refunded) payment of the booking less its refunds made or on their way, oldest first.
 */
export async function heldDeposits(
  c: Queryable,
  venueId: string,
  bookingId: string,
): Promise<{ payment_id: string; method: string; held_cents: number }[]> {
  const r = await c.query<{ payment_id: string; method: string; held_cents: string }>(
    `select p.id as payment_id, p.method,
            (p.amount_cents - coalesce((select sum(f.amount_cents) from refunds f
                                         where f.venue_id = p.venue_id and f.payment_id = p.id
                                           and f.status in ('pending', 'succeeded')), 0))::text as held_cents
       from payments p
      where p.venue_id = $1 and p.booking_id = $2 and p.status in ('captured', 'partly_refunded')
        and p.amount_cents > 0
      order by p.created_at, p.id`,
    [venueId, bookingId],
  );
  return r.rows.map((x) => ({ ...x, held_cents: Number(x.held_cents) }));
}

/** The deposits on a check: each deposit payment's live allocation there (captured, following the lines). */
export async function depositsOn(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<
  { payment_id: string; allocation_id: string; amount_cents: number; booking_id: string }[]
> {
  const r = await c.query<{
    payment_id: string;
    allocation_id: string;
    amount_cents: string;
    booking_id: string;
  }>(
    `select a.payment_id, a.id as allocation_id, a.amount_cents, p.booking_id
       from payment_allocations a join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
      where a.venue_id = $1 and a.check_id = $2 and a.state = 'captured' and a.follows_lines
        and a.kind = 'payment' and p.booking_id is not null
      order by a.created_at, a.id`,
    [venueId, checkId],
  );
  return r.rows.map((x) => ({ ...x, amount_cents: Number(x.amount_cents) }));
}

/** Releases one allocation (its money goes elsewhere in the same transaction). */
export async function releaseAllocation(
  c: Queryable,
  venueId: string,
  allocationId: string,
): Promise<void> {
  await c.query(
    "update payment_allocations set state = 'released' where venue_id = $1 and id = $2 and state <> 'released'",
    [venueId, allocationId],
  );
}

/** The reason a saved card was charged without the guest (M4-17), written when a manager approves. */
export async function setMitReason(
  c: Queryable,
  venueId: string,
  paymentId: string,
  reason: string,
): Promise<void> {
  await c.query("update payments set mit_reason = $3 where venue_id = $1 and id = $2", [
    venueId,
    paymentId,
    reason,
  ]);
}
