import {
  conversationFor,
  insertOutbound,
  marketingConsent,
  templateByKey,
  twilioIntegration,
  venueModules,
  type Queryable,
} from "@west4/db";
import { marketingWindow } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { enqueue, optedOut } from "@west4/db";
import { ApiError } from "../http/errors.js";
import type { VenueTextSettings } from "./venue.js";

/**
 * Queueing a guest text (M2-09; spec 11; spec 12 · 8). The message is written
 * as `sending` with its words, and a job in the normal pool sends it. Refused:
 * a number outside +1, a number outside staging's test phones, a template
 * that's off, any service text with Guest texts off, more than the per-prefix
 * limit in an hour, and (where the setting asks, as production does) any text
 * before the venue's 10DLC campaign is approved. A marketing text also needs
 * Marketing texts on, its own approved campaign, the guest's marketing opt-in
 * with proof, and 8 AM to 9 PM in the recipient's zone (M8-22).
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
    /** A practice check's text (training mode, M7-03): refused, since practice never texts a guest. */
    training?: boolean;
  },
  settings: SendSettings,
): Promise<{ messageId: string }> {
  const practice =
    input.training === true ||
    (input.context?.kind === "session" &&
      (
        await c.query("select 1 from room_sessions where venue_id = $1 and id = $2 and training", [
          venueId,
          input.context.id,
        ])
      ).rowCount === 1);
  if (practice)
    throw new ApiError("forbidden", "practice never texts a guest", {
      details: { reason: "training" },
    });
  const template = await templateByKey(c, venueId, input.templateKey);
  if (!template) throw new ApiError("not_found", `no text "${input.templateKey}"`);
  if (
    template.category === "marketing" &&
    (await venueModules(c, venueId)).find((m) => m.module_id === "marketing_texts")?.state !== "on"
  )
    throw new ApiError("invalid_request", "marketing texts stay off while Marketing texts is off", {
      details: { reason: "marketing" },
    });
  if (!template.on)
    throw new ApiError("invalid_request", "that text is off", {
      details: { reason: "template_off" },
    });
  await guardSend(c, venueId, input.to, input.now, settings);
  if (template.category === "marketing")
    await guardMarketing(c, venueId, input.to, input.now, settings);
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
    category: template.category,
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
export type SendSettings = Pick<VenueTextSettings, "allowList"> &
  Partial<Pick<VenueTextSettings, "requireApprovedCampaign">>;

export async function guardSend(
  c: Queryable,
  venueId: string,
  to: string,
  now: Temporal.Instant,
  settings: SendSettings,
): Promise<void> {
  const input = { to, now };
  if (await optedOut(c, venueId, to))
    throw new ApiError("invalid_request", "this number opted out of texts", {
      details: { reason: "opted_out" },
    });
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
  if (settings.requireApprovedCampaign === true) {
    // Production texts real numbers only on an approved 10DLC campaign (M8-22).
    const twilio = await twilioIntegration(c, venueId);
    if (twilio?.campaign.status !== "approved")
      throw new ApiError("invalid_request", "the venue's texting campaign isn't approved yet", {
        details: { reason: "campaign_not_approved" },
      });
  }
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

/**
 * What a marketing text passes on top of guardSend (M8-22; spec 11 · Consent
 * and timing; the Marketing texts module is checked first, in queueText): its
 * own approved campaign where the setting asks, the number's marketing opt-in with proof, and the sending window.
 */
export async function guardMarketing(
  c: Queryable,
  venueId: string,
  to: string,
  now: Temporal.Instant,
  settings: SendSettings,
): Promise<void> {
  if (settings.requireApprovedCampaign === true) {
    const twilio = await twilioIntegration(c, venueId);
    if (twilio?.marketingCampaign.status !== "approved")
      throw new ApiError("invalid_request", "the venue's marketing campaign isn't approved yet", {
        details: { reason: "campaign_not_approved" },
      });
  }
  if (!(await marketingConsent(c, venueId, to)))
    throw new ApiError("invalid_request", "marketing texts need the guest's own opt-in first", {
      details: { reason: "no_marketing_consent" },
    });
  const venue = await c.query<{ time_zone: string }>("select time_zone from venues where id = $1", [
    venueId,
  ]);
  const check = marketingWindow(now, to, venue.rows[0]?.time_zone ?? "America/New_York");
  if (!check.ok)
    throw new ApiError(
      "invalid_request",
      "marketing texts go only between 8 AM and 9 PM where the guest is",
      { details: { reason: check.reason === "unknown_area" ? "unknown_area" : "outside_hours" } },
    );
}

/** Writes the outbound message and queues its one send attempt. */
export async function queueOutbound(
  c: Queryable,
  venueId: string,
  input: {
    conversationId: string;
    templateId: string | null;
    category: "service" | "marketing" | "reply";
    body: string;
    sentBy: string | null;
    now: Temporal.Instant;
    stopConfirmation?: boolean;
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
