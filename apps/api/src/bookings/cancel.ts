import { randomUUID } from "node:crypto";
import {
  addCheckLine,
  allocate,
  emitEvent,
  enqueue,
  heldDeposits,
  insertCheck,
  insertPayment,
  insertRefund,
  readSetting,
  releaseBlock,
  setMitReason,
  setPaymentStatus,
  startAttempt,
  type Queryable,
} from "@west4/db";
import {
  billableGuestsOn,
  businessDate,
  cancelOutcome,
  hourlyCentsFor,
  noShowOutcome,
} from "@west4/rules";
import { Temporal, type DepositRule } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { enqueueDeclined, savedCardFor } from "../payments/card-on-file.js";
import { REFUND_RUN_KIND } from "../payments/refunds.js";
import { enqueueRun } from "../payments/run.js";
import { settleCheck } from "../rooms/present.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Cancelling, no-shows and the venue cancelling (M5-12; Payment flows ·
 * Deposit when booking online, steps 4 and 6; Money rules 11 and 16).
 *   - The guest cancels on the manage page: before the refund cut-off the
 *     deposit comes back in full; after it the accepted policy keeps it,
 *     refunds half or refunds it.
 *   - Staff mark a no-show after the grace: the accepted policy keeps the
 *     deposit, charges up to the first hour in total off-session on the saved
 *     card (a failed charge texts the guest a pay link), or, the flagged
 *     cautious default for "nothing", refunds it.
 *   - A blocked date cancels its bookings and refunds each in full.
 * A refund is automatic: the policy decides it, so no one approves it, and the
 * `refund.run` job sends it to Stripe outside any transaction. A kept amount is
 * a `forfeit` line on a `fee` check with the next check number, paid from the
 * deposit. Everything here is written in the caller's transaction.
 */
export const REFUND_CANCELLED = "Cancelled before the refund cut-off";
export const REFUND_LATE_HALF = "Cancelled after the refund cut-off: half back, by the policy";
export const REFUND_LATE_POLICY = "Cancelled after the refund cut-off: refunded, by the policy";
export const REFUND_VENUE = "The venue cancelled";
export const REFUND_NO_SHOW = "No-show: refunded, by the policy";
export const REFUND_NO_SHOW_EXCESS = "No-show: more than the first hour held";
export const MIT_NO_SHOW = "No-show, as the accepted deposit policy says";

const refuse = (reason: string, message: string) =>
  new ApiError("invalid_request", message, { details: { reason } });

/**
 * The deposit rule the guest accepted (step 4: "follow the accepted policy version"): the deposit setting
 * in force when the policy version they accepted was published, since its text is written from that
 * setting. A booking with no acceptance (a staff or imported booking) follows the setting for its night.
 */
export async function acceptedRule(
  c: Queryable,
  venueId: string,
  booking: { policy_version_id: string | null; business_date: string },
): Promise<DepositRule | null> {
  if (booking.policy_version_id) {
    const r = await c.query<{ value: DepositRule }>(
      `select s.value from venue_settings s
        where s.venue_id = $1 and s.key = 'deposit'
          and s.saved_at <= (select p.published_at from policy_versions p where p.venue_id = $1 and p.id = $2)
        order by s.version desc limit 1`,
      [venueId, booking.policy_version_id],
    );
    if (r.rows[0]) return r.rows[0].value;
  }
  return (
    (await readSetting(c, venueId, "deposit", Temporal.PlainDate.from(booking.business_date)))
      ?.value ?? null
  );
}

/** The business date money moved now posts to: today's, or the next open one after a close (rule 16). */
async function openDate(c: Queryable, venueId: string, now: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const today = businessDate(now, venue.timeZone, venue.dayCutover).businessDate.toString();
  return (
    await c.query<{ d: string }>("select open_business_date($1, $2::date)::text as d", [
      venueId,
      today,
    ])
  ).rows[0]!.d;
}

/**
 * Refunds `cents` of a booking's deposit by rule, newest card payment first, each through the refund
 * job. A deposit paid through the old system (an imported `external` payment, M9-02) is refunded there
 * by staff, so the part this can't send is returned as `manualCents`, or refused when `strict`.
 */
