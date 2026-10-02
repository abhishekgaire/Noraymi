import {
  allocate,
  createPayLink,
  enqueue,
  insertPayment,
  latestAttempt,
  paymentById,
  setAllocationState,
  setMitReason,
  setPaymentStatus,
  startAttempt,
  withVenue,
  type Queryable,
} from "@west4/db";
import { Temporal, cents, formatMoney } from "@west4/shared";
import { executors, declineHandlers, requestApproval, TargetGone } from "../approvals/service.js";
import { ApiError } from "../http/errors.js";
import { queueText } from "../texts/queue.js";
import { clockWords } from "../texts/triggers.js";
import type { VenueTextSettings } from "../texts/venue.js";
import { cancelPayment, claimAndRun, enqueueRun, runNow, type PaymentDeps } from "./run.js";
import { sendReceipt, type ReceiptDeps } from "../receipts/send.js";

/**
 * Card on file (M4-17; Payment flows · Room close-out; screens N8): the card
 * that paid the booking's deposit, charged off-session for what's due. Staff
 * ask; the payment waits ("Waiting for Marcus to confirm on his phone ·
 * Cancel") with the amount held, so nobody can take the same money twice. The
 * guest confirms on the bill or the booking link, or, when they've left, a
 * manager approves on their own phone with the requester's reason
 * (`mit_reason`). Either way the charge runs in the `payment.run` job, outside
 * any transaction. A decline releases the amount and texts the guest a pay link
 * for the balance (the Payment link text).
 */
export const ON_FILE_DECLINED_KIND = "payment.on_file_declined";

export interface SavedCard {
  readonly deposit_payment_id: string;
  readonly deposit_pi_id: string;
  readonly brand: string;
  readonly last4: string;
  readonly booking_id: string;
  readonly guest_id: string | null;
  readonly guest_first_name: string | null;
  readonly guest_phone: string | null;
}

