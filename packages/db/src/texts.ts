import type { Queryable } from "./tenancy.js";

/**
 * Guest texts (M2-09; spec 11 · Texts through Twilio). Inside a venue
 * transaction, except the two resolvers, which are the doors for requests
 * that arrive without a venue.
 */
export interface TemplateRow {
  readonly id: string;
  readonly key: string;
  readonly position: number;
  readonly category: "service" | "marketing";
  readonly body: string;
  readonly on: boolean;
}

export async function templates(c: Queryable, venueId: string): Promise<TemplateRow[]> {
  const r = await c.query<TemplateRow>(
    `select id, key, position, category, body, "on" from message_templates where venue_id = $1 order by position`,
    [venueId],
  );
  return r.rows;
}

export async function templateByKey(
  c: Queryable,
  venueId: string,
  key: string,
): Promise<TemplateRow | null> {
  const r = await c.query<TemplateRow>(
    `select id, key, position, category, body, "on" from message_templates where venue_id = $1 and key = $2`,
    [venueId, key],
  );
  return r.rows[0] ?? null;
}

/** The conversation for a phone number and its booking, waitlist spot or session; made on first use. */
export async function conversationFor(
  c: Queryable,
  venueId: string,
  input: {
    phoneE164: string;
    guestId: string | null;
    contextKind: "booking" | "waitlist" | "session" | "enquiry" | null;
    contextId: string | null;
  },
): Promise<string> {
  const found = await c.query<{ id: string }>(
    `select id from conversations
      where venue_id = $1 and phone_e164 = $2 and context_kind is not distinct from $3 and context_id is not distinct from $4
      order by created_at desc limit 1`,
    [venueId, input.phoneE164, input.contextKind, input.contextId],
  );
  if (found.rows[0]) return found.rows[0].id;
  const r = await c.query<{ id: string }>(
    `insert into conversations (venue_id, guest_id, phone_e164, context_kind, context_id) values ($1, $2, $3, $4, $5) returning id`,
    [venueId, input.guestId, input.phoneE164, input.contextKind, input.contextId],
  );
  return r.rows[0]!.id;
}

export interface MessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly direction: "outbound" | "inbound";
  readonly category: string;
  readonly body: string;
  readonly provider_sid: string | null;
  readonly status: "sending" | "sent" | "delivered" | "failed" | "received";
  readonly attempted_at: string | null;
  readonly phone_e164: string;
  /** The one confirmation a STOP gets, which goes despite the opt-out (M2-23). */
  readonly stop_confirmation: boolean;
}

