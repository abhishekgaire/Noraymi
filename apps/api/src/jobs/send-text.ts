import { z } from "zod";
import { enqueue, type JobHandler, type Queryable } from "@west4/db";
import { t, type Locale, type Temporal } from "@west4/shared";
import type { TextSender } from "../texts/sender.js";

/**
 * One text from the platform's account (M1-23), from the normal pool. Every
 * text is a named template with typed data, rendered from the catalogs in the
 * person's language. No template takes a PIN: a payload with one is rejected.
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

export function makeSendTextHandler(sender: TextSender): JobHandler {
  return async ({ job }) => {
    const payload = textJobPayload.parse(job.payload);
    await sender.send({ to: payload.to, body: renderText(payload), idempotencyKey: job.id });
  };
}
