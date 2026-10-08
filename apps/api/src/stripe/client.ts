import { assertOutsideTransaction } from "@west4/db";
import type { West4Env } from "../config.js";
import { noteVendorCall } from "../vendors/outcomes.js";
import { stripeBucket } from "./rate.js";
import {
  LIVE_KEY,
  loadStripeSandboxSettings,
  loadStripeSettings,
  type StripeService,
  type StripeSettings,
} from "./settings.js";

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
 * The live-or-sandbox choice lives here alone (M7-04): a practice payment's
 * calls go through `forTraining(true)`, which sends them to the sandbox
 * client attached to this one, each marked `training`. The live client
 * refuses a practice call, and the sandbox client refuses a live one or a
 * live key, before anything leaves the process.
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
  /** A practice payment's call (M7-04): only the sandbox client sends it. */
  readonly training?: boolean;
  /** A file for Stripe's Files API (dispute evidence, M4-24): sent multipart to Stripe's files host. */
  readonly file?: {
    readonly purpose: string;
    readonly filename: string;
    readonly contentType: string;
    readonly data: Uint8Array;
  };
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

  /** Training mode's sandbox client (M7-04), when this environment has one. */
  private sandboxClient: StripeClient | null = null;

  /** Training mode's sandbox settings, when attached (its webhook secret, M7-04). */
  get sandboxSettings(): StripeSettings | null {
    return this.settings.sandbox ? this.settings : (this.sandboxClient?.settings ?? null);
  }

  /** Attach the sandbox that practice payments use. */
  withSandbox(sandbox: StripeClient): this {
    if (!sandbox.settings.sandbox) throw new Error("the training client must be the sandbox");
    this.sandboxClient = sandbox;
    return this;
  }

  /**
   * The client for one payment: this one for a live payment; for a practice
   * payment the sandbox, with every call marked practice. With no sandbox
   * attached, the marked calls land on this client and are refused unsent.
   */
  forTraining(training: boolean): StripeClient {
    if (!training || this.settings.sandbox) return this;
    const target = this.sandboxClient ?? this;
    const bound = Object.create(target) as StripeClient;
    bound.call = <T>(
      service: StripeService,
      method: "GET" | "POST" | "DELETE",
      path: string,
      call: StripeCall,
    ): Promise<T> => target.call<T>(service, method, path, { ...call, training: true });
    return bound;
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
    // Our error rate on Stripe (M8-01): an answer counts as a call, no answer
    // (or a 429) as a failed one; a call refused before sending isn't counted.
    // Practice payments on the sandbox never count.
    const counted = !call.training && !this.settings.sandbox;
    try {
      const result = await this.send<T>(service, method, path, call);
      if (counted) noteVendorCall("stripe", call.account, false);
      return result;
    } catch (error) {
      if (counted) {
        if (error instanceof StripeUnknownResult && !error.message.endsWith(": injected"))
          noteVendorCall("stripe", call.account, true);
        else if (error instanceof StripeError)
          noteVendorCall("stripe", call.account, error.status === 429);
      }
      throw error;
    }
  }

  private async send<T>(
    service: StripeService,
    method: "GET" | "POST" | "DELETE",
    path: string,
    call: StripeCall,
  ): Promise<T> {
    assertOutsideTransaction("stripe");
    if (this.settings.mode === "off")
      throw new StripeMisuse("Stripe isn't set up here (no keys and no fake)");
    // Training mode (M7-04): a practice call never reaches live Stripe, and the sandbox takes nothing else.
    if (call.training && !this.settings.sandbox)
      throw new StripeMisuse("a practice payment never goes to live Stripe");
    if (this.settings.sandbox && !call.training)
      throw new StripeMisuse("the training sandbox takes practice payments only");
    StripeClient.check(service, method, path, call);
    const key = this.settings.keys[service];
    if (!key) throw new StripeMisuse(`no ${service} key`);
    if (this.settings.sandbox && LIVE_KEY.test(key))
      throw new StripeMisuse("the training sandbox never sends a live key");
    const v2 = path.startsWith("/v2/");
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      "stripe-version": call.version ?? STRIPE_API_VERSION,
    };
    if (call.account) headers["stripe-account"] = call.account;
    if (call.idempotencyKey) headers["idempotency-key"] = call.idempotencyKey;
    // Stripe takes files at files.stripe.com; the fake takes them at its own address.
    const filesBase =
      this.settings.apiBase === "https://api.stripe.com"
        ? "https://files.stripe.com"
        : this.settings.apiBase;
    let url = `${call.file ? filesBase : this.settings.apiBase}${path}`;
    let body: string | FormData | undefined;
    if (call.file) {
      const form = new FormData();
      form.set("purpose", call.file.purpose);
      form.set(
        "file",
        new Blob([Buffer.from(call.file.data)], { type: call.file.contentType }),
        call.file.filename,
      );
      body = form;
    } else if (method === "GET" || method === "DELETE") {
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
    // The token bucket (M8-21): a burst waits its turn instead of meeting Stripe's 429.
    await stripeBucket(this.settings).take();
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

/** The environment's Stripe: the live client with training mode's sandbox attached (M4-01, M7-04). */
export function stripeFromEnv(env: West4Env): StripeClient {
  return new StripeClient(loadStripeSettings(env)).withSandbox(
    new StripeClient(loadStripeSandboxSettings(env)),
  );
}