/** The card saved by the booking's deposit, if the check has one. */
export async function savedCardFor(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<SavedCard | null> {
  const r = await c.query<SavedCard>(
    `select p.id as deposit_payment_id, p.stripe_pi_id as deposit_pi_id, p.card_brand as brand,
            p.card_last4 as last4, b.id as booking_id, g.id as guest_id,
            split_part(g.name, ' ', 1) as guest_first_name, g.phone_e164 as guest_phone
       from checks k
       join bookings b on b.venue_id = k.venue_id and b.id = k.booking_id
       join payments p on p.venue_id = k.venue_id and p.booking_id = b.id
       left join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
      where k.venue_id = $1 and k.id = $2 and p.method = 'card_online' and p.status = 'captured'
        and p.stripe_pi_id is not null and p.card_brand is not null and p.card_last4 is not null
      order by p.created_at limit 1`,
    [venueId, checkId],
  );
  return r.rows[0] ?? null;
}

/** Staff choose Card on file: a pending payment holding the amount, waiting for the guest. */
export async function askGuest(
  c: Queryable,
  venueId: string,
  input: { checkId: string; amountCents: number; businessDate: string },
): Promise<{ paymentId: string; card: SavedCard }> {
  const card = await savedCardFor(c, venueId, input.checkId);
  if (!card) throw new ApiError("invalid_request", "this check has no card on file");
  const paymentId = await insertPayment(c, venueId, {
    method: "card_on_file",
    status: "pending",
    businessDate: input.businessDate,
    bookingId: card.booking_id,
  });
  // Never more than the amount due: allocate refuses (422 over_amount_due), and the hold stops a second payment.
  await allocate(c, venueId, {
    paymentId,
    checkId: input.checkId,
    amountCents: input.amountCents,
    state: "in_progress",
  });
  return { paymentId, card };
}

interface Waiting {
  readonly paymentId: string;
  readonly checkId: string;
  readonly amountCents: number;
}

/** A card-on-file payment still waiting for its go-ahead: pending, its amount held, no charge tried yet. */
export async function waitingOnFile(
  c: Queryable,
  venueId: string,
  paymentId: string,
): Promise<Waiting | null> {
  const payment = await paymentById(c, venueId, paymentId, true);
  if (!payment || payment.method !== "card_on_file" || payment.status !== "pending") return null;
  if (await latestAttempt(c, venueId, paymentId)) return null;
  const a = await c.query<{ check_id: string; amount_cents: string }>(
    `select check_id, amount_cents from payment_allocations
      where venue_id = $1 and payment_id = $2 and state = 'in_progress' limit 1`,
    [venueId, paymentId],
  );
  const row = a.rows[0];
  return row ? { paymentId, checkId: row.check_id, amountCents: Number(row.amount_cents) } : null;
}

/** The go-ahead (the guest's tap, or a manager's approval): the charge's attempt and its job. */
async function goAhead(
  c: Queryable,
  venueId: string,
  w: Waiting,
  now: Temporal.Instant,
): Promise<number> {
  const { attemptNo } = await startAttempt(c, venueId, {
    paymentId: w.paymentId,
    checkId: w.checkId,
    portionKey: "full",
    action: "off_session",
    amountCents: w.amountCents,
    startedAt: now.toString(),
  });
  await enqueueRun(c, venueId, w.paymentId, attemptNo, now);
  return attemptNo;
}

/** The guest's "Pay with Amex ··1005", on the bill or the booking link, for a payment on their check. */
export async function guestConfirms(
  c: Queryable,
  venueId: string,
  input: { paymentId: string; checkId: string; now: Temporal.Instant },
): Promise<number> {
  const w = await waitingOnFile(c, venueId, input.paymentId);
  if (!w || w.checkId !== input.checkId) throw new ApiError("not_found", "no such payment");
  return goAhead(c, venueId, w, input.now);
}

/** "Ask a manager to approve": the guest has left. Answers 202 approval_pending. */
export async function askManager(
  c: Queryable,
  venueId: string,
  input: {
    paymentId: string;
    reason: string;
    userId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
) {
  if (!(await paymentById(c, venueId, input.paymentId)))
    throw new ApiError("not_found", "no such payment");
  const w = await waitingOnFile(c, venueId, input.paymentId);
  if (!w) throw new ApiError("invalid_request", "this payment isn't waiting for a go-ahead");
  const pending = await c.query(
    `select 1 from approvals where venue_id = $1 and kind = 'card_on_file' and target_id = $2
        and status = 'pending'`,
    [venueId, input.paymentId],
  );
  if (pending.rows[0]) throw new ApiError("in_progress", "a manager is already asked");
  return requestApproval(c, venueId, {
    kind: "card_on_file",
    targetKind: "payment",
    targetId: input.paymentId,
    amountCents: w.amountCents,
    reason: input.reason,
    payload: { payment_id: input.paymentId, check_id: w.checkId },
    requestedBy: input.userId,
    requestedDeviceId: input.deviceId,
    now: input.now,
  });
}

// Approved on the manager's own phone: the reason goes on the payment and the charge runs.
executors.set("card_on_file", async (c, venueId, approval, ctx) => {
  const w = await waitingOnFile(c, venueId, approval.target_id);
  if (!w) throw new TargetGone();
  await setMitReason(c, venueId, w.paymentId, approval.reason);
  await goAhead(c, venueId, w, ctx.at);
});

// Declined: nothing is charged, and the amount it held is free again.
declineHandlers.set("card_on_file", async (c, venueId, approval) => {
  const w = await waitingOnFile(c, venueId, approval.target_id);
  if (!w) return;
  await setPaymentStatus(c, venueId, w.paymentId, "canceled", "api");
  await setAllocationState(c, venueId, w.paymentId, "in_progress", "released");
});

/** "Fri Sep 25", as the texts write a date. */
function dateWords(at: Temporal.Instant, timeZone: string): string {
  const z = at.toZonedDateTimeISO(timeZone);
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
  return `${days[z.dayOfWeek - 1]} ${months[z.month - 1]} ${z.day}`;
}

/** Queued in the transaction that records a decline; the follow-up runs after it. */
export async function enqueueDeclined(
  c: Queryable,
  venueId: string,
  paymentId: string,
  now: Temporal.Instant,
) {
  await enqueue(c, {
    venueId,
    kind: ON_FILE_DECLINED_KIND,
    pool: "critical",
    dedupeKey: `${ON_FILE_DECLINED_KIND}:${paymentId}`,
    payload: { payment_id: paymentId },
    runAt: now,
    maxAttempts: 3,
  });
}

/**
 * After a decline: the payment is cancelled (at Stripe too, so its PaymentIntent can't be paid later),
 * which frees the amount, and the guest is texted a pay link for the balance on the payment page.
 */
export async function followUpDecline(
  deps: PaymentDeps & {
    payAppUrl: string | null;
    texts: Pick<VenueTextSettings, "allowList">;
  },
  venueId: string,
  paymentId: string,
): Promise<{ texted: boolean }> {
  await cancelPayment(deps, venueId, paymentId, "api");
  const now = deps.clock.now();
  return withVenue(
    deps.pool,
    { venueId, requestId: `payment:${paymentId}:declined` },
    async (c) => {
      const check = (
        await c.query<{ check_id: string }>(
          "select check_id from payment_allocations where venue_id = $1 and payment_id = $2 limit 1",
          [venueId, paymentId],
        )
      ).rows[0];
      if (!check || !deps.payAppUrl) return { texted: false };
      const due = Number(
        (await c.query<{ due: string }>("select amount_due($1) as due", [check.check_id])).rows[0]!
          .due,
      );
      const card = await savedCardFor(c, venueId, check.check_id);
      if (due <= 0 || !card?.guest_phone) return { texted: false };
      const link = await createPayLink(c, venueId, {
        checkId: check.check_id,
        amountCents: due,
        expiresAt: now.add({ hours: 24 }).toString(),
        purpose: "balance",
      });
      const where = (
        await c.query<{
          venue: string;
          room: string | null;
          party: number;
          starts_at: string;
          time_zone: string;
        }>(
          `select v.name as venue, r.name as room, b.party_size as party,
                to_json(b.starts_at) #>> '{}' as starts_at, v.time_zone
           from bookings b join venues v on v.id = b.venue_id
           left join rooms r on r.venue_id = b.venue_id and r.id = b.room_id
          where b.venue_id = $1 and b.id = $2`,
          [venueId, card.booking_id],
        )
      ).rows[0]!;
      const at = Temporal.Instant.from(where.starts_at);
      await queueText(
        c,
        venueId,
        {
          templateKey: "payment_link",
          to: card.guest_phone,
          params: {
            venue: where.venue,
            room: where.room ?? "room",
            party: where.party,
            date: dateWords(at, where.time_zone),
            time: clockWords(at, where.time_zone),
            amount: formatMoney("en", cents(due)),
            link: `${deps.payAppUrl}/pay/${link.token}`,
          },
          guestId: card.guest_id,
          context: { kind: "booking", id: card.booking_id },
          sentBy: null,
          now,
        },
        deps.texts,
      );
      return { texted: true };
    },
  );
}

/**
 * Runs a card-on-file charge here and now, and its decline follow-up if it declined, so the screens
 * hear at once (the worker runs the same jobs if this process can't).
 */
export async function chargeNow(
  deps: PaymentDeps & {
    payAppUrl: string | null;
    texts: Pick<VenueTextSettings, "allowList">;
    receipts?: ReceiptDeps;
  },
  venueId: string,
  paymentId: string,
  attemptNo: number,
): Promise<void> {
  await runNow(deps, venueId, paymentId, attemptNo);
  await claimAndRun(deps, venueId, `${ON_FILE_DECLINED_KIND}:${paymentId}`, () =>
    followUpDecline(deps, venueId, paymentId),
  );
  const receipts = deps.receipts;
  if (!receipts) return;
  // Charged: an itemized receipt is texted at once (Payment flows · Card on file; M4-19).
  await withVenue(deps.pool, { venueId, requestId: `payment:${paymentId}:receipt` }, async (c) => {
    const payment = await paymentById(c, venueId, paymentId);
    if (payment?.status !== "captured") return;
    const check = (
      await c.query<{ check_id: string }>(
        "select check_id from payment_allocations where venue_id = $1 and payment_id = $2 limit 1",
        [venueId, paymentId],
      )
    ).rows[0];
    const card = check ? await savedCardFor(c, venueId, check.check_id) : null;
    if (!check || !card?.guest_phone) return;
    await sendReceipt(c, venueId, receipts, {
      checkId: check.check_id,
      to: { channel: "text", to: card.guest_phone },
      paymentId,
      sentBy: null,
      now: deps.clock.now(),
    });
  }).catch(() => undefined); // A text that can't go out never undoes the payment; staff can send it again.
}
