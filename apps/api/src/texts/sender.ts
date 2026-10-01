import { assertOutsideTransaction } from "@west4/db";
import type { TextSettings } from "./settings.js";

export interface OutgoingText {
  readonly to: string;
  readonly body: string;
  /** Our own key for the send: the job id, so a retry of the same job is the same text. */
  readonly idempotencyKey: string;
}

/** Sends one text. Never called inside a database transaction. */
export interface TextSender {
  send(text: OutgoingText): Promise<void>;
}

/**
 * Twilio's Messages API over plain HTTPS. Twilio has no idempotency header
 * for messages; the key rides along as a tag on the message body's job id
 * through the job's own at-most-three attempts (the queue, not Twilio,
 * stops a duplicate).
 */
export class TwilioTextSender implements TextSender {
  constructor(
    private readonly settings: TextSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(text: OutgoingText): Promise<void> {
    assertOutsideTransaction("text");
    const auth = Buffer.from(`${this.settings.accountSid}:${this.settings.authToken}`).toString(
      "base64",
    );
    const form = new URLSearchParams({
      To: text.to,
      From: this.settings.fromNumber,
      Body: text.body,
    });
    const response = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.settings.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": text.idempotencyKey,
        },
        body: form.toString(),
      },
    );
    if (!response.ok) {
      // Twilio's error body names the problem; the number itself is never logged.
      throw new Error(`Twilio answered ${response.status} for a text`);
    }
  }
}

/** Local development: the text goes to the log, never to a phone. */
export class LogTextSender implements TextSender {
  constructor(private readonly log: (line: string) => void = (line) => console.warn(line)) {}

  async send(text: OutgoingText): Promise<void> {
    assertOutsideTransaction("text");
    this.log(`text to ${text.to.slice(0, 3)}…${text.to.slice(-2)}: ${text.body}`);
  }
}

/** Tests: records every text; can fail on purpose. */
export class FakeTextSender implements TextSender {
  readonly sent: OutgoingText[] = [];
  failWith: Error | null = null;

  async send(text: OutgoingText): Promise<void> {
    assertOutsideTransaction("text");
    if (this.failWith) throw this.failWith;
    this.sent.push(text);
  }
}
