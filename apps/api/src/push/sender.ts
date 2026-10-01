import webpush, { WebPushError } from "web-push";
import type { PushSettings } from "./settings.js";

/** A browser subscription as the push service needs it. */
export interface PushTarget {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export type PushResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      /** 404 or 410: the subscription no longer exists; stop sending to it. */
      readonly gone: boolean;
    };

/** Sends one push to one subscription. Never called inside a database transaction. */
export interface PushSender {
  send(target: PushTarget, payload: string): Promise<PushResult>;
}

/** The real thing: Web Push with VAPID, through the browser vendors' push services. */
export class WebPushSender implements PushSender {
  constructor(private readonly settings: PushSettings) {}

  async send(target: PushTarget, payload: string): Promise<PushResult> {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.keys.p256dh, auth: target.keys.auth } },
        payload,
        {
          TTL: 60,
          urgency: "high",
          vapidDetails: {
            subject: this.settings.subject,
            publicKey: this.settings.publicKey,
            privateKey: this.settings.privateKey,
          },
        },
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof WebPushError) {
        return {
          ok: false,
          status: error.statusCode,
          gone: error.statusCode === 404 || error.statusCode === 410,
        };
      }
      throw error;
    }
  }
}

/** A fake push endpoint for tests: records every send, and answers 410 for endpoints marked gone. */
export class FakePushSender implements PushSender {
  readonly sent: { endpoint: string; payload: string }[] = [];
  readonly gone = new Set<string>();

  async send(target: PushTarget, payload: string): Promise<PushResult> {
    if (this.gone.has(target.endpoint)) return { ok: false, status: 410, gone: true };
    this.sent.push({ endpoint: target.endpoint, payload });
    return { ok: true };
  }
}
