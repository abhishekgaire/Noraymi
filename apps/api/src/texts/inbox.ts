import {
  conversationById,
  conversationFor,
  emitEvent,
  insertInbound,
  readSetting,
  templateByKey,
  type Queryable,
} from "@west4/db";
import { businessDate, wallClock } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { managerOnDutyAt } from "../approvals/service.js";
import { ApiError } from "../http/errors.js";
import { enqueuePush } from "../push/send-push.js";
import { venueClock } from "../rooms/assignment.js";
import { guardSend, queueOutbound, render } from "./queue.js";
import type { VenueTextSettings } from "./venue.js";

/**
 * The two-way inbox (M2-22; spec 11 · Two-way inbox). A guest's text goes into
 * their conversation, unread, with an assignee (the manager on duty), and
 * tells the board, the badges and that manager's phone. Staff reply in free
 * text only in an open service conversation, never with a link or a
 * promotion; a template text can go in a conversation too.
 */
type Context = { kind: "booking" | "waitlist" | "session"; id: string };

/** The current business date's bounds, in instants. */
async function tonight(c: Queryable, venueId: string, now: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const from = wallClock(date, venue.dayCutover, venue.timeZone, venue.dayCutover);
  const to = wallClock(date.add({ days: 1 }), venue.dayCutover, venue.timeZone, venue.dayCutover);
  return { date, from, to };
}

/**
 * Where a guest's text goes. The number's open conversation (one with a text
 * either way tonight); otherwise its context tonight, in this order (the
 * cautious reading, flagged): an open room session, a waiting waitlist entry
 * (from the waitlist ticket on), tonight's booking, then the next booking.
 */
export async function matchConversation(
  c: Queryable,
  venueId: string,
  phone: string,
  now: Temporal.Instant,
): Promise<string> {
  const night = await tonight(c, venueId, now);
  const open = await c.query<{ id: string }>(
    `select cv.id from conversations cv
      where cv.venue_id = $1 and cv.phone_e164 = $2
        and exists (select 1 from messages m where m.venue_id = cv.venue_id and m.conversation_id = cv.id and m.created_at >= $3)
      order by (select max(m.created_at) from messages m where m.venue_id = cv.venue_id and m.conversation_id = cv.id) desc
      limit 1`,
    [venueId, phone, night.from.toString()],
  );
  if (open.rows[0]) return open.rows[0].id;
  const guest = (
    await c.query<{ id: string }>(
      "select id from guests where venue_id = $1 and phone_e164 = $2 order by created_at desc limit 1",
      [venueId, phone],
    )
  ).rows[0];
  let context: Context | null = null;
  if (guest) {
    const session = await c.query<{ id: string }>(
      `select s.id from room_sessions s join bookings b on b.venue_id = s.venue_id and b.id = s.booking_id
        where s.venue_id = $1 and b.guest_id = $2 and s.ended_at is null order by s.started_at desc limit 1`,
      [venueId, guest.id],
    );
    if (session.rows[0]) context = { kind: "session", id: session.rows[0].id };
    if (!context) {
      const booking = await c.query<{ id: string }>(
        `select id from bookings where venue_id = $1 and guest_id = $2 and status in ('pending', 'confirmed')
           and starts_at >= $3 and starts_at < $4 order by starts_at limit 1`,
        [venueId, guest.id, night.from.toString(), night.to.toString()],
      );
      if (booking.rows[0]) context = { kind: "booking", id: booking.rows[0].id };
    }
    if (!context) {
      const next = await c.query<{ id: string }>(
        `select id from bookings where venue_id = $1 and guest_id = $2 and status in ('pending', 'confirmed')
           and starts_at >= $3 order by starts_at limit 1`,
        [venueId, guest.id, now.toString()],
      );
      if (next.rows[0]) context = { kind: "booking", id: next.rows[0].id };
    }
  }
  return conversationFor(c, venueId, {
    phoneE164: phone,
    guestId: guest?.id ?? null,
    contextKind: context?.kind ?? null,
    contextId: context?.id ?? null,
  });
}

/** An incoming text: into its conversation, unread, assigned, and the board, badges and manager's phone told. */
export async function receiveText(
  c: Queryable,
  venueId: string,
  input: { from: string; body: string; sid: string | null; now: Temporal.Instant },
) {
  const conversationId = await matchConversation(c, venueId, input.from, input.now);
  const messageId = await insertInbound(c, venueId, {
    conversationId,
    body: input.body,
    sid: input.sid,
    at: input.now.toString(),
  });
  const onDuty = await managerOnDutyAt(c, venueId, input.now);
  if (onDuty)
    await c.query(
      "update conversations set assigned_to = coalesce(assigned_to, $3) where venue_id = $1 and id = $2",
      [venueId, conversationId, onDuty],
    );
  await emitEvent(c, {
    venueId,
    type: "message.received",
    entityId: conversationId,
    entityVersion: 0,
  });
  const conversation = (await conversationById(c, venueId, conversationId))!;
  if (onDuty)
    await enqueuePush(c, {
      venueId,
      audience: { kind: "person", userId: onDuty },
      message: {
        key: "messages.push",
        params: { name: conversation.guest_name ?? conversation.phone_e164 },
        url: `/messages?c=${conversationId}`,
        tag: `conversation-${conversationId}`,
      },
      runAt: input.now,
    });
  return { conversationId, messageId };
}

/** A link of any kind: a scheme, www., or a dotted name with a top-level domain ("west4karaoke.com/book"). */
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/|\b))/i;
/** Promotion words (cautious list, flagged): offers, discounts and deals belong in marketing texts with opt-in. */
const PROMOTION =
  /(\b\d+\s?% off\b|\bdiscount|\bpromo|\bcoupon|\bspecial offer|\bdeal\b|\bdeals\b|\bsale\b|\bhappy hour\b|\bbogo\b)/i;

