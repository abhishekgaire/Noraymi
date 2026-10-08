import { randomUUID } from "node:crypto";
import {
  createPayLink,
  emitEvent,
  enqueue,
  heldDeposits,
  insertPayment,
  insertRefund,
  latestAttempt,
  listRooms,
  readSetting,
  releaseBlock,
  setPaymentStatus,
  setPayLinkPayment,
  startAttempt,
  type Queryable,
} from "@west4/db";
import {
  bookingGrid,
  businessDate,
  changedCutoff,
  cutoffWords,
  deposit,
  depositChange,
  minGuestsOn,
  refundCutoffAt,
  resolveStart,
} from "@west4/rules";
import { Temporal } from "@west4/shared";
import { z } from "zod";
import { ApiError } from "../http/errors.js";
import { REFUND_RUN_KIND } from "../payments/refunds.js";
import { assignBooking, nightHours, venueClock } from "../rooms/assignment.js";
import { LINK_DAYS_AFTER, nightFacts } from "./online.js";

/**
 * The manage page (M5-11; Payment flows · Deposit when booking online, steps
 * 4 and 5; Money rules 3 and 11; screens · Manage). A confirmed booking, by
 * its link, can change its time, date or party size, or say it's running
 * late, until it starts:
 *   - A new time or date gets a real room for the new slot (the smallest free
 *     one offered online that fits), keeps the deposit, and never moves the
 *     refund cut-off later. A bigger party that outgrows its room moves too.
 *   - The deposit is worked out again from billable guests (the big-party rule
 *     from 20). More is collected on the payment page as its own payment;
 *     less is refunded, by rule and with no approval, only before the
 *     cut-off; after it the deposit already paid stays, and the guest confirms
 *     (`accept_keep`) that what the bill doesn't use is kept.
 *   - Running late holds the room until the start plus the grace (15 minutes
 *     at West 4) and shows on the Board.
 * `preview: true` answers what the change would do and writes nothing.
 */
export const REFUND_SMALLER_PARTY = "Smaller party before the refund cut-off";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const changeBody = z
  .object({
    party_size: z.number().int().min(1).max(500).optional(),
    business_date: date.optional(),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    offset: z
      .string()
      .regex(/^[+-]\d{2}:\d{2}$/)
      .optional(),
    running_late: z.literal(true).optional(),
    accept_keep: z.boolean().optional(),
    preview: z.boolean().optional(),
  })
  .strict();

const refuse = (reason: string, message: string, more: Record<string, unknown> = {}) =>
  new ApiError("invalid_request", message, { details: { reason, ...more } });

interface Linked {
  id: string;
  status: string;
  party_size: number;
  size_tier: string;
  room_id: string;
  starts_at: string;
  ends_at: string;
  business_date: string;
  deposit_cents: number;
  refund_cutoff_at: string | null;
  running_late_until: string | null;
}

/** The booking behind a manage link (the booking's own, or a confirmation text's), until a day after it ends. */
export async function linkedBooking(
  c: Queryable,
  venueId: string,
  tokenHash: string,
  now: Temporal.Instant,
  lock = false,
): Promise<Linked | null> {
  const r = await c.query<Linked>(
    `select b.id, b.status, b.party_size, b.size_tier, b.room_id, to_json(b.starts_at) #>> '{}' as starts_at,
            to_json(b.ends_at) #>> '{}' as ends_at, b.business_date::text, b.deposit_cents,
            to_json(b.refund_cutoff_at) #>> '{}' as refund_cutoff_at,
            to_json(b.running_late_until) #>> '{}' as running_late_until
       from bookings b
      where b.venue_id = $1
        and (b.manage_token_hash = $2
             or b.id in (select l.booking_id from booking_links l where l.venue_id = $1 and l.token_hash = $2))
        and b.ends_at + interval '${LINK_DAYS_AFTER} days' > $3
      ${lock ? "for update" : ""}`,
    [venueId, tokenHash, now.toString()],
  );
  return r.rows[0] ?? null;
}

const heldOf = async (c: Queryable, venueId: string, bookingId: string) =>
  (await heldDeposits(c, venueId, bookingId)).reduce((s, p) => s + p.held_cents, 0);

const graceOf = async (c: Queryable, venueId: string, on: string) =>
  (await readSetting(c, venueId, "deposit", Temporal.PlainDate.from(on)))?.value.graceMin ?? 15;

/** "23:00" for a booking's start, in the venue's time zone. */
const hhmm = (at: Temporal.Instant, timeZone: string) => {
  const z = at.toZonedDateTimeISO(timeZone);
  return `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`;
};

