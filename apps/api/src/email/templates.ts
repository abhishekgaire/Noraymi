import { z } from "zod";
import { locales, t, type Locale, type MessageKey } from "@west4/shared";

/**
 * Every email is a named template with typed data (M1-18). The words come from
 * the i18n catalogs, in the person's own language. No template takes a PIN,
 * a code hash or a password: the schemas below are the whole list of what an
 * email can carry, and a job payload with anything else is rejected.
 */
export const inviteData = z
  .object({
    venueName: z.string().min(1),
    inviteeName: z.string().min(1),
    inviterName: z.string().min(1),
    inviteUrl: z.string().url(),
    expiresHours: z.number().int().positive(),
  })
  .strict();

/** The one-time code for the authenticator-app sign-in and the first enrollment (M1-19). */
export const signInCodeData = z
  .object({
    venueName: z.string().min(1),
    name: z.string().min(1),
    code: z.string().regex(/^\d{6}$/),
    expiresMinutes: z.number().int().positive(),
  })
  .strict();

export const templateSchemas = {
  invite: inviteData,
  sign_in_code: signInCodeData,
} as const;

export type TemplateName = keyof typeof templateSchemas;
export type TemplateData<N extends TemplateName> = z.infer<(typeof templateSchemas)[N]>;

export const templateNames = Object.keys(templateSchemas) as TemplateName[];
export const localeSchema = z.enum(locales);

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Fill `{name}` slots. A slot with no value stays visible, so a test catches it. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function render<N extends TemplateName>(
  name: N,
  locale: Locale,
  data: TemplateData<N>,
): RenderedEmail {
  switch (name) {
    case "invite": {
      const d = data as TemplateData<"invite">;
      const values = {
        venue: d.venueName,
        name: d.inviteeName,
        inviter: d.inviterName,
        url: d.inviteUrl,
        hours: d.expiresHours,
      };
      const line = (key: MessageKey) => fill(t(locale, key), values);
      const paragraphs = [
        line("email.invite.greeting"),
        line("email.invite.body"),
        `${line("email.invite.button")}: ${d.inviteUrl}`,
        line("email.invite.expires"),
        line("email.invite.ignore"),
        line("email.footer"),
      ];
      const html = [
        `<p>${escapeHtml(paragraphs[0]!)}</p>`,
        `<p>${escapeHtml(paragraphs[1]!)}</p>`,
        `<p><a href="${escapeHtml(d.inviteUrl)}">${escapeHtml(line("email.invite.button"))}</a></p>`,
        `<p>${escapeHtml(paragraphs[3]!)}</p>`,
        `<p>${escapeHtml(paragraphs[4]!)}</p>`,
        `<p style="color:#666">${escapeHtml(paragraphs[5]!)}</p>`,
      ].join("\n");
      return { subject: line("email.invite.subject"), text: paragraphs.join("\n\n"), html };
    }
    case "sign_in_code": {
      const d = data as TemplateData<"sign_in_code">;
      const values = { venue: d.venueName, name: d.name, code: d.code, minutes: d.expiresMinutes };
      const line = (key: MessageKey) => fill(t(locale, key), values);
      const paragraphs = [
        line("email.signInCode.greeting"),
        line("email.signInCode.body"),
        d.code,
        line("email.signInCode.expires"),
        line("email.signInCode.ignore"),
        line("email.footer"),
      ];
      const html = [
        `<p>${escapeHtml(paragraphs[0]!)}</p>`,
        `<p>${escapeHtml(paragraphs[1]!)}</p>`,
        `<p style="font-size:28px;letter-spacing:6px"><strong>${escapeHtml(d.code)}</strong></p>`,
        `<p>${escapeHtml(paragraphs[3]!)}</p>`,
        `<p>${escapeHtml(paragraphs[4]!)}</p>`,
        `<p style="color:#666">${escapeHtml(paragraphs[5]!)}</p>`,
      ].join("\n");
      return { subject: line("email.signInCode.subject"), text: paragraphs.join("\n\n"), html };
    }
  }
}
