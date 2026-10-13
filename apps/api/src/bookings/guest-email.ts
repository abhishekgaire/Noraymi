import { randomBytes } from "node:crypto";
import { enqueue, latestSetting, payTokenHash, type JobHandler, type Queryable } from "@west4/db";
import { Temporal } from "@west4/shared";
import type { EmailSettings } from "../email/settings.js";
import { enqueueEmail } from "../jobs/send-email.js";
import { spokenNumber } from "../texts/inbox.js";

/**
 * Every booking emailed to the guest (F-06; D124; spec 11 · Booking emails): Booking confirmed,
 * Booking changed and Booking cancelled, in the guest's language, with the venue, the time, the
 * room hours, the party, the deposit and when it stops being refundable, a manage link of its own,
 * and the venue's phone. Never card data. Emails have no switch: one goes whenever the booking has
 * an email, whatever the texting switches say. A job, so the flow never waits on email.
 */
export const BOOKING_GUEST_EMAIL_KIND = "booking.guestEmail";

export type GuestEmailEvent = "confirmed" | "changed" | "cancelled";

export async function emailGuestAboutBooking(
  c: Queryable,
  input: {
    readonly venueId: string;
    readonly event: GuestEmailEvent;
    readonly bookingId: string;
    readonly runAt: Temporal.Instant;
  },
): Promise<void> {
  await enqueue(c, {
    venueId: input.venueId,
    kind: BOOKING_GUEST_EMAIL_KIND,
    pool: "normal",
    runAt: input.runAt,
    payload: { event: input.event, booking_id: input.bookingId },
    // Confirmed and cancelled go once; each change once per moment.
    dedupeKey:
      input.event === "changed"
        ? `${BOOKING_GUEST_EMAIL_KIND}:changed:${input.bookingId}:${input.runAt.toString()}`
        : `${BOOKING_GUEST_EMAIL_KIND}:${input.event}:${input.bookingId}`,
  });
}

const fmt = (
  iso: string,
  timeZone: string,
  locale: "en" | "es",
  parts: Intl.DateTimeFormatOptions,
) =>
  new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", { timeZone, ...parts }).format(
    new Date(iso),
  );

export function makeBookingGuestEmailHandler(
  email: Pick<EmailSettings, "allowList">,
  guestAppUrl: string | null,
): JobHandler {
  return async ({ job, clock, step }) => {
    const payload = job.payload as { event?: GuestEmailEvent; booking_id?: string };
    if (!payload.event || !payload.booking_id || !guestAppUrl) return;
    const { event, booking_id: bookingId } = payload;
    await step(async (c) => {
      const r = await c.query<{
        email: string | null;
        locale: "en" | "es";
        name: string;
        party_size: number;
        starts_at: string;
        ends_at: string;
        refund_cutoff_at: string | null;
        venue_name: string;
        time_zone: string;
      }>(
        `select g.email, g.locale, g.name, b.party_size, to_json(b.starts_at) #>> '{}' as starts_at,
                to_json(b.ends_at) #>> '{}' as ends_at, to_json(b.refund_cutoff_at) #>> '{}' as refund_cutoff_at,
                v.name as venue_name, v.time_zone
           from bookings b
           join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
           join venues v on v.id = b.venue_id
          where b.venue_id = $1 and b.id = $2`,
        [job.venue_id, bookingId],
      );
      const b = r.rows[0];
      if (!b?.email) return;
      const paid = Number(
        (
          await c.query<{ s: string }>(
            `select coalesce(sum(amount_cents), 0)::text as s from payments
              where venue_id = $1 and booking_id = $2 and status = 'captured'`,
            [job.venue_id, bookingId],
          )
        ).rows[0]!.s,
      );
      const phone = (await latestSetting(c, job.venue_id, "phone"))?.value.callNumber ?? null;
      const token = randomBytes(16).toString("base64url");
      await c.query(
        `insert into booking_links (venue_id, booking_id, token_hash, purpose, created_at)
         values ($1, $2, $3, 'email', $4)`,
        [job.venue_id, bookingId, payTokenHash(token), clock.now().toString()],
      );
      const locale = b.locale === "es" ? "es" : "en";
      const minutes = Math.round(
        Temporal.Instant.from(b.ends_at).since(Temporal.Instant.from(b.starts_at)).total("minutes"),
      );
      const cutoffFuture =
        b.refund_cutoff_at &&
        Temporal.Instant.compare(Temporal.Instant.from(b.refund_cutoff_at), clock.now()) > 0;
      await enqueueEmail(c, email, {
        venueId: job.venue_id,
        to: b.email,
        locale,
        template: "booking_guest",
        runAt: clock.now(),
        dedupeKey: `${job.id}:guest`,
        data: {
          venueName: b.venue_name,
          event,
          guestName: b.name,
          partySize: b.party_size,
          when: fmt(b.starts_at, b.time_zone, locale, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
          minutes,
          depositCents: paid > 0 ? paid : null,
          freeCancelUntil:
            event !== "cancelled" && cutoffFuture
              ? fmt(b.refund_cutoff_at!, b.time_zone, locale, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : null,
          manageUrl: `${guestAppUrl.replace(/\/$/, "")}/b/${token}`,
          venuePhone: phone ? spokenNumber(phone) : null,
        },
      });
    });
  };
}
