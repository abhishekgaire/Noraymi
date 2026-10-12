import { enqueue, type JobHandler, type Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import type { EmailSettings } from "../email/settings.js";
import { enqueueEmail } from "../jobs/send-email.js";

/**
 * The booking inbox (O-03; spec 17 · Step details 1, D115 `contacts.bookingEmails`): a copy of
 * each new online booking, change, cancellation and party enquiry goes to each of the venue's up
 * to 3 booking inbox addresses, with no card data (the guest's name, the party, the time and the
 * room only). Empty sends none; the board and Messages still show them. A job, so the flows that
 * make the booking never wait on email and never call out inside their transaction.
 */
export const BOOKING_INBOX_KIND = "booking.inbox";

export type InboxEvent = "new" | "changed" | "cancelled" | "enquiry";

export async function copyToBookingInbox(
  c: Queryable,
  input: {
    readonly venueId: string;
    readonly event: InboxEvent;
    readonly refId: string;
    readonly runAt: Temporal.Instant;
  },
): Promise<void> {
  await enqueue(c, {
    venueId: input.venueId,
    kind: BOOKING_INBOX_KIND,
    pool: "normal",
    runAt: input.runAt,
    payload: { event: input.event, ref_id: input.refId },
    // A new booking and an enquiry are copied once; each change and the cancellation once per moment.
    dedupeKey:
      input.event === "new" || input.event === "enquiry" || input.event === "cancelled"
        ? `${BOOKING_INBOX_KIND}:${input.event}:${input.refId}`
        : `${BOOKING_INBOX_KIND}:${input.event}:${input.refId}:${input.runAt.toString()}`,
  });
}

interface Details {
  readonly guestName: string;
  readonly partySize: number;
  readonly when: string;
  readonly room: string | null;
}

/** "Fri, Sep 25 · 10:30 PM", in the venue's time zone. */
function venueTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(/, (\d+:\d{2})/, " · $1");
}

async function details(
  c: Queryable,
  venueId: string,
  event: InboxEvent,
  refId: string,
): Promise<Details | null> {
  if (event === "enquiry") {
    const r = await c.query<{ name: string; party_size: number; date: string }>(
      `select g.name, e.party_size, e.date::text as date from enquiries e
         join guests g on g.venue_id = e.venue_id and g.id = e.guest_id
        where e.venue_id = $1 and e.id = $2`,
      [venueId, refId],
    );
    const row = r.rows[0];
    return row
      ? {
          guestName: row.name,
          partySize: row.party_size,
          when: new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC",
            weekday: "short",
            month: "short",
            day: "numeric",
          }).format(new Date(`${row.date}T12:00:00Z`)),
          room: null,
        }
      : null;
  }
  const r = await c.query<{
    name: string;
    party_size: number;
    starts_at: string;
    room: string | null;
    time_zone: string;
  }>(
    `select g.name, b.party_size, to_json(b.starts_at) #>> '{}' as starts_at, r.name as room, v.time_zone
       from bookings b
       join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
       join venues v on v.id = b.venue_id
       left join rooms r on r.venue_id = b.venue_id and r.id = b.room_id
      where b.venue_id = $1 and b.id = $2`,
    [venueId, refId],
  );
  const row = r.rows[0];
  return row
    ? {
        guestName: row.name,
        partySize: row.party_size,
        when: venueTime(row.starts_at, row.time_zone),
        room: row.room,
      }
    : null;
}

export function makeBookingInboxHandler(email: Pick<EmailSettings, "allowList">): JobHandler {
  return async ({ job, clock, step }) => {
    const payload = job.payload as { event?: InboxEvent; ref_id?: string };
    if (!payload.event || !payload.ref_id) return;
    const { event, ref_id: refId } = payload;
    await step(async (c) => {
      const contacts = await c.query<{ value: { bookingEmails?: string[] } }>(
        `select value from venue_settings where venue_id = $1 and key = 'contacts'
          order by version desc limit 1`,
        [job.venue_id],
      );
      const to = contacts.rows[0]?.value.bookingEmails ?? [];
      if (to.length === 0) return;
      const found = await details(c, job.venue_id, event, refId);
      if (!found) return;
      const venue = await c.query<{ name: string }>("select name from venues where id = $1", [
        job.venue_id,
      ]);
      for (const address of to)
        await enqueueEmail(c, email, {
          venueId: job.venue_id,
          to: address,
          locale: "en",
          template: "booking_inbox",
          runAt: clock.now(),
          dedupeKey: `${job.id}:${address}`,
          data: {
            venueName: venue.rows[0]!.name,
            event,
            guestName: found.guestName,
            partySize: found.partySize,
            when: found.when,
            room: found.room,
          },
        });
    });
  };
}
