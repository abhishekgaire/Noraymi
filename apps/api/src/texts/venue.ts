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
  /** The 10DLC campaign's messaging service (M8-22): when set, Twilio sends from it instead of `from`. */
  readonly messagingServiceSid?: string | null;
  readonly body: string;
  readonly statusCallback: string | null;
}

/** One message from Twilio's list, as the pull after a restore reads it (M8-20). */
export interface TwilioMessage {
  readonly sid: string;
  readonly direction: string;
  readonly status: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  /** When Twilio made it, as an ISO instant. */
  readonly createdAt: string;
  readonly errorCode: string | null;
}

export interface VenueTextClient {
  send(account: TwilioAccount, text: VenueText): Promise<{ sid: string }>;
  /** The account's messages made since `since` (M8-20's pull after a restore). */
  list?(account: TwilioAccount, since: string): Promise<TwilioMessage[]>;
  /**
   * Blank a message's body at Twilio (M8-12: message bodies are kept there 30 days). "gone" when
   * Twilio no longer has the message. Optional so a test double that only sends still fits.
   */
  redact?(
    account: TwilioAccount,
    sid: string,
    idempotencyKey: string,
  ): Promise<"redacted" | "gone">;
}

export class TwilioVenueClient implements VenueTextClient {
  constructor(
    private readonly baseUrl: string = "https://api.twilio.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(account: TwilioAccount, text: VenueText): Promise<{ sid: string }> {
    assertOutsideTransaction("text");
    const form = new URLSearchParams({ To: text.to, Body: text.body });
    if (text.messagingServiceSid) form.set("MessagingServiceSid", text.messagingServiceSid);
    else form.set("From", text.from);
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

  /**
   * Twilio redacts a body when the message is updated with an empty one; the idempotency token makes
   * a rerun the same request. A 404 means Twilio no longer has the message.
   */
  async list(account: TwilioAccount, since: string): Promise<TwilioMessage[]> {
    assertOutsideTransaction("text");
    const out: TwilioMessage[] = [];
    const auth = `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`;
    let next: string | null =
      `/2010-04-01/Accounts/${encodeURIComponent(account.accountSid)}/Messages.json?` +
      new URLSearchParams({ "DateSent>": since.slice(0, 10), PageSize: "1000" }).toString();
    while (next) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${next}`, {
          headers: { authorization: auth },
        });
      } catch (error) {
        noteVendorCall("twilio", account.accountSid, true);
        throw error;
      }
      noteVendorCall(
        "twilio",
        account.accountSid,
        response.status >= 500 || response.status === 429,
      );
      if (!response.ok) throw new Error(`Twilio answered ${response.status} listing messages`);
      const page = (await response.json()) as {
        messages?: {
          sid: string;
          direction: string;
          status: string;
          from: string;
          to: string;
          body: string | null;
          date_created: string;
          error_code: number | null;
        }[];
        next_page_uri?: string | null;
      };
      for (const m of page.messages ?? []) {
        const createdAt = new Date(m.date_created).toISOString();
        if (createdAt < since) continue;
        out.push({
          sid: m.sid,
          direction: m.direction,
          status: m.status,
          from: m.from,
          to: m.to,
          body: m.body ?? "",
          createdAt,
          errorCode: m.error_code === null ? null : String(m.error_code),
        });
      }
      next = page.next_page_uri ?? null;
    }
    return out;
  }

  async redact(
    account: TwilioAccount,
    sid: string,
    idempotencyKey: string,
  ): Promise<"redacted" | "gone"> {
    assertOutsideTransaction("text");
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(account.accountSid)}/Messages/${encodeURIComponent(sid)}.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
            "i-twilio-idempotency-token": idempotencyKey,
          },
          body: new URLSearchParams({ Body: "" }).toString(),
        },
      );
    } catch (error) {
      noteVendorCall("twilio", account.accountSid, true);
      throw error;
    }
    noteVendorCall("twilio", account.accountSid, response.status >= 500 || response.status === 429);
    if (response.status === 404) return "gone";
    if (!response.ok)
      throw new Error(`Twilio answered ${response.status} redacting a message body`);
    return "redacted";
  }
}

/** Records what would go out; local development and tests. */
export class FakeVenueClient implements VenueTextClient {
  readonly sent: { account: string; text: VenueText; sid: string }[] = [];
  /** What Twilio's list answers, by account (the tests add to it). */
  readonly listed: { account: string; message: TwilioMessage }[] = [];
  async list(account: TwilioAccount, since: string): Promise<TwilioMessage[]> {
    return this.listed
      .filter((m) => m.account === account.accountSid && m.message.createdAt >= since)
      .map((m) => m.message);
  }
  readonly redacted: { account: string; sid: string; key: string }[] = [];
  async redact(account: TwilioAccount, sid: string, key: string): Promise<"redacted" | "gone"> {
    this.redacted.push({ account: account.accountSid, sid, key });
    return "redacted";
  }
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
  /**
   * Texts go only once the venue's 10DLC campaign is approved (M8-22): always
   * in production; anywhere else only with TEXT_REQUIRE_CAMPAIGN=1.
   */
  readonly requireApprovedCampaign: boolean;
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
    requireApprovedCampaign: env === "production" || source["TEXT_REQUIRE_CAMPAIGN"] === "1",
  };
}
