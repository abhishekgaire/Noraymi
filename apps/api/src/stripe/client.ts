import { assertOutsideTransaction } from "@west4/db";
import type { StripeService, StripeSettings } from "./settings.js";

/**
 * The one Stripe client (M4-01; Stripe setup 5 and 7). Every call to Stripe
 * in the codebase goes through here, and only modules in `src/stripe` may use
 * it to build requests (a lint rule keeps it so):
 *  - one pinned API version, sent on every request; the Accounts v2 module
 *    and the surcharge path may name their own (`version`);
 *  - the service's own restricted key: reporting only reads, refunds only
 *    refunds, and billing works on our own account alone, never with
 *    `Stripe-Account`;
 *  - `Stripe-Account` only from the caller's venue (`stripeAccountOf`), and
 *    every venue call must carry one;
 *  - every write carries an idempotency key;
 *  - never inside a database transaction.
 * The live-or-sandbox choice lives here alone (the settings' key and base), so
 * training mode can route practice requests to the sandbox in one place (M7).
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

export type StripeParams = Record<string, unknown>;

export interface StripeCall {
  readonly params?: StripeParams;
  /** The venue's account id; null only for our own account (billing) or a platform call. */
  readonly account: string | null;
  readonly idempotencyKey?: string;
  /** Accounts v2 and the surcharge path only. */
  readonly version?: string;
  /** Platform calls (making a venue's account) run on our account with the payments key. */
  readonly platform?: boolean;
}

/** Stripe answered with an error: a decline, a bad request, a key without the permission. */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string | null,
    message: string,
    readonly declineCode: string | null = null,
    readonly requestId: string | null = null,
    /** The PaymentIntent a declined confirm left behind (an off-session charge, M4-17). */
    readonly paymentIntentId: string | null = null,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** No clear answer (a timeout, a dropped connection, a 5xx): what happened must be read back, never retried. */
export class StripeUnknownResult extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeUnknownResult";
  }
}

/** Refused before anything was sent: the wrong key for the call, a missing account or key. */
export class StripeMisuse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeMisuse";
  }
}

/** Stripe's form encoding: nested objects as a[b][c], arrays as a[0], a[1]. */
export function formEncode(params: StripeParams, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null) out.push([key, ""]);
    else if (Array.isArray(v))
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object")
          out.push(...formEncode(item as StripeParams, `${key}[${i}]`));
        else out.push([`${key}[${i}]`, String(item)]);
      });
    else if (typeof v === "object") out.push(...formEncode(v as StripeParams, key));
    else out.push([key, String(v)]);
  }
  return out;
}

/**
 * Fault injection for tests (M4-05): delay or fail a call before it goes,
 * drop Stripe's answer after Stripe did the work (the call then looks like a
 * timeout), or stop the run at a named step, as a crash would. Never in live
 * mode: the client refuses to be built with faults there.
 */
export interface StripeFaults {
  before?(method: string, path: string): Promise<void> | void;
  dropAnswer?(method: string, path: string, status: number): boolean;
  step?(name: string): Promise<void> | void;
}

/** A run stopped at a named step by fault injection, as if the process had died there. */
export class InjectedCrash extends Error {
  constructor(readonly step: string) {
    super(`injected crash at ${step}`);
    this.name = "InjectedCrash";
  }
}

export class StripeClient {
  constructor(
    readonly settings: StripeSettings,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Payment flows step 2: 10 to 15 seconds. */
    private readonly timeoutMs = 15_000,
    private readonly faults?: StripeFaults,
  ) {
    if (faults && settings.livemode) throw new Error("fault injection is never used in live mode");
  }

  /** A named step of a payment run; fault injection may stop the run here. */
  async step(name: string): Promise<void> {
    await this.faults?.step?.(name);
  }

  get livemode(): boolean {
    return this.settings.livemode;
  }

  /** Which key a call uses, and whether that key may make it. Exported for the unit tests. */
  static check(service: StripeService, method: string, path: string, call: StripeCall): void {
    if (service === "billing") {
      if (call.account !== null)
        throw new StripeMisuse("the billing key is never sent with Stripe-Account");
      return;
    }
    if (call.account === null && !call.platform)
      throw new StripeMisuse(`a ${service} call must name the venue's Stripe account`);
    if (service === "reporting" && method !== "GET")
      throw new StripeMisuse("the reporting key only reads");
    if (service === "refunds" && method !== "GET" && !path.startsWith("/v1/refunds"))
      throw new StripeMisuse("the refunds key only makes refunds");
    if (method === "POST" && !call.idempotencyKey)
      throw new StripeMisuse("every write to Stripe carries an idempotency key");
  }

  async call<T>(
    service: StripeService,
    method: "GET" | "POST" | "DELETE",
    path: string,
    call: StripeCall,
  ): Promise<T> {
    assertOutsideTransaction("stripe");
    if (this.settings.mode === "off")
      throw new StripeMisuse("Stripe isn't set up here (no keys and no fake)");
    StripeClient.check(service, method, path, call);
    const key = this.settings.keys[service];
    if (!key) throw new StripeMisuse(`no ${service} key`);
    const v2 = path.startsWith("/v2/");
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      "stripe-version": call.version ?? STRIPE_API_VERSION,
    };
    if (call.account) headers["stripe-account"] = call.account;
    if (call.idempotencyKey) headers["idempotency-key"] = call.idempotencyKey;
    let url = `${this.settings.apiBase}${path}`;
    let body: string | undefined;
    if (method === "GET" || method === "DELETE") {
      const q = new URLSearchParams(formEncode(call.params ?? {})).toString();
      if (q) url += `${url.includes("?") ? "&" : "?"}${q}`;
    } else if (v2) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(call.params ?? {});
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(formEncode(call.params ?? {})).toString();
    }
    await this.faults?.before?.(method, path);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new StripeUnknownResult(
        `no answer from Stripe for ${method} ${path}: ${(e as Error).name}`,
      );
    }
    const text = await response.text().catch(() => "");
    if (this.faults?.dropAnswer?.(method, path, response.status))
      throw new StripeUnknownResult(`no answer from Stripe for ${method} ${path}: injected`);
    if (response.status >= 500)
      throw new StripeUnknownResult(`Stripe answered ${response.status} for ${method} ${path}`);
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new StripeUnknownResult(`Stripe's answer to ${method} ${path} wasn't JSON`);
    }
    if (!response.ok) {
      const err =
        (json as { error?: Record<string, string | { id?: string } | undefined> }).error ?? {};
      const text = (k: string) => (typeof err[k] === "string" ? err[k] : null);
      const pi = err["payment_intent"];
      throw new StripeError(
        response.status,
        text("type") ?? "api_error",
        text("code"),
        text("message") ?? `Stripe answered ${response.status}`,
        text("decline_code"),
        response.headers.get("request-id"),
        typeof pi === "object" && pi?.id ? pi.id : null,
      );
    }
    return json as T;
  }
}
