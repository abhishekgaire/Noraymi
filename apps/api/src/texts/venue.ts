import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { assertOutsideTransaction } from "@west4/db";
import type { West4Env } from "../config.js";
import { noteVendorCall } from "../vendors/outcomes.js";

/**
 * Guest texts from a venue's own Twilio subaccount (M2-09; spec 11 · Texts
 * through Twilio). The client calls Twilio's Messages API with the
 * subaccount's credentials; never inside a database transaction.
 */
export interface TwilioAccount {
  readonly accountSid: string;
  readonly authToken: string;
}

export interface VenueText {
  readonly to: string;
  readonly from: string;
  readonly body: string;
  readonly statusCallback: string | null;
}

export interface VenueTextClient {
  send(account: TwilioAccount, text: VenueText): Promise<{ sid: string }>;
}

export class TwilioVenueClient implements VenueTextClient {
  constructor(
    private readonly baseUrl: string = "https://api.twilio.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(account: TwilioAccount, text: VenueText): Promise<{ sid: string }> {
    assertOutsideTransaction("text");
    const form = new URLSearchParams({ To: text.to, From: text.from, Body: text.body });
    if (text.statusCallback) form.set("StatusCallback", text.statusCallback);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(account.accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        },
      );
    } catch (error) {
      // No answer: our error rate on Twilio (M8-01).
      noteVendorCall("twilio", account.accountSid, true);
      throw error;
    }
    // A 5xx or a 429 is Twilio's trouble; a refused number is an answer.
    noteVendorCall("twilio", account.accountSid, response.status >= 500 || response.status === 429);
    if (!response.ok) throw new Error(`Twilio answered ${response.status} for a guest text`);
    const sid = ((await response.json()) as { sid?: string }).sid;
    if (!sid) throw new Error("Twilio answered without a message SID");
    return { sid };
  }
}

/** Records what would go out; local development and tests. */
export class FakeVenueClient implements VenueTextClient {
  readonly sent: { account: string; text: VenueText; sid: string }[] = [];
  async send(account: TwilioAccount, text: VenueText): Promise<{ sid: string }> {
    const sid = `SM${randomUUID().replace(/-/g, "")}`;
    this.sent.push({ account: account.accountSid, text, sid });
    return { sid };
  }
}

/**
 * Twilio signs each callback: base64(HMAC-SHA1(auth token, the full URL plus
 * every posted name and value, names sorted)). Checked before anything else.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
  given: string | undefined,
): boolean {
  if (!given) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface VenueTextSettings {
  /** "twilio" calls Twilio; "fake" records only (local development and tests). */
  readonly mode: "twilio" | "fake";
  readonly twilioBaseUrl: string;
  /** The public address Twilio calls back on; null leaves the callback off. */
  readonly publicApiUrl: string | null;
  /** Staging sends only to our own test phones; null means no list (production, and local where nothing is sent). */
  readonly allowList: readonly string[] | null;
}

export function loadVenueTextSettings(
  env: West4Env,
  source: Record<string, string | undefined> = process.env,
): VenueTextSettings {
  const list = (source["TEXT_ALLOW_LIST"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (env === "staging" && list.length === 0)
    throw new Error("TEXT_ALLOW_LIST must name our own test phones in staging");
  return {
    mode: source["GUEST_TEXTS"] === "twilio" || env === "production" ? "twilio" : "fake",
    twilioBaseUrl: source["TWILIO_API_BASE"] ?? "https://api.twilio.com",
    publicApiUrl: source["PUBLIC_API_URL"]?.replace(/\/+$/, "") ?? null,
    allowList: env === "production" ? null : list.length > 0 ? list : null,
  };
}