export async function insertOutbound(
  c: Queryable,
  venueId: string,
  input: {
    conversationId: string;
    templateId: string | null;
    category: "service" | "marketing" | "reply";
    body: string;
    sentBy: string | null;
    stopConfirmation?: boolean;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into messages (venue_id, conversation_id, direction, template_id, category, body, sent_by, status, stop_confirmation)
       values ($1, $2, 'outbound', $3, $4, $5, $6, 'sending', $7) returning id`,
    [
      venueId,
      input.conversationId,
      input.templateId,
      input.category,
      input.body,
      input.sentBy,
      input.stopConfirmation ?? false,
    ],
  );
  return r.rows[0]!.id;
}

export async function messageById(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<MessageRow | null> {
  const r = await c.query<MessageRow>(
    `select m.id, m.conversation_id, m.direction, m.category, m.body, m.provider_sid, m.status,
            to_json(m.attempted_at) #>> '{}' as attempted_at, cv.phone_e164, m.stop_confirmation
       from messages m join conversations cv on cv.venue_id = m.venue_id and cv.id = m.conversation_id
      where m.venue_id = $1 and m.id = $2`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** The one attempt: true when this call claimed it, false when a run before already did (never send twice). */
export async function claimSendAttempt(
  c: Queryable,
  venueId: string,
  id: string,
  at: string,
): Promise<boolean> {
  const r = await c.query(
    "update messages set attempted_at = $3 where venue_id = $1 and id = $2 and attempted_at is null and status = 'sending'",
    [venueId, id, at],
  );
  return r.rowCount === 1;
}

export async function recordProviderSid(
  c: Queryable,
  venueId: string,
  id: string,
  sid: string,
  at: string,
): Promise<void> {
  await c.query(
    "update messages set provider_sid = $3, sent_at = $4 where venue_id = $1 and id = $2",
    [venueId, id, sid, at],
  );
}

export async function markMessage(
  c: Queryable,
  venueId: string,
  where: { id?: string; sid?: string },
  status: "sent" | "delivered" | "failed",
): Promise<{ id: string; changed: boolean } | null> {
  // Statuses only move forward: sending → sent → delivered, and failed from either; delivered and failed stay.
  const from =
    status === "sent"
      ? ["sending"]
      : status === "delivered"
        ? ["sending", "sent"]
        : ["sending", "sent"];
  const found = await c.query<{ id: string; status: string }>(
    `select id, status from messages where venue_id = $1 and ${where.id ? "id = $2" : "provider_sid = $2"} for update`,
    [venueId, where.id ?? where.sid],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (!from.includes(row.status)) return { id: row.id, changed: false };
  await c.query("update messages set status = $3 where venue_id = $1 and id = $2", [
    venueId,
    row.id,
    status,
  ]);
  return { id: row.id, changed: true };
}

/** Records a webhook event once; false when it was already recorded (the event runs once). */
export async function recordWebhookEvent(
  c: Queryable,
  venueId: string,
  input: { provider: "stripe" | "twilio"; eventId: string; type: string; payload: unknown },
): Promise<boolean> {
  const r = await c.query(
    `insert into webhook_events (venue_id, provider, event_id, type, payload, processed_at)
       values ($1, $2, $3, $4, $5, now()) on conflict (provider, event_id) do nothing`,
    [venueId, input.provider, input.eventId, input.type, JSON.stringify(input.payload)],
  );
  return r.rowCount === 1;
}

/** The venue a Twilio subaccount or number belongs to; callable without a venue set. */
export async function venueForTwilioAccount(
  c: Queryable,
  accountSid: string,
): Promise<string | null> {
  const r = await c.query<{ venue: string | null }>("select resolve_twilio_account($1) as venue", [
    accountSid,
  ]);
  return r.rows[0]?.venue ?? null;
}

export async function venueForSmsNumber(c: Queryable, number: string): Promise<string | null> {
  const r = await c.query<{ venue: string | null }>("select resolve_sms_number($1) as venue", [
    number,
  ]);
  return r.rows[0]?.venue ?? null;
}

export interface TwilioIntegration {
  readonly accountSid: string;
  readonly phoneE164: string;
  readonly secretEnc: string;
  readonly status: string;
}

export async function twilioIntegration(
  c: Queryable,
  venueId: string,
): Promise<TwilioIntegration | null> {
  const r = await c.query<{
    external_id: string;
    config: { phone_e164?: string; secret_enc?: string };
    status: string;
  }>(
    "select external_id, config, status from integrations where venue_id = $1 and kind = 'twilio'",
    [venueId],
  );
  const row = r.rows[0];
  if (!row?.config.phone_e164 || !row.config.secret_enc) return null;
  return {
    accountSid: row.external_id,
    phoneE164: row.config.phone_e164,
    secretEnc: row.config.secret_enc,
    status: row.status,
  };
}

export async function saveTwilioIntegration(
  c: Queryable,
  venueId: string,
  input: { accountSid: string; phoneE164: string; secretEnc: string; at: string },
): Promise<void> {
  await c.query(
    `insert into integrations (venue_id, kind, status, external_id, config, connected_at)
       values ($1, 'twilio', 'connected', $2, $3, $4)
       on conflict (venue_id, kind) do update set status = 'connected', external_id = excluded.external_id,
         config = excluded.config, connected_at = excluded.connected_at`,
    [
      venueId,
      input.accountSid,
      JSON.stringify({ phone_e164: input.phoneE164, secret_enc: input.secretEnc }),
      input.at,
    ],
  );
}

/** An incoming text (M2-22): into its conversation, unread, the last inbound time moved on. */
export async function insertInbound(
  c: Queryable,
  venueId: string,
  input: { conversationId: string; body: string; sid: string | null; at: string },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into messages (venue_id, conversation_id, direction, category, body, provider_sid, status, sent_at, created_at)
       values ($1, $2, 'inbound', 'reply', $3, $4, 'received', $5, $5) returning id`,
    [venueId, input.conversationId, input.body, input.sid, input.at],
  );
  await c.query(
    "update conversations set unread = unread + 1, last_inbound_at = $3 where venue_id = $1 and id = $2",
    [venueId, input.conversationId, input.at],
  );
  return r.rows[0]!.id;
}

export interface ConversationRow {
  readonly id: string;
  readonly guest_id: string | null;
  readonly guest_name: string | null;
  readonly phone_e164: string;
  readonly context_kind: "booking" | "waitlist" | "session" | "enquiry" | null;
  readonly context_id: string | null;
  readonly unread: number;
  readonly assigned_to: string | null;
  readonly assigned_to_name: string | null;
  readonly last_inbound_at: string | null;
  readonly last_body: string | null;
  readonly last_at: string | null;
  /** The number opted out of texts (M2-23). */
  readonly opted_out: boolean;
}

