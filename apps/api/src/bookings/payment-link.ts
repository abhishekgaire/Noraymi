import { randomBytes } from "node:crypto";
import { emitEvent, payTokenHash, readSetting, type Queryable } from "@west4/db";
import { Temporal, cents, formatMoney } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { queueText } from "../texts/queue.js";
import { clockWords } from "../texts/triggers.js";

/**
 * A payment link for a staff or big-party booking (M5-13; Payment flows ·
 * Deposit when booking online, step 7; Data model · bookings.pending_until).
 * The booking stays pending until `pending_until`, 24 hours after the link is
 * sent and never later than the start; its room block becomes a hold that
 * lapses with it (the hold sweep frees the room and cancels the booking). The
 * Payment link text carries a link of the booking's own (128 bits, stored
 * hashed); the guest opens it, accepts the policy and pays on the payment
 * page, and the booking confirms as an online one does (M5-10). A venue in
 * cardHold mode saves the card instead and charges nothing.
 */
export const LINK_HOLD_HOURS = 24;

const refuse = (reason: string, message: string) =>
  new ApiError("invalid_request", message, { details: { reason } });

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

export async function sendPaymentLink(
  c: Queryable,
  venueId: string,
  bookingId: string,
  now: Temporal.Instant,
  settings: {
    guestAppUrl: string | null;
    allowList: readonly string[] | null;
    userId: string | null;
  },
) {
  const b = (
    await c.query<{
      id: string;
      status: string;
      starts_at: string;
      business_date: string;
      party_size: number;
      deposit_cents: number;
      phone: string | null;
      guest_id: string;
      room_name: string;
      venue_name: string;
      time_zone: string;
    }>(
      `select b.id, b.status, to_json(b.starts_at) #>> '{}' as starts_at, b.business_date::text, b.party_size,
              b.deposit_cents, g.phone_e164 as phone, b.guest_id, r.name as room_name, v.name as venue_name,
              v.time_zone
         from bookings b join venues v on v.id = b.venue_id
         join rooms r on r.venue_id = b.venue_id and r.id = b.room_id
         left join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
        where b.venue_id = $1 and b.id = $2 for update of b`,
      [venueId, bookingId],
    )
  ).rows[0];
  if (!b) throw new ApiError("not_found", "no such booking");
  if (b.status !== "pending")
    throw refuse("not_pending", "only a booking waiting for its deposit gets a payment link");
  const start = Temporal.Instant.from(b.starts_at);
  if (Temporal.Instant.compare(start, now) <= 0) throw refuse("past", "that booking has started");
  const rule = (await readSetting(c, venueId, "deposit", Temporal.PlainDate.from(b.business_date)))
    ?.value;
  const cardHold = rule?.on === true && rule.mode === "cardHold";
  if (b.deposit_cents <= 0 && !cardHold)
    throw refuse("no_deposit", "this booking takes no deposit");
  if (!b.phone) throw refuse("no_phone", "the guest has no mobile number to text");
  if (!settings.guestAppUrl)
    throw new ApiError("invalid_request", "the guest site has no address here yet (GUEST_APP_URL)");

  // Held 24 hours from now, never past the start.
  const later = now.add({ hours: LINK_HOLD_HOURS });
  const until = Temporal.Instant.compare(later, start) < 0 ? later : start;
  await c.query("update bookings set pending_until = $3 where venue_id = $1 and id = $2", [
    venueId,
    b.id,
    until.toString(),
  ]);
  const block = await c.query(
    `update room_blocks set kind = 'hold', expires_at = $3
      where venue_id = $1 and ref_id = $2 and kind in ('hold', 'booking')`,
    [venueId, b.id, until.toString()],
  );
  if (block.rowCount === 0) throw refuse("no_room", "this booking has no room held");

  const token = randomBytes(16).toString("base64url");
  await c.query(
    `insert into booking_links (venue_id, booking_id, token_hash, purpose, created_at)
     values ($1, $2, $3, 'payment_link', $4)`,
    [venueId, b.id, payTokenHash(token), now.toString()],
  );
  const z = start.toZonedDateTimeISO(b.time_zone);
  const link = `${settings.guestAppUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/b/${token}`;
  let texted = true;
  try {
    await queueText(
      c,
      venueId,
      {
        templateKey: "payment_link",
        to: b.phone,
        params: {
          venue: b.venue_name,
          room: b.room_name,
          party: b.party_size,
          date: `${DAYS[z.dayOfWeek - 1]!} ${MONTHS[z.month - 1]!} ${z.day}`,
          time: clockWords(start, b.time_zone),
          amount: formatMoney("en", cents(b.deposit_cents)),
          link,
        },
        guestId: b.guest_id,
        context: { kind: "booking", id: b.id },
        sentBy: settings.userId,
        now,
      },
      { allowList: settings.allowList },
    );
  } catch (e) {
    // A text switched off, an opt-out or Guest texts off stops it, as for every text; staff can read the link.
    if (!(e instanceof ApiError)) throw e;
    texted = false;
  }
  await emitEvent(c, { venueId, type: "booking.updated", entityId: b.id, entityVersion: 0 });
  return {
    pending_until: until.toString(),
    texted,
    url: `${settings.guestAppUrl.replace(/\/+$/, "")}/b/${token}`,
    card_hold: cardHold && b.deposit_cents === 0,
  };
}