export async function refundHeld(
  c: Queryable,
  venueId: string,
  bookingId: string,
  cents: number,
  reason: string,
  now: Temporal.Instant,
  options: { strict: boolean },
): Promise<{ refundedCents: number; manualCents: number }> {
  if (cents <= 0) return { refundedCents: 0, manualCents: 0 };
  const card = (await heldDeposits(c, venueId, bookingId))
    .filter((p) => p.method === "card_online" && p.held_cents > 0)
    .reverse();
  const reachable = card.reduce((s, p) => s + p.held_cents, 0);
  if (reachable < cents && options.strict)
    throw refuse("call_venue", "call the venue to change this booking");
  const night = await openDate(c, venueId, now);
  let left = Math.min(cents, reachable);
  for (const p of card) {
    if (left === 0) break;
    const amount = Math.min(left, p.held_cents);
    const refundId = randomUUID();
    await insertRefund(c, venueId, {
      id: refundId,
      paymentId: p.payment_id,
      checkId: null,
      bookingId,
      amountCents: amount,
      reason,
      requestedBy: null,
      automatic: true,
      approvalId: null,
      businessDate: night,
      adjustsBusinessDate: null,
      requestedAt: now.toString(),
    });
    await enqueue(c, {
      venueId,
      kind: REFUND_RUN_KIND,
      pool: "critical",
      dedupeKey: `${REFUND_RUN_KIND}:${refundId}`,
      payload: { refund_id: refundId },
      runAt: now,
      maxAttempts: 5,
    });
    left -= amount;
  }
  const refunded = Math.min(cents, reachable);
  return { refundedCents: refunded, manualCents: cents - refunded };
}

/**
 * The kept part (and a no-show's charge) as `forfeit` lines on a `fee` check with the next check
 * number, paid from the deposit, oldest payment first. A charge is a card-on-file payment on the fee
 * check, run off-session by the `payment.run` job; without a saved card it goes straight to the
 * decline follow-up, which texts the guest a pay link.
 */
async function keepOnFeeCheck(
  c: Queryable,
  venueId: string,
  input: {
    bookingId: string;
    keptCents: number;
    chargeCents: number;
    userId: string | null;
    now: Temporal.Instant;
  },
): Promise<string | null> {
  const { keptCents: kept, chargeCents: charge } = input;
  if (kept + charge <= 0) return null;
  const night = await openDate(c, venueId, input.now);
  const n = await c.query<{ number: string }>(
    "update venue_counters set next = next + 1 where venue_id = $1 and name = 'check' returning next - 1 as number",
    [venueId],
  );
  const feeId = await insertCheck(c, {
    venueId,
    number: Number(n.rows[0]!.number),
    kind: "fee",
    businessDate: night,
    bookingId: input.bookingId,
    openedBy: input.userId,
    openedAt: input.now.toString(),
  });
  const line = (description: string, cents: number) =>
    addCheckLine(c, venueId, feeId, {
      kind: "forfeit",
      description,
      qty: 1,
      unitCents: cents,
      amountCents: cents,
      taxCategory: "fee",
      businessDate: night,
      addedBy: input.userId,
      addedAt: input.now.toString(),
    });
  if (kept > 0) await line("Deposit kept", kept);
  if (charge > 0) await line("No-show charge", charge);
  let left = kept;
  for (const p of await heldDeposits(c, venueId, input.bookingId)) {
    if (left === 0) break;
    const amount = Math.min(left, p.held_cents);
    if (amount <= 0) continue;
    await allocate(c, venueId, {
      paymentId: p.payment_id,
      checkId: feeId,
      amountCents: amount,
      state: "captured",
      followsLines: true,
    });
    left -= amount;
  }
  await settleCheck(c, venueId, feeId, input.now);
  if (charge > 0) {
    const paymentId = await insertPayment(c, venueId, {
      method: "card_on_file",
      status: "pending",
      businessDate: night,
      bookingId: input.bookingId,
    });
    await setMitReason(c, venueId, paymentId, MIT_NO_SHOW);
    await allocate(c, venueId, {
      paymentId,
      checkId: feeId,
      amountCents: charge,
      state: "in_progress",
    });
    if (await savedCardFor(c, venueId, feeId)) {
      const { attemptNo } = await startAttempt(c, venueId, {
        paymentId,
        checkId: feeId,
        portionKey: "full",
        action: "off_session",
        amountCents: charge,
        startedAt: input.now.toString(),
      });
      await enqueueRun(c, venueId, paymentId, attemptNo, input.now);
    } else await enqueueDeclined(c, venueId, paymentId, input.now);
  }
  return feeId;
}

