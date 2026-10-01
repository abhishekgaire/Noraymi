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
    contextKind: "booking" | "waitlist" | "session" | null;
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
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into messages (venue_id, conversation_id, direction, template_id, category, body, sent_by, status)
       values ($1, $2, 'outbound', $3, $4, $5, $6, 'sending') returning id`,
    [venueId, input.conversationId, input.templateId, input.category, input.body, input.sentBy],
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
            to_json(m.attempted_at) #>> '{}' as attempted_at, cv.phone_e164
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
