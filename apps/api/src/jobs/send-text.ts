import { z } from "zod";
import {
  decryptSecret,
  enqueue,
  twilioIntegration,
  type JobHandler,
  type Queryable,
} from "@west4/db";
import { t, type Locale, type Temporal } from "@west4/shared";
import { textsLive, type LiveSettings } from "../texts/live.js";
import type { VenueTextClient } from "../texts/venue.js";

/**
 * One staff text (M1-23), from the normal pool: a phone code, a PIN-reset link, an invite or the
 * order-waiting alert. It goes from the venue's own Twilio account and number (T-03; D123), never
 * from one of ours; the caller checked the venue's texts were live and sent by email otherwise.
 * Every text is a named template with typed data, rendered from the catalogs in the person's
 * language. No template takes a PIN: a payload with one is rejected.
 */
export const TEXT_SEND_KIND = "text.send";

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "an E.164 number");

export const textJobPayload = z.discriminatedUnion("template", [
  z
    .object({
      template: z.literal("phone_code"),
      to: e164,
      locale: z.enum(["en", "es"]),
      data: z
        .object({
          venueName: z.string().min(1),
          code: z.string().regex(/^\d{6}$/),
          minutes: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      template: z.literal("pin_reset_link"),
      to: e164,
      locale: z.enum(["en", "es"]),
      data: z
        .object({
          venueName: z.string().min(1),
          url: z.string().url(),
          hours: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  // A staff invite sent to a phone (O-11; spec 17 · Step details 9): the person confirms it and sets their PIN.
  z
    .object({
      template: z.literal("invite_link"),
      to: e164,
      locale: z.enum(["en", "es"]),
      data: z
        .object({
          venueName: z.string().min(1),
          inviterName: z.string().max(80),
          url: z.string().url(),
          hours: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  // The manager on duty, when a room's order has waited 6 minutes unaccepted (M3-16).
  z
    .object({
      template: z.literal("order_waiting"),
      to: e164,
      locale: z.enum(["en", "es"]),
      data: z
        .object({
          venueName: z.string().min(1),
          room: z.string().min(1),
          minutes: z.number().int().positive(),
          items: z.string().min(1).max(200),
        })
        .strict(),
    })
    .strict(),
]);

export type TextJobPayload = z.infer<typeof textJobPayload>;

export function renderText(payload: TextJobPayload): string {
  const locale: Locale = payload.locale;
  switch (payload.template) {
    case "phone_code":
      return t(locale, "text.phoneCode", {
        venue: payload.data.venueName,
        code: payload.data.code,
        minutes: payload.data.minutes,
      });
    case "pin_reset_link":
      return t(locale, "text.pinResetLink", {
        venue: payload.data.venueName,
        url: payload.data.url,
        hours: payload.data.hours,
      });
    case "invite_link":
      return t(locale, "text.inviteLink", {
        venue: payload.data.venueName,
        inviter: payload.data.inviterName,
        url: payload.data.url,
        hours: payload.data.hours,
      });
    case "order_waiting":
      return t(locale, "text.orderWaiting", {
        venue: payload.data.venueName,
        room: payload.data.room,
        minutes: payload.data.minutes,
        items: payload.data.items,
      });
  }
}

export async function enqueueText(
  client: Queryable,
  args: { readonly venueId: string; readonly runAt: Temporal.Instant } & TextJobPayload,
): Promise<string | null> {
  const { venueId, runAt, ...payload } = args;
  return enqueue(client, {
    venueId,
    kind: TEXT_SEND_KIND,
    pool: "normal",
    runAt,
    payload: textJobPayload.parse(payload),
    maxAttempts: 3,
  });
}

export function makeSendTextHandler(
  deps: { client: VenueTextClient; settings: LiveSettings; secretKey: Buffer } | null,
  log: (line: string) => void = (line) => console.warn(line),
): JobHandler {
  return async ({ job, step }) => {
    const payload = textJobPayload.parse(job.payload);
    const venueId = job.venue_id;
    const twilio = deps
      ? await step(async (c) =>
          (await textsLive(c, venueId, deps.settings, payload.to))
            ? twilioIntegration(c, venueId)
            : null,
        )
      : null;
    // Disconnected (or opted out) since it was queued: nothing goes, and no account of ours stands in.
    if (!deps || !twilio) {
      log(`text.send ${job.id}: the venue's texts aren't live, so nothing was sent`);
      return;
    }
    await deps.client.send(
      { accountSid: twilio.accountSid, authToken: decryptSecret(deps.secretKey, twilio.secretEnc) },
      {
        to: payload.to,
        from: twilio.phoneE164,
        messagingServiceSid: twilio.campaign.serviceSid,
        body: renderText(payload),
        statusCallback: null,
      },
    );
  };
}