export function replyProblem(body: string): "link" | "promotion" | null {
  if (LINK.test(body)) return "link";
  if (PROMOTION.test(body)) return "promotion";
  return null;
}

const OPEN_FOR_HOURS = 24;

/** A free-text reply: only in an open service conversation (the guest wrote in the last 24 hours), no link, no promotion. */
export async function sendReply(
  c: Queryable,
  venueId: string,
  conversationId: string,
  input: { body: string; userId: string; now: Temporal.Instant },
  settings: Pick<VenueTextSettings, "allowList">,
): Promise<string> {
  const conversation = await conversationById(c, venueId, conversationId);
  if (!conversation) throw new ApiError("not_found", "no such conversation");
  const lastIn = conversation.last_inbound_at
    ? Temporal.Instant.from(conversation.last_inbound_at)
    : null;
  if (!lastIn || Temporal.Instant.compare(lastIn.add({ hours: OPEN_FOR_HOURS }), input.now) < 0)
    throw new ApiError("invalid_request", "staff reply in free text only after the guest writes", {
      details: { reason: "not_open" },
    });
  const problem = replyProblem(input.body);
  if (problem)
    throw new ApiError(
      "invalid_request",
      problem === "link" ? "a reply can't carry a link" : "a reply can't carry a promotion",
      { details: { reason: problem } },
    );
  await guardSend(c, venueId, conversation.phone_e164, input.now, settings);
  const id = await queueOutbound(c, venueId, {
    conversationId,
    templateId: null,
    category: "reply",
    body: input.body,
    sentBy: input.userId,
    now: input.now,
  });
  await emitEvent(c, { venueId, type: "message.updated", entityId: id, entityVersion: 0 });
  return id;
}

/** A template text in a conversation, to the conversation's number and context. */
export async function sendTemplateIn(
  c: Queryable,
  venueId: string,
  conversationId: string,
  input: {
    templateKey: string;
    params: Readonly<Record<string, string | number>>;
    userId: string;
    now: Temporal.Instant;
  },
  settings: Pick<VenueTextSettings, "allowList">,
): Promise<string> {
  const conversation = await conversationById(c, venueId, conversationId);
  if (!conversation) throw new ApiError("not_found", "no such conversation");
  const template = await templateByKey(c, venueId, input.templateKey);
  if (!template) throw new ApiError("not_found", `no text "${input.templateKey}"`);
  if (template.category === "marketing")
    throw new ApiError("invalid_request", "marketing texts need their own opt-in first", {
      details: { reason: "marketing" },
    });
  if (!template.on)
    throw new ApiError("invalid_request", "that text is off", {
      details: { reason: "template_off" },
    });
  await guardSend(c, venueId, conversation.phone_e164, input.now, settings);
  const id = await queueOutbound(c, venueId, {
    conversationId,
    templateId: template.id,
    category: "service",
    body: render(template.body, input.params),
    sentBy: input.userId,
    now: input.now,
  });
  await emitEvent(c, { venueId, type: "message.updated", entityId: id, entityVersion: 0 });
  return id;
}

/**
 * The Running late reply: the booking held until a time (by default its start
 * plus `deposit.graceMin`; staff can change it before sending), and "No
 * problem. We'll hold your room until 10:45 PM." in its conversation.
 */
export async function runningLateReply(
  c: Queryable,
  venueId: string,
  conversationId: string,
  input: { until: Temporal.Instant | null; userId: string; now: Temporal.Instant },
  settings: Pick<VenueTextSettings, "allowList">,
) {
  const conversation = await conversationById(c, venueId, conversationId);
  if (!conversation) throw new ApiError("not_found", "no such conversation");
  if (conversation.context_kind !== "booking" || !conversation.context_id)
    throw new ApiError("invalid_request", "a running-late reply needs the conversation's booking");
  const booking = (
    await c.query<{ id: string; starts_at: string; business_date: string; status: string }>(
      `select id, to_json(starts_at) #>> '{}' as starts_at, business_date::text, status from bookings
        where venue_id = $1 and id = $2 for update`,
      [venueId, conversation.context_id],
    )
  ).rows[0];
  if (!booking || !["pending", "confirmed"].includes(booking.status))
    throw new ApiError("invalid_request", "that booking isn't waiting for its party");
  const deposit = await readSetting(
    c,
    venueId,
    "deposit",
    Temporal.PlainDate.from(booking.business_date),
  );
  const until =
    input.until ??
    Temporal.Instant.from(booking.starts_at).add({ minutes: deposit?.value.graceMin ?? 15 });
  if (Temporal.Instant.compare(until, Temporal.Instant.from(booking.starts_at)) < 0)
    throw new ApiError("invalid_request", "the hold can't end before the booking starts");
  await c.query("update bookings set running_late_until = $3 where venue_id = $1 and id = $2", [
    venueId,
    booking.id,
    until.toString(),
  ]);
  const venue = await venueClock(c, venueId);
  const z = until.toZonedDateTimeISO(venue.timeZone);
  const hour = z.hour % 12 === 0 ? 12 : z.hour % 12;
  const time = `${hour}:${String(z.minute).padStart(2, "0")} ${z.hour < 12 ? "AM" : "PM"}`;
  const messageId = await sendTemplateIn(
    c,
    venueId,
    conversationId,
    {
      templateKey: "running_late_reply",
      params: { until: time },
      userId: input.userId,
      now: input.now,
    },
    settings,
  );
  await emitEvent(c, { venueId, type: "booking.updated", entityId: booking.id, entityVersion: 0 });
  return { message_id: messageId, running_late_until: until.toString() };
}
