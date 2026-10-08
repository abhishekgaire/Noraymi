import { randomBytes, randomUUID } from "node:crypto";
import {
  emitEvent,
  enqueue,
  insertRefund,
  payTokenHash,
  paymentById,
  readSetting,
  type JobHandler,
  type PaymentRow,
  type Queryable,
} from "@west4/db";
import { businessDate, cutoffWords, refundCutoffAt } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { REFUND_RUN_KIND } from "../payments/refunds.js";
import { venueClock } from "../rooms/assignment.js";
import { clockWords } from "../texts/triggers.js";
import { queueText } from "../texts/queue.js";
import type { VenueTextSettings } from "../texts/venue.js";

/**
 * Confirming a booking (M5-10; Payment flows · Deposit when booking online,
 * steps 3 and 4, Confirmed and Failures). It runs inside the state machine's
 * transaction the moment a deposit's capture is recorded, whichever path
 * brought the news first: the page's return (the server reads the
 * PaymentIntent itself), `payment_intent.succeeded`, or the reconciler.
 *   - The hold still stands: its block becomes the booking's, and the booking
 *     confirms.
 *   - The hold lapsed first: the room is checked again. Still free, the
 *     booking confirms with a new block; gone, the payment is refunded in
 *     full by a rule (an automatic refund, sent by the `refund.run` job,
 *     outside any transaction) and the page says so.
 * At the first confirmation the refund cut-off is fixed: the booked start
 * less `refundHours` (the big-party window for a big party), counted in
 * elapsed hours; later changes never move it later (M5-11). The Booking
 * confirmed text goes from a job, with a manage link of its own.
 */
export const BOOKING_CONFIRMED_KIND = "booking.confirmed";
export const LATE_ROOM_GONE = "Paid after the hold ran out, and the room was taken";