/** The manage page's view of the booking: what it is, what it holds, and what it can still do. */
export async function manageView(c: Queryable, venueId: string, b: Linked, now: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const slug = (await c.query<{ slug: string }>("select slug from venues where id = $1", [venueId]))
    .rows[0]!.slug;
  const on = Temporal.PlainDate.from(b.business_date);
  const n = await nightFacts(c, venueId, now, on).catch(() => null);
  const start = Temporal.Instant.from(b.starts_at);
  const held = await heldOf(c, venueId, b.id);
  const grace = await graceOf(c, venueId, b.business_date);
  const confirmed = b.status === "confirmed";
  const cutoff = b.refund_cutoff_at ? Temporal.Instant.from(b.refund_cutoff_at) : null;
  return {
    id: b.id,
    status: b.status,
    slug,
    business_date: b.business_date,
    starts_at: b.starts_at,
    ends_at: b.ends_at,
    time: hhmm(start, venue.timeZone),
    minutes: Math.round(
      Temporal.Instant.from(b.ends_at).since(start, { largestUnit: "minutes" }).minutes,
    ),
    time_zone: venue.timeZone,
    size_tier: b.size_tier,
    party_size: b.party_size,
    min_guests: n ? minGuestsOn(on, n.prices) : null,
    max_guests: n ? n.prices.booking.maxGuests : null,
    deposit_cents: b.deposit_cents,
    held_cents: held,
    owed_cents: confirmed ? Math.max(0, b.deposit_cents - held) : 0,
    refund_cutoff_at: b.refund_cutoff_at,
    cutoff_words: cutoff ? cutoffWords(cutoff, start, now, venue.timeZone) : null,
    before_cutoff: cutoff !== null && Temporal.Instant.compare(now, cutoff) < 0,
    running_late_until: b.running_late_until,
    grace_min: grace,
    can_change: confirmed && Temporal.Instant.compare(now, start) < 0,
    can_run_late: confirmed && Temporal.Instant.compare(now, start.add({ minutes: grace })) < 0,
  };
}

/** A difference still waiting on the payment page: the booking's pending online payments. */
async function pendingTopUps(c: Queryable, venueId: string, bookingId: string) {
  return (
    await c.query<{ id: string; stripe_pi_id: string | null }>(
      `select id, stripe_pi_id from payments
        where venue_id = $1 and booking_id = $2 and method = 'card_online' and status = 'pending'`,
      [venueId, bookingId],
    )
  ).rows;
}

/**
 * The difference's own payment and a pay link to it (Payment flows step 5: "collects the difference on
 * the guest's screen"). One payment per difference, so every retry reaches the same PaymentIntent; a
 * difference that changed before anyone opened its page is replaced; one already on Stripe is paid first.
 */
async function differenceLink(
  c: Queryable,
  venueId: string,
  b: { id: string; starts_at: string },
  amountCents: number,
  now: Temporal.Instant,
  payAppUrl: string,
) {
  let paymentId: string | null = null;
  for (const p of await pendingTopUps(c, venueId, b.id)) {
    const attempt = await latestAttempt(c, venueId, p.id);
    if (attempt?.amount_cents === amountCents) paymentId = p.id;
    else if (!p.stripe_pi_id) await setPaymentStatus(c, venueId, p.id, "canceled", "api");
    else throw refuse("pay_difference_first", "pay the difference you were asked for first");
  }
  if (!paymentId) {
    const venue = await venueClock(c, venueId);
    paymentId = await insertPayment(c, venueId, {
      method: "card_online",
      status: "pending",
      businessDate: businessDate(now, venue.timeZone, venue.dayCutover).businessDate.toString(),
      bookingId: b.id,
    });
    await startAttempt(c, venueId, {
      paymentId,
      checkId: null,
      bookingId: b.id,
      portionKey: "deposit",
      action: "confirm",
      amountCents,
      startedAt: now.toString(),
    });
  }
  const link = await createPayLink(c, venueId, {
    bookingId: b.id,
    amountCents,
    expiresAt: b.starts_at,
    purpose: "deposit",
  });
  await setPayLinkPayment(c, venueId, link.id, paymentId);
  return `${payAppUrl}/pay/${link.token}`;
}

