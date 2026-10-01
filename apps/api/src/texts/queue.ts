import {
  conversationFor,
  insertOutbound,
  templateByKey,
  venueModules,
  type Queryable,
} from "@west4/db";
import type { Temporal } from "@west4/shared";
import { enqueue } from "@west4/db";
import { ApiError } from "../http/errors.js";
import type { VenueTextSettings } from "./venue.js";

/**
 * Queueing a guest text (M2-09; spec 11; spec 12 · 8). The message is written
 * as `sending` with its words, and a job in the normal pool sends it. Refused:
 * a number outside +1, a number outside staging's test phones, a template
 * that's off, any marketing text (no opt-in yet), any service text with Guest
 * texts off, and more than the per-prefix limit in an hour.
 */
export const MESSAGE_SEND_KIND = "message.send";
/** Cautious default (flagged): at most this many texts an hour to one +1 area code from one venue. */
export const PER_PREFIX_PER_HOUR = 30;

const US = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

export function render(body: string, params: Readonly<Record<string, string | number>>): string {
  return body.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) throw new ApiError("invalid_request", `the text needs {${name}}`);
    return String(value);
  });
}

export async function queueText(
  c: Queryable,
  venueId: string,
  input: {
    templateKey: string;
    to: string;
    params: Readonly<Record<string, string | number>>;
    guestId: string | null;
    context: { kind: "booking" | "waitlist" | "session"; id: string } | null;
    sentBy: string | null;
    now: Temporal.Instant;
  },
  settings: Pick<VenueTextSettings, "allowList">,
): Promise<{ messageId: string }> {
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
  await guardSend(c, venueId, input.to, input.now, settings);
  const body = render(template.body, input.params);
  const conversationId = await conversationFor(c, venueId, {
    phoneE164: input.to,
    guestId: input.guestId,
    contextKind: input.context?.kind ?? null,
    contextId: input.context?.id ?? null,
  });
  const messageId = await queueOutbound(c, venueId, {
    conversationId,
    templateId: template.id,
    category: "service",
    body,
    sentBy: input.sentBy,
    now: input.now,
  });
  return { messageId };
}

/**
 * What every text to a guest passes first (M2-09, shared with replies in
 * M2-22): a US number, the staging allow-list, Guest texts on, and at most
 * PER_PREFIX_PER_HOUR texts an hour to one area code.
 */
export async function guardSend(
  c: Queryable,
  venueId: string,
  to: string,
  now: Temporal.Instant,
  settings: Pick<VenueTextSettings, "allowList">,
): Promise<void> {
  const input = { to, now };
  if (!US.test(input.to))
    throw new ApiError("invalid_request", "texts go only to +1 numbers", {
      details: { reason: "not_us" },
    });
  if (settings.allowList && !settings.allowList.includes(input.to))
    throw new ApiError("invalid_request", "this server texts only our own test phones", {
      details: { reason: "not_allowed" },
    });
  const modules = await venueModules(c, venueId);
  if (modules.find((m) => m.module_id === "guest_texts")?.state === "off")
    throw new ApiError("module_off", "Guest texts are off at this venue");
  const prefix = input.to.slice(0, 5);
  const recent = await c.query<{ n: number }>(
    `select count(*)::int as n from messages m join conversations cv on cv.venue_id = m.venue_id and cv.id = m.conversation_id
      where m.venue_id = $1 and m.direction = 'outbound' and left(cv.phone_e164, 5) = $2 and m.created_at > $3::timestamptz - interval '1 hour'`,
    [venueId, prefix, input.now.toString()],
  );
  if ((recent.rows[0]?.n ?? 0) >= PER_PREFIX_PER_HOUR)
    throw new ApiError("rate_limited", "too many texts to that area code this hour", {
      details: { reason: "prefix_limit" },
    });
}

/** Writes the outbound message and queues its one send attempt. */
export async function queueOutbound(
  c: Queryable,
  venueId: string,
  input: {
    conversationId: string;
    templateId: string | null;
    category: "service" | "reply";
    body: string;
    sentBy: string | null;
    now: Temporal.Instant;
  },
): Promise<string> {
  const messageId = await insertOutbound(c, venueId, input);
  await enqueue(c, {
    venueId,
    kind: MESSAGE_SEND_KIND,
    pool: "normal",
    runAt: input.now,
    payload: { message_id: messageId },
  });
  return messageId;
}
