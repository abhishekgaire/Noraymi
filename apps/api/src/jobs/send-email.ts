import { z } from "zod";
import { enqueue, type JobHandler, type Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import type { Mailer } from "../email/mailer.js";
import { assertAllowed } from "../email/policy.js";
import { ApiError } from "../http/errors.js";
import type { EmailSettings } from "../email/settings.js";
import {
  localeSchema,
  render,
  templateSchemas,
  type TemplateData,
  type TemplateName,
} from "../email/templates.js";
import { htmlToPdf } from "../menu/pdf.js";

/**
 * One email, sent from the normal pool (M1-18). The payload names a template
 * and its typed data; the words are rendered at send time in the person's
 * language, so the queue never stores a rendered body. Strict schemas mean a
 * payload with a PIN or anything else unexpected is rejected, not sent.
 */
export const EMAIL_SEND_KIND = "email.send";

export const emailJobPayload = z.discriminatedUnion("template", [
  z
    .object({
      template: z.literal("receipt"),
      to: z.string().email(),
      locale: localeSchema,
      data: templateSchemas.receipt,
    })
    .strict(),
  z
    .object({
      template: z.literal("invite"),
      to: z.string().email(),
      locale: localeSchema,
      data: templateSchemas.invite,
    })
    .strict(),
  z
    .object({
      template: z.literal("sign_in_code"),
      to: z.string().email(),
      locale: localeSchema,
      data: templateSchemas.sign_in_code,
    })
    .strict(),
  z
    .object({
      template: z.literal("owner_recovery_notice"),
      to: z.string().email(),
      locale: localeSchema,
      data: templateSchemas.owner_recovery_notice,
    })
    .strict(),
  z
    .object({
      template: z.literal("accounting_export"),
      to: z.string().email(),
      locale: localeSchema,
      data: templateSchemas.accounting_export,
    })
    .strict(),
  z
    .object({
      template: z.literal("license_reminder"),
      to: z.string().email(),
      locale: localeSchema,
      data: templateSchemas.license_reminder,
    })
    .strict(),
  z
    .object({
      template: z.literal("money_audit"),
      to: z.string().email(),
      locale: localeSchema,
      data: templateSchemas.money_audit,
    })
    .strict(),
  z
    .object({
      template: z.literal("emergency_action"),
      to: z.string().email(),
      locale: localeSchema,
      data: templateSchemas.emergency_action,
    })
    .strict(),
]);
export type EmailJobPayload = z.infer<typeof emailJobPayload>;

export interface EnqueueEmailOptions<N extends TemplateName> {
  readonly venueId: string;
  readonly to: string;
  readonly locale: z.infer<typeof localeSchema>;
  readonly template: N;
  readonly data: TemplateData<N>;
  readonly runAt: Temporal.Instant;
  readonly dedupeKey?: string | undefined;
}

/**
 * Queue an email inside a venue transaction. On staging an address outside
 * the allow-list is refused here, before a job exists, so the caller sees it.
 */
export async function enqueueEmail<N extends TemplateName>(
  client: Queryable,
  settings: Pick<EmailSettings, "allowList">,
  options: EnqueueEmailOptions<N>,
): Promise<string | null> {
  assertAllowed(settings.allowList, options.to);
  refusePractice(options.template, options.data);
  const payload = emailJobPayload.parse({
    template: options.template,
    to: options.to,
    locale: options.locale,
    data: options.data,
  });
  return enqueue(client, {
    venueId: options.venueId,
    kind: EMAIL_SEND_KIND,
    pool: "normal",
    runAt: options.runAt,
    payload,
    dedupeKey: options.dedupeKey,
  });
}

/** Practice never emails a guest (training mode, M7-03): a practice receipt is refused here and at send time. */
function refusePractice(template: string, data: unknown) {
  if (template === "receipt" && (data as { training?: boolean }).training === true)
    throw new ApiError("forbidden", "practice never emails a guest", {
      details: { reason: "training" },
    });
}

export function makeSendEmailHandler(
  mailer: Mailer,
  settings: EmailSettings,
  /** Renders the receipt PDF attached to a receipt email (M4-19). */
  pdf: (html: string) => Promise<Uint8Array> = htmlToPdf,
): JobHandler {
  return async ({ job }) => {
    const payload = emailJobPayload.parse(job.payload);
    // Checked again at send time: the list may have changed since the job was queued.
    assertAllowed(settings.allowList, payload.to);
    refusePractice(payload.template, payload.data);
    const rendered = render(payload.template, payload.locale, payload.data);
    const attachments =
      payload.template === "receipt"
        ? [
            {
              filename: `receipt-${payload.data.number.replace(/[^A-Za-z0-9]+/g, "")}.pdf`,
              content: await pdf(rendered.html),
              contentType: "application/pdf",
            },
          ]
        : payload.template === "accounting_export"
          ? [
              {
                filename: `west4-${payload.data.kind === "payroll" ? "payroll-" : ""}${payload.data.date}.csv`,
                content: new TextEncoder().encode(payload.data.file),
                contentType: "text/csv",
              },
            ]
          : undefined;
    await mailer.send({
      to: payload.to,
      from: settings.from,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      messageId: `<job-${job.id}@west4.email>`,
      ...(attachments ? { attachments } : {}),
    });
  };
}