export async function settleDeposit(
  c: Queryable,
  venueId: string,
  payment: PaymentRow,
  now: Temporal.Instant,
): Promise<"confirmed" | "refunded" | null> {
  if (!payment.booking_id || payment.method !== "card_online" || payment.training) return null;
  const b = (
    await c.query<{
      id: string;
      status: string;
      room_id: string;
      starts_at: string;
      ends_at: string;
      business_date: string;
      party_size: number;
      deposit_cents: number;
      cancelled_by: string | null;
    }>(
      `select id, status, room_id, to_json(starts_at) #>> '{}' as starts_at, to_json(ends_at) #>> '{}' as ends_at,
              business_date::text, party_size, deposit_cents, cancelled_by
         from bookings where venue_id = $1 and id = $2 for update`,
      [venueId, payment.booking_id],
    )
  ).rows[0];
  // Only a booking waiting on this money: pending, or let go when its hold lapsed (never a guest's cancel).
  if (!b || !(b.status === "pending" || (b.status === "cancelled" && !b.cancelled_by))) return null;
  const hold = (
    await c.query<{ id: string }>(
      "select id from room_blocks where venue_id = $1 and ref_id = $2 and kind = 'hold' for update",
      [venueId, b.id],
    )
  ).rows[0];
  let blocked = false;
  if (hold) {
    await c.query(
      "update room_blocks set kind = 'booking', expires_at = null where venue_id = $1 and id = $2",
      [venueId, hold.id],
    );
    blocked = true;
  } else {
    // The hold lapsed and its block went: the same room again, if nobody has taken it since.
    await c.query("savepoint deposit_room");
    try {
      await c.query(
        `insert into room_blocks (venue_id, room_id, period, kind, ref_id)
         values ($1, $2, tstzrange($3, $4, '[)'), 'booking', $5)`,
        [venueId, b.room_id, b.starts_at, b.ends_at, b.id],
      );
      await c.query("release savepoint deposit_room");
      blocked = true;
    } catch (e) {
      await c.query("rollback to savepoint deposit_room");
      if ((e as { code?: string }).code !== "23P01") throw e;
    }
  }
  const venue = await venueClock(c, venueId);
  if (!blocked) {
    // The room has gone: the whole payment back, by rule.
    const paid = (await paymentById(c, venueId, payment.id))!;
    const refundId = randomUUID();
    await insertRefund(c, venueId, {
      id: refundId,
      paymentId: payment.id,
      checkId: null,
      bookingId: b.id,
      amountCents: paid.amount_cents,
      reason: LATE_ROOM_GONE,
      requestedBy: null,
      automatic: true,
      approvalId: null,
      businessDate: businessDate(now, venue.timeZone, venue.dayCutover).businessDate.toString(),
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
    if (b.status !== "cancelled")
      await c.query("update bookings set status = 'cancelled' where venue_id = $1 and id = $2", [
        venueId,
        b.id,
      ]);
    await emitEvent(c, { venueId, type: "booking.updated", entityId: b.id });
    return "refunded";
  }
  const deposit = await readSetting(
    c,
    venueId,
    "deposit",
    Temporal.PlainDate.from(b.business_date),
  );
  const rule = deposit?.value;
  const big = rule?.bigParty && b.party_size >= rule.bigParty.fromGuests;
  const hours = big ? rule!.bigParty!.refundHours : rule?.refundHours;
  const cutoff =
    b.deposit_cents > 0 && hours !== undefined
      ? refundCutoffAt(Temporal.Instant.from(b.starts_at), hours).toString()
      : null;
  await c.query(
    `update bookings set status = 'confirmed', pending_until = null, refund_cutoff_at = $3
      where venue_id = $1 and id = $2`,
    [venueId, b.id, cutoff],
  );
  await enqueue(c, {
    venueId,
    kind: BOOKING_CONFIRMED_KIND,
    pool: "normal",
    dedupeKey: `${BOOKING_CONFIRMED_KIND}:${b.id}`,
    payload: { booking_id: b.id },
    runAt: now,
  });
  await emitEvent(c, { venueId, type: "booking.updated", entityId: b.id });
  return "confirmed";
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = [
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
] as const;
/** "$50", or "$50.50" when there are cents, as the text reads (Song systems and texts, text 1). */
const dollars = (cents: number) =>
  cents % 100 === 0
    ? `$${(cents / 100).toLocaleString("en-US")}`
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

/** The Booking confirmed text's slots for one booking, and the manage link it carries. */
export async function confirmationText(
  c: Queryable,
  venueId: string,
  bookingId: string,
  now: Temporal.Instant,
  linkBase: string,
) {
  const b = (
    await c.query<{
      status: string;
      party_size: number;
      starts_at: string;
      refund_cutoff_at: string | null;
      phone: string | null;
      guest_id: string | null;
      time_zone: string;
      business_date: string;
    }>(
      `select b.status, b.party_size, to_json(b.starts_at) #>> '{}' as starts_at,
              to_json(b.refund_cutoff_at) #>> '{}' as refund_cutoff_at, g.phone_e164 as phone, b.guest_id,
              v.time_zone, b.business_date::text
         from bookings b join venues v on v.id = b.venue_id
         left join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
        where b.venue_id = $1 and b.id = $2`,
      [venueId, bookingId],
    )
  ).rows[0];
  if (!b || b.status !== "confirmed" || !b.phone) return null;
  const paid = (
    await c.query<{ s: string }>(
      `select coalesce(sum(amount_cents), 0)::text as s from payments
        where venue_id = $1 and booking_id = $2 and status = 'captured'`,
      [venueId, bookingId],
    )
  ).rows[0]!.s;
  const pay = await readSetting(c, venueId, "pay", Temporal.PlainDate.from(b.business_date));
  const g = pay?.value.gratuity;
  const start = Temporal.Instant.from(b.starts_at);
  const z = start.toZonedDateTimeISO(b.time_zone);
  // The text's own manage link: 128 bits, stored hashed.
  const token = randomBytes(16).toString("base64url");
  await c.query(
    `insert into booking_links (venue_id, booking_id, token_hash, purpose, created_at)
     values ($1, $2, $3, 'confirmation', $4)`,
    [venueId, bookingId, payTokenHash(token), now.toString()],
  );
  return {
    to: b.phone,
    guestId: b.guest_id,
    params: {
      party: b.party_size,
      time: clockWords(start, b.time_zone),
      date: `${DAYS[z.dayOfWeek - 1]!} ${MONTHS[z.month - 1]!} ${z.day}`,
      gratuity: `${g && (g.auto === "rooms" || g.auto === "all") ? g.pct : 0}%`,
      deposit: dollars(Number(paid)),
      cutoff: b.refund_cutoff_at
        ? cutoffWords(Temporal.Instant.from(b.refund_cutoff_at), start, now, b.time_zone)
        : "",
      link: `${linkBase.replace(/^https:\/\//, "")}/b/${token}`,
    },
  };
}

/** The Booking confirmed text (Song systems and texts, text 1), once per booking. */
export function makeBookingConfirmedHandler(settings: {
  readonly allowList: VenueTextSettings["allowList"];
  readonly guestAppUrl: string | null;
}): JobHandler {
  return async ({ job, clock, step }) => {
    const bookingId = (job.payload as { booking_id?: string }).booking_id;
    if (!bookingId || !settings.guestAppUrl) return;
    const linkBase = settings.guestAppUrl;
    await step(async (c) => {
      const sent = await c.query(
        "select 1 from booking_links where venue_id = $1 and booking_id = $2 and purpose = 'confirmation'",
        [job.venue_id, bookingId],
      );
      if (sent.rowCount) return;
      const text = await confirmationText(c, job.venue_id, bookingId, clock.now(), linkBase);
      if (!text) return;
      try {
        await queueText(
          c,
          job.venue_id,
          {
            templateKey: "booking_confirmed",
            to: text.to,
            params: text.params,
            guestId: text.guestId,
            context: { kind: "booking", id: bookingId },
            sentBy: null,
            now: clock.now(),
          },
          { allowList: settings.allowList },
        );
      } catch (e) {
        // A text switched off, Guest texts off or an opt-out stops it here, as for every text.
        if (!(e instanceof ApiError)) throw e;
      }
    });
  };
}
