import { z } from "zod";
import { cents, formatMoney, locales, t, type Locale, type MessageKey } from "@west4/shared";

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

/** The notice every owner and manager gets, at once, when an owner's recovery starts (M1-20). */
export const ownerRecoveryNoticeData = z
  .object({
    venueName: z.string().min(1),
    name: z.string().min(1),
    ownerName: z.string().min(1),
    /** "recovery_code": one of the owner's codes was used; "second_owner": requesterName started it. */
    method: z.enum(["recovery_code", "second_owner"]),
    requesterName: z.string().min(1).optional(),
    /** When the recovery is ready, already written out in the venue's time zone and the reader's language. */
    readyAt: z.string().min(1),
  })
  .strict();

/** A receipt (M4-19): the receipt's lines as every render reads them, and its link. */
export const receiptData = z
  .object({
    venueName: z.string().min(1),
    number: z.string().min(1),
    lines: z.array(z.string().max(200)).min(1).max(300),
    link: z.string().url(),
    /** A practice check's receipt (training mode, M7-03): the email job refuses it. */
    training: z.boolean().optional(),
  })
  .strict();

/** The nightly file for QuickBooks (M7-15): the night it's for, and the file, attached as CSV. */
export const accountingExportData = z
  .object({
    venueName: z.string().min(1),
    date: z.string().min(1),
    file: z.string().min(1).max(2_000_000),
    /** M7-16: the payroll file goes the same way. */
    kind: z.enum(["accounting", "payroll"]).optional(),
  })
  .strict();

/** A license's renewal reminder to an owner or manager (M8-09): which license, and when it expires. */
export const licenseReminderData = z
  .object({
    venueName: z.string().min(1),
    kind: z.enum(["liquor", "ascap", "bmi", "sesac", "gmr", "local", "health", "other"]),
    /** The license's number as entered; empty when the owner hasn't entered it. */
    number: z.string().max(100),
    /** YYYY-MM-DD, the venue's date. */
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    daysLeft: z.number().int().min(0),
  })
  .strict();

/** An emergency action on our side (M8-11), to the venue's owner: opened, then ran or didn't finish. */
export const emergencyActionData = z
  .object({
    venueName: z.string().min(1),
    stage: z.enum(["opened", "done", "failed"]),
    action: z.enum(["resync_payment", "cancel_reader_action", "requeue_print", "close_night"]),
    requestedBy: z.string().max(200),
    /** Empty until a second person on our side approves it. */
    approvedBy: z.string().max(200),
    reason: z.string().min(3).max(500),
  })
  .strict();