const CONVERSATION = `select cv.id, cv.guest_id, g.name as guest_name, cv.phone_e164, cv.context_kind, cv.context_id,
    cv.unread, cv.assigned_to, u.name as assigned_to_name, to_json(cv.last_inbound_at) #>> '{}' as last_inbound_at,
    last.body as last_body, to_json(last.created_at) #>> '{}' as last_at,
    exists (select 1 from consents k where k.venue_id = cv.venue_id and k.phone_e164 = cv.phone_e164
             and k.channel = 'sms' and k.kind = 'texts' and k.revoked_at is not null) as opted_out
  from conversations cv
  left join guests g on g.venue_id = cv.venue_id and g.id = cv.guest_id
  left join users u on u.id = cv.assigned_to
  left join lateral (
    select body, created_at from messages m where m.venue_id = cv.venue_id and m.conversation_id = cv.id
     order by created_at desc limit 1
  ) last on true`;

export async function conversations(c: Queryable, venueId: string): Promise<ConversationRow[]> {
  const r = await c.query<ConversationRow>(
    `${CONVERSATION} where cv.venue_id = $1 and last.created_at is not null
      order by cv.unread > 0 desc, last.created_at desc limit 200`,
    [venueId],
  );
  return r.rows;
}

export async function conversationById(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<ConversationRow | null> {
  const r = await c.query<ConversationRow>(
    `${CONVERSATION} where cv.venue_id = $1 and cv.id = $2`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

export interface ThreadMessageRow {
  readonly id: string;
  readonly direction: "outbound" | "inbound";
  readonly category: "service" | "marketing" | "reply";
  readonly automatic: boolean;
  readonly body: string;
  readonly status: string;
  readonly sent_by_name: string | null;
  readonly at: string | null;
}

/** A thread, oldest first; `at` is when it was sent or received, empty when that isn't known. */
export async function threadMessages(
  c: Queryable,
  venueId: string,
  conversationId: string,
): Promise<ThreadMessageRow[]> {
  const r = await c.query<ThreadMessageRow>(
    `select m.id, m.direction, m.category, (m.template_id is not null and m.sent_by is null) as automatic, m.body,
            m.status, u.name as sent_by_name, to_json(m.sent_at) #>> '{}' as at
       from messages m left join users u on u.id = m.sent_by
      where m.venue_id = $1 and m.conversation_id = $2 order by m.created_at, m.id`,
    [venueId, conversationId],
  );
  return r.rows;
}

export async function markConversationRead(
  c: Queryable,
  venueId: string,
  id: string,
  at: string,
): Promise<void> {
  await c.query("update conversations set unread = 0 where venue_id = $1 and id = $2", [
    venueId,
    id,
  ]);
  await c.query(
    "update messages set read_at = $3 where venue_id = $1 and conversation_id = $2 and direction = 'inbound' and read_at is null",
    [venueId, id, at],
  );
}

/** Has this number opted out of texts at the venue (M2-23)? Every send asks first. */
export async function optedOut(c: Queryable, venueId: string, phone: string): Promise<boolean> {
  const r = await c.query(
    `select 1 from consents k left join guests g on g.venue_id = k.venue_id and g.id = k.guest_id
      where k.venue_id = $1 and k.channel = 'sms' and k.kind = 'texts' and k.revoked_at is not null
        and coalesce(k.phone_e164, g.phone_e164) = $2
     union all
     -- An opt-out the retention job (M8-12) kept as a keyed hash after the consent row went.
     select 1 from opt_out_hashes h where h.venue_id = $1 and h.phone_hash = opt_out_hash($2)
      limit 1`,
    [venueId, phone],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Records an opt-out from texts: by keyword (the guest's STOP) or by staff's tap. */
export async function recordOptOut(
  c: Queryable,
  venueId: string,
  input: {
    phone: string;
    guestId: string | null;
    via: "keyword" | "staff";
    at: string;
    source: string;
  },
): Promise<void> {
  await c.query(
    `insert into consents (venue_id, guest_id, phone_e164, channel, kind, source, revoked_at, revoked_via)
       values ($1, $2, $3, 'sms', 'texts', $4, $5, $6)`,
    [venueId, input.guestId, input.phone, input.source, input.at, input.via],
  );
}

/** A queued text an opt-out stopped before it went. */
export async function stopMessage(c: Queryable, venueId: string, id: string): Promise<boolean> {
  const r = await c.query(
    "update messages set status = 'stopped' where venue_id = $1 and id = $2 and status = 'sending' and attempted_at is null",
    [venueId, id],
  );
  return r.rowCount === 1;
}