/** `POST /v1/public/bookings/{token}/pay` for a confirmed booking that owes a difference. */
export async function differencePayLink(
  c: Queryable,
  venueId: string,
  b: Linked,
  now: Temporal.Instant,
  payAppUrl: string,
) {
  const owed = b.deposit_cents - (await heldOf(c, venueId, b.id));
  if (owed <= 0) throw refuse("nothing_owed", "the deposit is paid in full");
  return { pay_url: await differenceLink(c, venueId, b, owed, now, payAppUrl) };
}

/** The excess back by rule (Payment flows step 5), newest card payment first, through the refund job. */
async function refundExcess(
  c: Queryable,
  venueId: string,
  bookingId: string,
  cents: number,
  now: Temporal.Instant,
) {
  const card = (await heldDeposits(c, venueId, bookingId))
    .filter((p) => p.method === "card_online" && p.held_cents > 0)
    .reverse();
  if (card.reduce((s, p) => s + p.held_cents, 0) < cents)
    // An imported deposit paid through the old system is refunded there (M9-02): staff do it.
    throw refuse("call_venue", "call the venue to change this booking");
  const venue = await venueClock(c, venueId);
  const night = businessDate(now, venue.timeZone, venue.dayCutover).businessDate.toString();
  let left = cents;
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
      reason: REFUND_SMALLER_PARTY,
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
}

