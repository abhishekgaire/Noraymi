import { createHash } from "node:crypto";
import { assertOutsideTransaction, type CampaignStatus } from "@west4/db";
import { noteVendorCall } from "../vendors/outcomes.js";
import { readCampaignStatus } from "./campaign.js";
import type { TwilioAccount } from "./venue.js";

/**
 * Connect your Twilio account (T-01; D123; spec 11 · Accounts): the calls the server makes on the
 * venue's own Twilio account with the keys its owner or manager pasted. Every call is outside a
 * database transaction; the writes are naturally repeatable (setting the same address again, adding
 * a number already in the service) and carry an idempotency token. Errors name the step and
 * Twilio's status, never a body or a key.
 */
export interface TwilioAccountInfo {
  readonly name: string;
  readonly trial: boolean;
}
export interface TwilioNumber {
  readonly sid: string;
  readonly phoneE164: string;
  readonly name: string;
}
export interface TwilioService {
  readonly sid: string;
  readonly name: string;
}

/** Twilio refused the keys (401 or 403), or the account is suspended or closed. */
export class TwilioRefused extends Error {
  constructor(readonly step: string) {
    super(`Twilio refused the keys at ${step}`);
  }
}
/** Twilio answered with another error, or couldn't be reached. */
export class TwilioStepFailed extends Error {
  constructor(
    readonly step: string,
    readonly status: number,
  ) {
    super(`Twilio answered ${status} at ${step}`);
  }
}

export interface TwilioAdmin {
  /** Read-only: the account, or TwilioRefused. */
  account(account: TwilioAccount): Promise<TwilioAccountInfo>;
  /** Read-only: the account's +1 numbers that can text. */
  numbers(account: TwilioAccount): Promise<TwilioNumber[]>;
  /** Read-only: the account's messaging services. */
  services(account: TwilioAccount): Promise<TwilioService[]>;
  /** Points the number's incoming texts at our webhook. */
  setIncoming(account: TwilioAccount, numberSid: string, url: string, key: string): Promise<void>;
  /** Puts the number in the messaging service and lets the number's own webhook win. */
  joinService(
    account: TwilioAccount,
    serviceSid: string,
    numberSid: string,
    key: string,
  ): Promise<void>;
  /** The service campaign's status (M8-22's check). */
  campaign(account: TwilioAccount, serviceSid: string): Promise<CampaignStatus>;
}

const basic = (a: TwilioAccount) =>
  `Basic ${Buffer.from(`${a.accountSid}:${a.authToken}`).toString("base64")}`;

