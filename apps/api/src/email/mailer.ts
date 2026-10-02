import nodemailer, { type Transporter } from "nodemailer";
import { assertOutsideTransaction } from "@west4/db";

export interface OutgoingEmail {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * The nearest thing SMTP has to an idempotency key: the same Message-ID on
   * every retry, built from the job id, so a provider that de-duplicates on
   * it sends one copy.
   */
  readonly messageId: string;
  /** Files sent with it, such as the receipt PDF (M4-19). */
  readonly attachments?: readonly {
    readonly filename: string;
    readonly content: Uint8Array;
    readonly contentType: string;
  }[];
}

/** The provider-neutral adapter (M1-18). Jobs call it; nothing else does. */
export interface Mailer {
  send(mail: OutgoingEmail): Promise<void>;
}

/** Any transactional provider through its SMTP relay; the local mail catcher in development. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(smtpUrl: string) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(mail: OutgoingEmail): Promise<void> {
    assertOutsideTransaction("email");
    await this.transport.sendMail({
      to: mail.to,
      from: mail.from,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      messageId: mail.messageId,
      ...(mail.attachments
        ? {
            attachments: mail.attachments.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.content),
              contentType: a.contentType,
            })),
          }
        : {}),
    });
  }

  close(): void {
    this.transport.close();
  }
}

/** For tests: records every send, or fails each one with the error it was given. */
export class FakeMailer implements Mailer {
  readonly sent: OutgoingEmail[] = [];
  failWith: Error | null = null;

  async send(mail: OutgoingEmail): Promise<void> {
    assertOutsideTransaction("email");
    if (this.failWith) throw this.failWith;
    this.sent.push(mail);
  }
}