/** A difference still unpaid (M5-11) goes with the booking; one already at Stripe is refunded if it lands. */
async function dropPendingTopUps(c: Queryable, venueId: string, bookingId: string) {
  const r = await c.query<{ id: string }>(
    `select id from payments where venue_id = $1 and booking_id = $2 and method = 'card_online'
        and status = 'pending' and stripe_pi_id is null`,
    [venueId, bookingId],
  );
  for (const p of r.rows) await setPaymentStatus(c, venueId, p.id, "canceled", "api");
}

async function releaseRoom(c: Queryable, venueId: string, bookingId: string, roomId: string) {
  const blocks = await c.query<{ id: string }>(
    "select id from room_blocks where venue_id = $1 and ref_id = $2 and kind in ('booking', 'hold')",
    [venueId, bookingId],
  );
  for (const b of blocks.rows) await releaseBlock(c, b.id);
  await emitEvent(c, { venueId, type: "room.updated", entityId: roomId, entityVersion: 0 });
}

interface Cancellable {
  id: string;
  status: string;
  room_id: string;
  starts_at: string;
  business_date: string;
  refund_cutoff_at: string | null;
  policy_version_id: string | null;
}

const lockBooking = async (c: Queryable, venueId: string, bookingId: string) =>
  (
    await c.query<Cancellable>(
      `select id, status, room_id, to_json(starts_at) #>> '{}' as starts_at, business_date::text,
              to_json(refund_cutoff_at) #>> '{}' as refund_cutoff_at, policy_version_id
         from bookings where venue_id = $1 and id = $2 for update`,
      [venueId, bookingId],
    )
  ).rows[0] ?? null;

/** `DELETE /v1/public/bookings/{token}`: the guest cancels, by the refund cut-off and the accepted policy. */
export async function guestCancels(
  c: Queryable,
  venueId: string,
  bookingId: string,
  now: Temporal.Instant,
): Promise<{ refundCents: number; keptCents: number }> {
  const b = await lockBooking(c, venueId, bookingId);
  if (!b) throw new ApiError("not_found", "no such booking");
  if (b.status === "cancelled") return { refundCents: 0, keptCents: 0 };
  if (b.status !== "confirmed" && b.status !== "pending")
    throw refuse("not_cancellable", "this booking can't be cancelled here");
  if (Temporal.Instant.compare(now, Temporal.Instant.from(b.starts_at)) >= 0)
    throw refuse("started", "the booking has started: call the venue");
  let outcome = { refundCents: 0, keptCents: 0 };
  if (b.status === "confirmed") {
    const held = (await heldDeposits(c, venueId, b.id)).reduce((s, p) => s + p.held_cents, 0);
    const rule = await acceptedRule(c, venueId, b);
    const cutoff = b.refund_cutoff_at ? Temporal.Instant.from(b.refund_cutoff_at) : null;
    outcome = cancelOutcome({
      heldCents: held,
      beforeCutoff: cutoff === null || Temporal.Instant.compare(now, cutoff) < 0,
      late: rule?.late ?? "keep",
    });
    const reason =
      cutoff === null || Temporal.Instant.compare(now, cutoff) < 0
        ? REFUND_CANCELLED
        : rule?.late === "half"
          ? REFUND_LATE_HALF
          : REFUND_LATE_POLICY;
    await refundHeld(c, venueId, b.id, outcome.refundCents, reason, now, { strict: true });
    await keepOnFeeCheck(c, venueId, {
      bookingId: b.id,
      keptCents: outcome.keptCents,
      chargeCents: 0,
      userId: null,
      now,
    });
  }
  await dropPendingTopUps(c, venueId, b.id);
  await releaseRoom(c, venueId, b.id, b.room_id);
  await c.query(
    `update bookings set status = 'cancelled', cancelled_via = 'guest', pending_until = null
      where venue_id = $1 and id = $2`,
    [venueId, b.id],
  );
  await emitEvent(c, { venueId, type: "booking.updated", entityId: b.id, entityVersion: 0 });
  return outcome;
}

