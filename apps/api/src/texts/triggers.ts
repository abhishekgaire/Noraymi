import type pg from "pg";
import { z } from "zod";
import {
  blocksBetween,
  enqueue,
  readSetting,
  withVenue,
  type JobHandler,
  type Queryable,
  type Sweep,
} from "@west4/db";
import { businessDate, wallClock } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { nightOf, venueClock } from "../rooms/assignment.js";
import { queueText } from "./queue.js";
import type { VenueTextSettings } from "./venue.js";

/**
 * The automatic texts on their triggers (M2-24; spec 11 · The automatic
 * texts; spec 05 · rule 4). A sweep each minute finds what's due and queues
 * one job per trigger, keyed by its dedupe key, so each text goes once:
 *   Reminder, on the day of a confirmed booking at `messages.reminderAt`
 *     (none while it's empty);
 *   Please wrap up, `alerts.roomEndingMin` before the booked end when someone
 *     is booked next in the room; Booked time ending at the same time when
 *     nobody is, except in the last 30 minutes before the close, when no
 *     offer to stay on goes out.
 * The job queues the text the usual way, so a text switched off in Admin, an
 * opt-out or Guest texts off stops it there.
 */
export const TEXT_TRIGGER_KIND = "text.trigger";
export const TEXT_TRIGGER_EVERY_MS = 60_000;
const NO_STAY_OFFER_MIN = 30;

const payload = z
  .object({
    template_key: z.string(),
    to: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    guest_id: z.string().uuid().nullable(),
    context: z
      .object({ kind: z.enum(["booking", "waitlist", "session"]), id: z.string().uuid() })
      .nullable(),
  })
  .strict();
type TriggerPayload = z.infer<typeof payload>;

/** "11:00 PM", or "4 AM" on the hour when `short`. */
export function clockWords(at: Temporal.Instant, timeZone: string, short = false): string {
  const z = at.toZonedDateTimeISO(timeZone);
  const hour = z.hour % 12 === 0 ? 12 : z.hour % 12;
  const suffix = z.hour < 12 ? "AM" : "PM";
  return short && z.minute === 0
    ? `${hour} ${suffix}`
    : `${hour}:${String(z.minute).padStart(2, "0")} ${suffix}`;
}