export class HttpTwilioAdmin implements TwilioAdmin {
  constructor(
    private readonly apiBase: string = "https://api.twilio.com",
    private readonly messagingBase: string = "https://messaging.twilio.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(
    step: string,
    account: TwilioAccount,
    url: string,
    init: { form?: Record<string, string>; key?: string } = {},
  ): Promise<Response> {
    assertOutsideTransaction("text");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.form ? "POST" : "GET",
        headers: {
          authorization: basic(account),
          ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(init.key ? { "i-twilio-idempotency-token": init.key } : {}),
        },
        ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
      });
    } catch {
      noteVendorCall("twilio", account.accountSid, true);
      throw new TwilioStepFailed(step, 0);
    }
    noteVendorCall("twilio", account.accountSid, response.status >= 500 || response.status === 429);
    if (response.status === 401 || response.status === 403) throw new TwilioRefused(step);
    return response;
  }

  private accountUrl(account: TwilioAccount, rest = ""): string {
    return `${this.apiBase}/2010-04-01/Accounts/${encodeURIComponent(account.accountSid)}${rest}.json`;
  }

  async account(account: TwilioAccount): Promise<TwilioAccountInfo> {
    const r = await this.call("account", account, this.accountUrl(account));
    if (!r.ok) throw new TwilioStepFailed("account", r.status);
    const body = (await r.json()) as { friendly_name?: string; status?: string; type?: string };
    if (body.status !== "active") throw new TwilioRefused("account");
    return { name: (body.friendly_name ?? "").slice(0, 120), trial: body.type === "Trial" };
  }

  async numbers(account: TwilioAccount): Promise<TwilioNumber[]> {
    const out: TwilioNumber[] = [];
    let next: string | null = `${this.accountUrl(account, "/IncomingPhoneNumbers")}?PageSize=200`;
    for (let page = 0; next && page < 10; page += 1) {
      const r = await this.call("numbers", account, next);
      if (!r.ok) throw new TwilioStepFailed("numbers", r.status);
      const body = (await r.json()) as {
        incoming_phone_numbers?: {
          sid: string;
          phone_number: string;
          friendly_name?: string;
          capabilities?: { sms?: boolean };
        }[];
        next_page_uri?: string | null;
      };
      for (const n of body.incoming_phone_numbers ?? [])
        if (/^\+1\d{10}$/.test(n.phone_number) && n.capabilities?.sms !== false)
          out.push({ sid: n.sid, phoneE164: n.phone_number, name: n.friendly_name ?? "" });
      next = body.next_page_uri ? `${this.apiBase}${body.next_page_uri}` : null;
    }
    return out;
  }

  async services(account: TwilioAccount): Promise<TwilioService[]> {
    const out: TwilioService[] = [];
    let next: string | null = `${this.messagingBase}/v1/Services?PageSize=100`;
    for (let page = 0; next && page < 10; page += 1) {
      const r = await this.call("services", account, next);
      if (!r.ok) throw new TwilioStepFailed("services", r.status);
      const body = (await r.json()) as {
        services?: { sid: string; friendly_name?: string }[];
        meta?: { next_page_url?: string | null };
      };
      for (const s of body.services ?? []) out.push({ sid: s.sid, name: s.friendly_name ?? "" });
      next = body.meta?.next_page_url ?? null;
    }
    return out;
  }

  async setIncoming(account: TwilioAccount, numberSid: string, url: string, key: string) {
    const r = await this.call(
      "incoming texts",
      account,
      this.accountUrl(account, `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}`),
      { form: { SmsUrl: url, SmsMethod: "POST" }, key },
    );
    if (!r.ok) throw new TwilioStepFailed("incoming texts", r.status);
  }

  async joinService(account: TwilioAccount, serviceSid: string, numberSid: string, key: string) {
    const service = `${this.messagingBase}/v1/Services/${encodeURIComponent(serviceSid)}`;
    const add = await this.call("messaging service number", account, `${service}/PhoneNumbers`, {
      form: { PhoneNumberSid: numberSid },
      key: `${key}:add`,
    });
    // 409: the number is in the service already (Twilio's 21710), which is what we want.
    if (!add.ok && add.status !== 409)
      throw new TwilioStepFailed("messaging service number", add.status);
    const own = await this.call("messaging service webhook", account, service, {
      form: { UseInboundWebhookOnNumber: "true" },
      key: `${key}:webhook`,
    });
    if (!own.ok) throw new TwilioStepFailed("messaging service webhook", own.status);
  }

  async campaign(account: TwilioAccount, serviceSid: string): Promise<CampaignStatus> {
    try {
      return await readCampaignStatus(account, serviceSid, {
        baseUrl: this.messagingBase,
        fetchImpl: this.fetchImpl,
      });
    } catch {
      throw new TwilioStepFailed("campaign", 0);
    }
  }
}

/**
 * Local development, the demo and the tests (no `GUEST_TEXTS=twilio`): no call leaves the server.
 * Any well-formed Account SID and Auth Token pass; an Auth Token of 32 zeros is refused as wrong.
 * Each account has one number (made from its SID, so two venues never share one) and one messaging
 * service; its campaign reads pending at Connect and approved on the next read (Check again).
 */
export class FakeTwilioAdmin implements TwilioAdmin {
  private readonly reads = new Map<string, number>();
  readonly incoming: { account: string; number: string; url: string }[] = [];

  private check(account: TwilioAccount): void {
    if (/^0{32}$/.test(account.authToken)) throw new TwilioRefused("account");
  }
  private digits(account: TwilioAccount): string {
    const n = parseInt(
      createHash("sha256").update(account.accountSid).digest("hex").slice(0, 8),
      16,
    );
    return String(n % 10_000).padStart(4, "0");
  }
  private suffix(account: TwilioAccount): string {
    return createHash("sha256").update(account.accountSid).digest("hex").slice(0, 32);
  }

  async account(account: TwilioAccount): Promise<TwilioAccountInfo> {
    this.check(account);
    return { name: "Test account", trial: false };
  }
  async numbers(account: TwilioAccount): Promise<TwilioNumber[]> {
    this.check(account);
    return [
      {
        sid: `PN${this.suffix(account)}`,
        phoneE164: `+1212555${this.digits(account)}`,
        name: "Test number",
      },
    ];
  }
  async services(account: TwilioAccount): Promise<TwilioService[]> {
    this.check(account);
    return [{ sid: `MG${this.suffix(account)}`, name: "Test messaging service" }];
  }
  async setIncoming(account: TwilioAccount, numberSid: string, url: string): Promise<void> {
    this.check(account);
    this.incoming.push({ account: account.accountSid, number: numberSid, url });
  }
  async joinService(account: TwilioAccount): Promise<void> {
    this.check(account);
  }
  async campaign(account: TwilioAccount, serviceSid: string): Promise<CampaignStatus> {
    this.check(account);
    const key = `${account.accountSid}:${serviceSid}`;
    const n = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, n);
    return n === 1 ? "pending" : "approved";
  }
}