/** A blocked date (step 6): the venue cancels the booking and refunds it in full. */
export async function venueCancels(
  c: Queryable,
  venueId: string,
  bookingId: string,
  userId: string | null,
  now: Temporal.Instant,
): Promise<{ refundCents: number; manualCents: number } | null> {
  const b = await lockBooking(c, venueId, bookingId);
  if (!b || (b.status !== "confirmed" && b.status !== "pending")) return null;
  const held = (await heldDeposits(c, venueId, b.id)).reduce((s, p) => s + p.held_cents, 0);
  const { refundCents } = cancelOutcome({
    heldCents: held,
    beforeCutoff: false,
    late: "keep",
    byVenue: true,
  });
  const sent = await refundHeld(c, venueId, b.id, refundCents, REFUND_VENUE, now, {
    strict: false,
  });
  await dropPendingTopUps(c, venueId, b.id);
  await releaseRoom(c, venueId, b.id, b.room_id);
  await c.query(
    `update bookings set status = 'cancelled', cancelled_via = 'venue', cancelled_by = $3, pending_until = null
      where venue_id = $1 and id = $2`,
    [venueId, b.id, userId],
  );
  await emitEvent(c, { venueId, type: "booking.updated", entityId: b.id, entityVersion: 0 });
  return { refundCents: sent.refundedCents, manualCents: sent.manualCents };
}

/**
 * The no-show's money (step 4), in Mark no-show's transaction: the accepted policy keeps the deposit,
 * charges up to the first hour in total, or refunds it.
 */
export async function noShowMoney(
  c: Queryable,
  venueId: string,
  bookingId: string,
  userId: string,
  now: Temporal.Instant,
): Promise<{ refundCents: number; keptCents: number; chargeCents: number }> {
  const b = (
    await c.query<{
      party_size: number;
      business_date: string;
      policy_version_id: string | null;
      deposit_cents: number;
    }>(
      `select party_size, business_date::text, policy_version_id, deposit_cents
         from bookings where venue_id = $1 and id = $2`,
      [venueId, bookingId],
    )
  ).rows[0]!;
  const held = (await heldDeposits(c, venueId, bookingId)).reduce((s, p) => s + p.held_cents, 0);
  const rule = await acceptedRule(c, venueId, b);
  if (!rule || (!rule.on && held === 0)) return { refundCents: 0, keptCents: 0, chargeCents: 0 };
  const on = Temporal.PlainDate.from(b.business_date);
  const prices = (await readSetting(c, venueId, "prices", on))?.value;
  const firstHour = prices
    ? hourlyCentsFor(prices.rate, billableGuestsOn(b.party_size, on, prices)).hourlyCents
    : 0;
  const outcome = noShowOutcome({
    heldCents: held,
    noShow: rule.noShow,
    firstHourCents: firstHour,
  });
  await refundHeld(
    c,
    venueId,
    bookingId,
    outcome.refundCents,
    rule.noShow === "nothing" ? REFUND_NO_SHOW : REFUND_NO_SHOW_EXCESS,
    now,
    { strict: false },
  );
  await keepOnFeeCheck(c, venueId, {
    bookingId,
    keptCents: outcome.keptCents,
    chargeCents: outcome.chargeCents,
    userId,
    now,
  });
  return outcome;
}

/** The cancel and refund status the manage page shows (it works with Online booking & deposits off). */
export async function moneyStatus(c: Queryable, venueId: string, bookingId: string) {
  const r = (
    await c.query<{ pending: string; succeeded: string; failed: string; kept: string }>(
      `select coalesce(sum(amount_cents) filter (where status = 'pending'), 0)::text as pending,
              coalesce(sum(amount_cents) filter (where status = 'succeeded'), 0)::text as succeeded,
              coalesce(sum(amount_cents) filter (where status in ('failed', 'canceled')), 0)::text as failed,
              (select coalesce(sum(l.amount_cents), 0) from check_lines l join checks k
                  on k.venue_id = l.venue_id and k.id = l.check_id
                where k.venue_id = $1 and k.booking_id = $2 and k.kind = 'fee' and k.status <> 'void'
                  and l.kind = 'forfeit' and l.description = 'Deposit kept')::text as kept
         from refunds where venue_id = $1 and booking_id = $2`,
      [venueId, bookingId],
    )
  ).rows[0]!;
  const pending = Number(r.pending);
  const succeeded = Number(r.succeeded);
  const failed = Number(r.failed);
  return {
    refund:
      pending + succeeded + failed === 0
        ? null
        : {
            amount_cents: pending + succeeded,
            status: pending > 0 ? "pending" : succeeded > 0 ? "refunded" : "failed",
          },
    kept_cents: Number(r.kept),
  };
}