/** Plans what's due at `now` and queues one job per trigger; returns the dedupe keys it queued. */
export async function planTextTriggers(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<string[]> {
  const venue = await venueClock(c, venueId);
  const night = await nightOf(c, venueId, venue, now);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const [alerts, messages] = await Promise.all([
    readSetting(c, venueId, "alerts", date),
    readSetting(c, venueId, "messages", date),
  ]);
  const noticeMin = alerts?.value.roomEndingMin ?? 10;
  const queued: string[] = [];
  const queue = async (key: string, p: TriggerPayload) => {
    const id = await enqueue(c, {
      venueId,
      kind: TEXT_TRIGGER_KIND,
      pool: "normal",
      runAt: now,
      dedupeKey: key,
      payload: p,
    });
    if (id) queued.push(key);
  };

  // Wrap-up: sessions whose booked end is within the notice.
  const sessions = await c.query<{
    id: string;
    room_id: string;
    room_name: string;
    booked_end_at: string;
    guest_id: string;
    phone: string;
  }>(
    `select s.id, s.room_id, r.name as room_name, to_json(s.booked_end_at) #>> '{}' as booked_end_at,
            g.id as guest_id, g.phone_e164 as phone
       from room_sessions s
       join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
       join bookings b on b.venue_id = s.venue_id and b.id = s.booking_id
       join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
      where s.venue_id = $1 and s.ended_at is null and not s.training and s.booked_end_at is not null and g.phone_e164 is not null
        and s.booked_end_at > $2::timestamptz and s.booked_end_at <= $2::timestamptz + make_interval(mins => $3)`,
    [venueId, now.toString(), noticeMin],
  );
  if (sessions.rows.length > 0) {
    const blocks = await blocksBetween(c, venueId, now, night.close ?? now.add({ hours: 24 }));
    for (const s of sessions.rows) {
      const end = Temporal.Instant.from(s.booked_end_at);
      const bookedNext = blocks.some(
        (b) =>
          b.room_id === s.room_id &&
          (b.kind === "booking" || b.kind === "hold") &&
          Temporal.Instant.compare(Temporal.Instant.from(b.starts_at), now) >= 0,
      );
      const key = `text:wrap:${s.id}:${end.epochMilliseconds}`;
      const common = {
        to: s.phone,
        guest_id: s.guest_id,
        context: { kind: "session" as const, id: s.id },
      };
      if (bookedNext)
        await queue(key, {
          ...common,
          template_key: "please_wrap_up",
          params: { room: s.room_name },
        });
      else if (
        night.close &&
        Temporal.Instant.compare(end, night.close.subtract({ minutes: NO_STAY_OFFER_MIN })) < 0
      )
        await queue(key, {
          ...common,
          template_key: "booked_time_ending",
          params: {
            room: s.room_name,
            end: clockWords(end, venue.timeZone),
            close: clockWords(night.close, venue.timeZone, true),
          },
        });
    }
  }

  // Reminder: today's confirmed bookings, once the reminder time has come, before they start.
  const reminderAt = messages?.value.reminderAt ?? null;
  if (reminderAt) {
    const due = wallClock(date, reminderAt, venue.timeZone, venue.dayCutover);
    if (Temporal.Instant.compare(now, due) >= 0) {
      const address =
        (
          await c.query<{ address: string | null }>("select address from venues where id = $1", [
            venueId,
          ])
        ).rows[0]?.address ?? "";
      const name =
        (await c.query<{ name: string }>("select name from venues where id = $1", [venueId]))
          .rows[0]?.name ?? "";
      const bookings = await c.query<{
        id: string;
        party_size: number;
        starts_at: string;
        guest_id: string;
        phone: string;
      }>(
        `select b.id, b.party_size, to_json(b.starts_at) #>> '{}' as starts_at, g.id as guest_id, g.phone_e164 as phone
           from bookings b join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
          where b.venue_id = $1 and b.status = 'confirmed' and b.business_date = $2::date
            and b.starts_at > $3::timestamptz and g.phone_e164 is not null`,
        [venueId, date.toString(), now.toString()],
      );
      for (const b of bookings.rows)
        await queue(`text:reminder:${b.id}`, {
          template_key: "reminder",
          to: b.phone,
          guest_id: b.guest_id,
          context: { kind: "booking", id: b.id },
          params: {
            venue: name,
            party: b.party_size,
            time: clockWords(Temporal.Instant.from(b.starts_at), venue.timeZone),
            address,
          },
        });
    }
  }
  // Offer expiring: `messages.offerExpiringMin` before a waitlist offer runs out (M2-26).
  const expiringMin = messages?.value.offerExpiringMin ?? 0;
  if (expiringMin > 0) {
    const offers = await c.query<{ id: string; guest_id: string; phone: string; expires: string }>(
      `select w.id, g.id as guest_id, g.phone_e164 as phone, to_json(w.offer_expires_at) #>> '{}' as expires
         from waitlist_entries w join guests g on g.venue_id = w.venue_id and g.id = w.guest_id
        where w.venue_id = $1 and w.status = 'offered' and g.phone_e164 is not null
          and w.offer_expires_at > $2::timestamptz
          and w.offer_expires_at <= $2::timestamptz + make_interval(mins => $3)`,
      [venueId, now.toString(), expiringMin],
    );
    if (offers.rows.length > 0) {
      const name =
        (await c.query<{ name: string }>("select name from venues where id = $1", [venueId]))
          .rows[0]?.name ?? "";
      for (const o of offers.rows)
        await queue(
          `text:offer_expiring:${o.id}:${Temporal.Instant.from(o.expires).epochMilliseconds}`,
          {
            template_key: "offer_expiring",
            to: o.phone,
            guest_id: o.guest_id,
            context: { kind: "waitlist", id: o.id },
            params: { venue: name },
          },
        );
    }
  }
  return queued;
}

/** Sends a planned text the usual way; a text that can't go (off, opted out, Guest texts off) just doesn't. */
export function makeTextTriggerHandler(settings: Pick<VenueTextSettings, "allowList">): JobHandler {
  return async ({ job, clock, step }) => {
    const p = payload.parse(job.payload);
    await step(async (c) => {
      // The guest and the context are ids in this job's venue, or the trigger is stale: it sends nothing.
      if (p.guest_id) {
        const guest = await c.query("select 1 from guests where venue_id = $1 and id = $2", [
          job.venue_id,
          p.guest_id,
        ]);
        if (!guest.rowCount) return;
      }
      if (p.context) {
        const table =
          p.context.kind === "session"
            ? "room_sessions"
            : p.context.kind === "booking"
              ? "bookings"
              : "waitlist_entries";
        const found = await c.query(`select 1 from ${table} where venue_id = $1 and id = $2`, [
          job.venue_id,
          p.context.id,
        ]);
        if (!found.rowCount) return;
      }
      try {
        await queueText(
          c,
          job.venue_id,
          {
            templateKey: p.template_key,
            to: p.to,
            params: p.params,
            guestId: p.guest_id,
            context: p.context,
            sentBy: null,
            now: clock.now(),
          },
          settings,
        );
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
      }
    });
  };
}

export async function sweepTextTriggers(pool: pg.Pool, now: Temporal.Instant) {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  const out: { venueId: string; keys: string[] }[] = [];
  for (const v of venues.rows) {
    const keys = await withVenue(pool, { venueId: v.id, requestId: "sweep:texts" }, (c) =>
      planTextTriggers(c, v.id, now),
    );
    if (keys.length > 0) out.push({ venueId: v.id, keys });
  }
  return out;
}

export function textTriggerSweep(pool: pg.Pool): Sweep {
  return {
    name: "text-triggers",
    everyMs: TEXT_TRIGGER_EVERY_MS,
    run: async (now) => void (await sweepTextTriggers(pool, now)),
  };
}