/** `PATCH /v1/public/bookings/{token}`: one change, or with `preview` what it would do. */
export async function changeBooking(
  c: Queryable,
  venueId: string,
  tokenHash: string,
  now: Temporal.Instant,
  input: z.infer<typeof changeBody>,
  payAppUrl: string | null,
) {
  const b = await linkedBooking(c, venueId, tokenHash, now, true);
  if (!b) throw new ApiError("not_found", "no such booking");
  if (b.status !== "confirmed")
    throw refuse("not_confirmed", "only a confirmed booking can be changed here");
  const start = Temporal.Instant.from(b.starts_at);
  const venue = await venueClock(c, venueId);
  const preview = input.preview ?? false;

  if (input.running_late) {
    if (input.party_size !== undefined || input.business_date !== undefined || input.time)
      throw refuse("one_change", "say you're running late on its own");
    const grace = await graceOf(c, venueId, b.business_date);
    const until = start.add({ minutes: grace });
    if (Temporal.Instant.compare(now, until) >= 0)
      throw refuse("too_late", "the grace has passed: call the venue");
    if (!preview) {
      await c.query("update bookings set running_late_until = $3 where venue_id = $1 and id = $2", [
        venueId,
        b.id,
        until.toString(),
      ]);
      await emitEvent(c, { venueId, type: "booking.updated", entityId: b.id, entityVersion: 0 });
    }
    const after = preview
      ? { ...b, running_late_until: until.toString() }
      : (await linkedBooking(c, venueId, tokenHash, now))!;
    return {
      booking: await manageView(c, venueId, after, now),
      running_late_until: after.running_late_until,
      grace_min: grace,
      deposit_cents: b.deposit_cents,
      collect_cents: 0,
      refund_cents: 0,
      stays_cents: 0,
      pay_url: null,
    };
  }

  if (Temporal.Instant.compare(now, start) >= 0)
    throw refuse("started", "the booking has started: ask the staff");
  const movesTime = input.business_date !== undefined || input.time !== undefined;
  if (!movesTime && input.party_size === undefined)
    throw new ApiError("invalid_request", "nothing to change");
  const party = input.party_size ?? b.party_size;
  const on = Temporal.PlainDate.from(input.business_date ?? b.business_date);
  const today = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  if (Temporal.PlainDate.compare(on, today) < 0) throw refuse("past", "pick tonight or later");
  const n = await nightFacts(c, venueId, now, on);
  if (party > n.prices.booking.maxGuests)
    throw refuse("too_big", "a party this size books through the enquiry form");
  const length = Math.round(
    Temporal.Instant.from(b.ends_at).since(start, { largestUnit: "minutes" }).minutes,
  );
  let from = start;
  if (movesTime) {
    const resolved = resolveStart(
      on,
      input.time ?? hhmm(start, venue.timeZone),
      venue.timeZone,
      venue.dayCutover,
      input.offset,
    );
    if ("refused" in resolved)
      throw refuse(
        resolved.refused,
        resolved.refused === "does_not_exist"
          ? "that time doesn't exist that night: the clocks skip it"
          : resolved.refused === "ambiguous"
            ? "that time happens twice that night: pick EDT or EST"
            : "time is HH:MM",
      );
    from = resolved.start;
    if (Temporal.Instant.compare(from, now) <= 0) throw refuse("past", "that time has passed");
    const night = await nightHours(c, venueId, venue, on);
    if (!night) throw refuse("closed", "the venue is closed that night");
    const onGrid = bookingGrid({
      opens: night.opens,
      closes: night.closes,
      minHours: length / 60,
      startSlots: n.prices.booking.startSlots,
      timeZone: venue.timeZone,
    }).some((s) => s.start.equals(from));
    if (!onGrid) throw refuse("off_grid", "that isn't one of the night's start times");
  }
  const to = from.add({ minutes: length });

  if (preview) await c.query("savepoint manage_preview");
  // The room: a new slot, or a party its room no longer fits, gets a real room again.
  const rooms = await listRooms(c, venueId);
  let room = rooms.find((r) => r.id === b.room_id);
  const moved = !from.equals(start);
  if (moved || !room || party > room.capacity_max) {
    const old = await c.query<{ id: string }>(
      "select id from room_blocks where venue_id = $1 and ref_id = $2 and kind = 'booking'",
      [venueId, b.id],
    );
    for (const row of old.rows) await releaseBlock(c, row.id);
    const block = await assignBooking(c, venueId, {
      party,
      from,
      to,
      refId: b.id,
      kind: "booking",
      online: true,
    });
    room = rooms.find((r) => r.id === block.room_id)!;
  }

  // The deposit again from billable guests; a venue with deposits off (or a card hold) leaves it alone.
  const held = await heldOf(c, venueId, b.id);
  const cutoff = b.refund_cutoff_at ? Temporal.Instant.from(b.refund_cutoff_at) : null;
  const rule = n.deposit;
  const counts = rule.on && rule.mode !== "cardHold";
  const change = counts
    ? depositChange({
        heldCents: held,
        newDepositCents: deposit(party, on, rule, n.prices).depositCents,
        beforeCutoff: cutoff !== null && Temporal.Instant.compare(now, cutoff) < 0,
      })
    : { depositCents: b.deposit_cents, collectCents: 0, refundCents: 0, staysCents: 0 };
  if (change.staysCents > 0 && !input.accept_keep && !preview)
    throw refuse(
      "confirm_keep",
      "you're past the refund cut-off: confirm that the deposit already paid stays",
      { stays_cents: change.staysCents, held_cents: held },
    );
  if (change.refundCents > 0) await refundExcess(c, venueId, b.id, change.refundCents, now);
  // An earlier difference not paid yet, never sent to Stripe, is replaced by this one (or by none).
  if (change.collectCents === 0)
    for (const p of await pendingTopUps(c, venueId, b.id)) {
      if (p.stripe_pi_id)
        throw refuse("pay_difference_first", "pay the difference you were asked for first");
      await setPaymentStatus(c, venueId, p.id, "canceled", "api");
    }
  const big = rule.bigParty && party >= rule.bigParty.fromGuests;
  const hours = big ? rule.bigParty!.refundHours : rule.refundHours;
  const newCutoff = changedCutoff(cutoff, refundCutoffAt(from, hours));
  await c.query(
    `update bookings set party_size = $3, room_id = $4, size_tier = $5, starts_at = $6, ends_at = $7,
            business_date = $8, deposit_cents = $9, refund_cutoff_at = $10,
            running_late_until = case when $11 then null else running_late_until end
      where venue_id = $1 and id = $2`,
    [
      venueId,
      b.id,
      party,
      room.id,
      room.size_tier,
      from.toString(),
      to.toString(),
      on.toString(),
      change.depositCents,
      newCutoff?.toString() ?? null,
      moved,
    ],
  );
  await emitEvent(c, { venueId, type: "booking.updated", entityId: b.id, entityVersion: 0 });
  let payUrl: string | null = null;
  if (change.collectCents > 0 && !preview) {
    if (!payAppUrl)
      throw new ApiError("invalid_request", "the payment page isn't set up here (PAY_APP_URL)");
    payUrl = await differenceLink(
      c,
      venueId,
      { id: b.id, starts_at: from.toString() },
      change.collectCents,
      now,
      payAppUrl,
    );
  }
  const after = (await linkedBooking(c, venueId, tokenHash, now))!;
  const answer = {
    booking: await manageView(c, venueId, after, now),
    running_late_until: after.running_late_until,
    grace_min: null,
    deposit_cents: change.depositCents,
    collect_cents: change.collectCents,
    refund_cents: change.refundCents,
    stays_cents: change.staysCents,
    pay_url: payUrl,
  };
  if (preview) await c.query("rollback to savepoint manage_preview");
  return answer;
}