/** The morning money audit (M9-15) to the venue's owner and our founder: the night, and each money error. */
export const moneyAuditData = z
  .object({
    venueName: z.string().min(1),
    /** YYYY-MM-DD, the business date audited. */
    night: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    errorCount: z.number().int().min(0),
    /** The first errors: kind, the check number or an id, and the difference in cents (amounts only). */
    items: z
      .array(
        z
          .object({
            kind: z.enum([
              "charge",
              "line",
              "tax",
              "gratuity",
              "card_fee",
              "refund",
              "tip",
              "payout",
              "report",
              "drawer",
              "journal",
            ]),
            ref: z.string().max(80),
            diffCents: z.number().int().nullable(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export const templateSchemas = {
  invite: inviteData,
  sign_in_code: signInCodeData,
  owner_recovery_notice: ownerRecoveryNoticeData,
  receipt: receiptData,
  accounting_export: accountingExportData,
  license_reminder: licenseReminderData,
  emergency_action: emergencyActionData,
  money_audit: moneyAuditData,
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
    case "receipt": {
      const d = data as TemplateData<"receipt">;
      const values = { venue: d.venueName, number: d.number, link: d.link };
      const line = (key: MessageKey) => fill(t(locale, key), values);
      const text = [...d.lines, "", line("email.receipt.link"), d.link, "", line("email.footer")];
      const html = [
        `<div style="font-family:monospace;white-space:pre-wrap">${d.lines.map(escapeHtml).join("<br>")}</div>`,
        `<p>${escapeHtml(line("email.receipt.link"))} <a href="${escapeHtml(d.link)}">${escapeHtml(d.link)}</a></p>`,
        `<p style="color:#666">${escapeHtml(line("email.footer"))}</p>`,
      ].join("\n");
      return { subject: line("email.receipt.subject"), text: text.join("\n"), html };
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
    case "accounting_export": {
      const d = data as TemplateData<"accounting_export">;
      const values = { venue: d.venueName, date: d.date };
      const line = (key: MessageKey) => fill(t(locale, key), values);
      const payroll = d.kind === "payroll";
      const paragraphs = [
        line(payroll ? "email.payroll.body" : "email.accounting.body"),
        line("email.footer"),
      ];
      return {
        subject: line(payroll ? "email.payroll.subject" : "email.accounting.subject"),
        text: paragraphs.join("\n\n"),
        html: paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"),
      };
    }
    case "license_reminder": {
      const d = data as TemplateData<"license_reminder">;
      const values = {
        venue: d.venueName,
        kind: t(locale, `licenses.kind.${d.kind}` as MessageKey),
        number: d.number,
        date: new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", {
          dateStyle: "long",
          timeZone: "UTC",
        }).format(new Date(`${d.expiresOn}T00:00:00Z`)),
        days: d.daysLeft,
      };
      const line = (key: MessageKey) => fill(t(locale, key), values);
      const paragraphs = [
        line(d.number ? "email.license.body" : "email.license.bodyNoNumber"),
        line("email.license.daysLeft"),
        line("email.license.renew"),
        line("email.footer"),
      ];
      return {
        subject: line("email.license.subject"),
        text: paragraphs.join("\n\n"),
        html: paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"),
      };
    }
    case "money_audit": {
      const d = data as TemplateData<"money_audit">;
      const values = {
        venue: d.venueName,
        date: new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", {
          dateStyle: "long",
          timeZone: "UTC",
        }).format(new Date(`${d.night}T00:00:00Z`)),
        count: d.errorCount,
      };
      const line = (key: MessageKey) => fill(t(locale, key), values);
      const clean = d.errorCount === 0;
      const items = d.items.map((i) =>
        fill(
          t(
            locale,
            i.diffCents === null ? "email.moneyAudit.itemNoAmount" : "email.moneyAudit.item",
          ),
          {
            kind: t(locale, `moneyAudit.kind.${i.kind}` as MessageKey),
            ref: i.ref,
            amount: i.diffCents === null ? "" : formatMoney(locale, cents(Math.abs(i.diffCents))),
          },
        ),
      );
      if (d.errorCount > d.items.length)
        items.push(
          fill(t(locale, "email.moneyAudit.more"), { count: d.errorCount - d.items.length }),
        );
      const paragraphs = [
        line(clean ? "email.moneyAudit.bodyClean" : "email.moneyAudit.bodyErrors"),
        ...items,
        line("email.footer"),
      ];
      return {
        subject: line(clean ? "email.moneyAudit.subjectClean" : "email.moneyAudit.subjectErrors"),
        text: paragraphs.join("\n\n"),
        html: paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"),
      };
    }
    case "emergency_action": {
      const d = data as TemplateData<"emergency_action">;
      const values = {
        venue: d.venueName,
        action: t(locale, `emergency.action.${d.action}` as MessageKey),
        name: d.requestedBy,
        approver: d.approvedBy,
        reason: d.reason,
      };
      const line = (key: MessageKey) => fill(t(locale, key), values);
      const paragraphs = [
        line(`email.emergency.body.${d.stage}` as MessageKey),
        line("email.emergency.reason"),
        line("email.emergency.review"),
        line("email.footer"),
      ];
      return {
        subject: line(`email.emergency.subject.${d.stage}` as MessageKey),
        text: paragraphs.join("\n\n"),
        html: paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"),
      };
    }
    case "owner_recovery_notice": {
      const d = data as TemplateData<"owner_recovery_notice">;
      const values = {
        venue: d.venueName,
        name: d.name,
        owner: d.ownerName,
        requester: d.requesterName ?? "",
        readyAt: d.readyAt,
      };
      const line = (key: MessageKey) => fill(t(locale, key), values);
      const paragraphs = [
        line("email.ownerRecovery.greeting"),
        line(
          d.method === "second_owner"
            ? "email.ownerRecovery.bySecondOwner"
            : "email.ownerRecovery.byCode",
        ),
        line("email.ownerRecovery.delay"),
        line("email.ownerRecovery.ifWrong"),
        line("email.footer"),
      ];
      const html = paragraphs
        .map((p, i) =>
          i === paragraphs.length - 1
            ? `<p style="color:#666">${escapeHtml(p)}</p>`
            : `<p>${escapeHtml(p)}</p>`,
        )
        .join("\n");
      return { subject: line("email.ownerRecovery.subject"), text: paragraphs.join("\n\n"), html };
    }
  }
}
