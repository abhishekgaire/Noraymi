import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FAKE_STRIPE_KEYS,
  FAKE_WEBHOOK_SECRETS,
  type StripeEndpoint,
  type StripeService,
} from "../settings.js";

/**
 * A fake Stripe (M4-01): a stand-in that speaks the subset of Stripe's HTTP
 * we use, so local runs, tests and the smoke tests never need a Stripe
 * account. It keeps state in memory, answers with Stripe's error shapes,
 * enforces what each restricted key may do, saves the first answer to an
 * idempotency key (and refuses the key reused with other parameters), and
 * sends signed webhooks to our three endpoints. Each ticket adds the routes
 * it needs (`route`). It is never used against real money: its keys only
 * open the fake.
 */
export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly query: Record<string, unknown>;
  readonly body: Record<string, unknown>;
  readonly account: string | null;
  readonly service: StripeService;
  readonly version: string | null;
}

export type FakeAnswer = { status?: number; body: unknown; headers?: Record<string, string> };
type Handler = (req: FakeRequest, fake: FakeStripe) => FakeAnswer | Promise<FakeAnswer>;

export class FakeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string | null,
    message: string,
    readonly declineCode: string | null = null,
  ) {
    super(message);
  }
}

export interface FakeEvent {
  readonly id: string;
  readonly object: "event";
  readonly type: string;
  readonly account?: string;
  readonly livemode: boolean;
  readonly created: number;
  readonly api_version: string;
  readonly data: { readonly object: unknown };
}

/** Stripe's form encoding read back into nested objects and arrays. */
export function formDecode(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const parts = rawKey.replace(/\]/g, "").split("[");
    let node: Record<string, unknown> | unknown[] = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d*$/.test(parts[i + 1]!);
      const key = part === "" && Array.isArray(node) ? String(node.length) : part;
      const holder = node as Record<string, unknown>;
      if (last) holder[key] = value;
      else {
        holder[key] ??= nextIsIndex ? [] : {};
        node = holder[key] as Record<string, unknown>;
      }
    });
  }
  return root;
}

/** Stripe-Signature for a payload: t=…,v1=HMAC-SHA256(secret, "t.payload"). */
export function signPayload(
  payload: string,
  secret: string,
  at = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret).update(`${at}.${payload}`).digest("hex");
  return `t=${at},v1=${v1}`;
}

export const fakeId = (prefix: string): string =>
  `${prefix}_fake_${randomBytes(9).toString("hex")}`;

const SERVICE_OF_KEY = new Map<string, StripeService>(
  Object.entries(FAKE_STRIPE_KEYS).map(([s, k]) => [k, s as StripeService]),
);

export interface FakeStripeOptions {
  /** Where each endpoint's events go; none: kept in `events` only. */
  readonly webhooks?: Partial<Record<StripeEndpoint, string>>;
  /** Delay before a webhook is sent, as Stripe's are a moment after the call. */
  readonly webhookDelayMs?: number;
  /** The address the fake tells browsers to open (onboarding links). */
  readonly publicBase?: string;
}

export class FakeStripe {
  private server: Server | null = null;
  private readonly routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] =
    [];
  private readonly idempotency = new Map<string, { hash: string; answer: FakeAnswer }>();
  /** Every object the fake holds, by id. */
  readonly objects = new Map<string, Record<string, unknown>>();
  /** Every event made, delivered or not, newest last. */
  readonly events: { endpoint: StripeEndpoint; event: FakeEvent; delivered: boolean }[] = [];
  /** Every request seen: method, path, the account header and the key's service. */
  readonly requests: {
    method: string;
    path: string;
    account: string | null;
    service: StripeService;
    idempotencyKey: string | null;
  }[] = [];
  base = "";
  webhooks: Partial<Record<StripeEndpoint, string>>;
  /** Tests: the next requests to these paths time out (the fake holds the connection, then drops it). */
  readonly dropNext: { method: string; path: RegExp; afterHandling: boolean }[] = [];

  constructor(readonly options: FakeStripeOptions = {}) {
    this.webhooks = { ...(options.webhooks ?? {}) };
    for (const register of fakeRouteSets) register(this);
  }

  get publicBase(): string {
    return this.options.publicBase ?? this.base;
  }

  route(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:(\w+)/g, (_, k: string) => {
        keys.push(k);
        return "([^/]+)";
      })}$`,
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  async start(port = 0, host = "127.0.0.1"): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const address = this.server.address() as AddressInfo;
    this.base = `http://${host}:${address.port}`;
    return this.base;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  put<T extends Record<string, unknown>>(object: T): T {
    this.objects.set(String(object["id"]), object);
    return object;
  }

  get(id: string, account: string | null, kind?: string): Record<string, unknown> {
    const o = this.objects.get(id);
    if (
      !o ||
      (account !== null && o["_account"] !== undefined && o["_account"] !== account) ||
      (kind && o["object"] !== kind)
    )
      throw new FakeError(
        404,
        "invalid_request_error",
        "resource_missing",
        `No such ${kind ?? "object"}: '${id}'`,
      );
    return o;
  }

  list(
    kind: string,
    account: string | null,
    filter: (o: Record<string, unknown>) => boolean = () => true,
  ) {
    return [...this.objects.values()]
      .filter(
        (o) => o["object"] === kind && (account === null || o["_account"] === account) && filter(o),
      )
      .reverse();
  }

  /** Makes an event and sends it to its endpoint after the delay; returns at once. */
  emit(
    endpoint: StripeEndpoint,
    type: string,
    object: Record<string, unknown>,
    account?: string,
  ): FakeEvent {
    const event: FakeEvent = {
      id: fakeId("evt"),
      object: "event",
      type,
      ...(account ? { account } : {}),
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      api_version: "fake",
      data: { object: publicView(object) },
    };
    const entry = { endpoint, event, delivered: false };
    this.events.push(entry);
    const url = this.webhooks[endpoint];
    if (url) {
      setTimeout(() => void this.deliver(entry, url), this.options.webhookDelayMs ?? 50).unref?.();
    }
    return event;
  }

  /** Posts one stored event, signed with its endpoint's secret. Tests call it to replay. */
  async deliver(
    entry: { endpoint: StripeEndpoint; event: FakeEvent; delivered: boolean },
    url = this.webhooks[entry.endpoint],
  ): Promise<number> {
    if (!url) return 0;
    const payload = JSON.stringify(entry.event);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signPayload(payload, FAKE_WEBHOOK_SECRETS[entry.endpoint]),
        },
        body: payload,
      });
      entry.delivered = r.ok;
      return r.status;
    } catch {
      return 0;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const send = (a: FakeAnswer) => {
      res.writeHead(a.status ?? 200, {
        "content-type": "application/json",
        "request-id": fakeId("req"),
        ...(a.headers ?? {}),
      });
      res.end(
        typeof a.body === "string" && a.headers?.["content-type"] ? a.body : JSON.stringify(a.body),
      );
    };
    const fail = (e: FakeError) =>
      send({
        status: e.status,
        body: {
          error: {
            type: e.type,
            code: e.code ?? undefined,
            message: e.message,
            decline_code: e.declineCode ?? undefined,
          },
        },
      });
    try {
      const method = req.method ?? "GET";
      const path = url.pathname;
      const browser = path.startsWith("/fake/");
      let service: StripeService = "payments";
      if (!browser) {
        const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const s = SERVICE_OF_KEY.get(key);
        if (!s) throw new FakeError(401, "invalid_request_error", null, "Invalid API Key provided");
        service = s;
      }
      const account = (req.headers["stripe-account"] as string | undefined) ?? null;
      const idemKey = (req.headers["idempotency-key"] as string | undefined) ?? null;
      if (!browser) {
        this.requests.push({ method, path, account, service, idempotencyKey: idemKey });
        restrict(service, method, path, account);
      }
      const drop = this.dropNext.findIndex((d) => d.method === method && d.path.test(path));
      const body =
        raw === ""
          ? {}
          : (req.headers["content-type"] ?? "").includes("multipart/form-data")
            ? { _multipart: true }
            : (req.headers["content-type"] ?? "").includes("application/json")
              ? (JSON.parse(raw) as Record<string, unknown>)
              : formDecode(raw);
      const query = formDecode(url.search.slice(1));
      const found = this.routes.find((r) => r.method === method && r.pattern.test(path));
      if (!found)
        throw new FakeError(
          404,
          "invalid_request_error",
          null,
          `Unrecognized request URL (${method}: ${path})`,
        );
      const match = found.pattern.exec(path)!;
      const params = Object.fromEntries(
        found.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]),
      );
      const request: FakeRequest = {
        method,
        path,
        params,
        query,
        body,
        account,
        service,
        version: (req.headers["stripe-version"] as string | undefined) ?? null,
      };
      if (drop >= 0 && !this.dropNext[drop]!.afterHandling) {
        this.dropNext.splice(drop, 1);
        req.socket.destroy();
        return;
      }
      let answer: FakeAnswer;
      const cacheKey =
        idemKey && method === "POST" ? `${service}|${account ?? ""}|${idemKey}` : null;
      const hash = createHash("sha256").update(`${path}|${raw}`).digest("hex");
      const cached = cacheKey ? this.idempotency.get(cacheKey) : undefined;
      if (cached) {
        if (cached.hash !== hash)
          throw new FakeError(
            400,
            "idempotency_error",
            null,
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          );
        answer = {
          ...cached.answer,
          headers: { ...(cached.answer.headers ?? {}), "idempotent-replayed": "true" },
        };
      } else {
        try {
          answer = await found.handler(request, this);
          answer = { ...answer, body: publicView(answer.body) };
        } catch (e) {
          if (!(e instanceof FakeError)) throw e;
          answer = {
            status: e.status,
            body: {
              error: {
                type: e.type,
                code: e.code ?? undefined,
                message: e.message,
                decline_code: e.declineCode ?? undefined,
              },
            },
          };
        }
        // Stripe saves the first answer to a key, errors included (not 5xx).
        if (cacheKey) this.idempotency.set(cacheKey, { hash, answer });
      }
      if (drop >= 0) {
        this.dropNext.splice(drop, 1);
        req.socket.destroy();
        return;
      }
      send(answer);
    } catch (e) {
      if (e instanceof FakeError) fail(e);
      else
        send({
          status: 500,
          body: { error: { type: "api_error", message: (e as Error).message } },
        });
    }
  }
}

/** Strips the fake's own bookkeeping (fields starting with _) from what it answers. */
export function publicView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicView);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !k.startsWith("_"))
        .map(([k, v]) => [k, publicView(v)]),
    );
  return value;
}

/** What each restricted key may do, as Stripe enforces it. */
function restrict(
  service: StripeService,
  method: string,
  path: string,
  account: string | null,
): void {
  const deny = (what: string) => {
    throw new FakeError(
      403,
      "invalid_request_error",
      "secret_key_required",
      `The provided key does not have the required permissions for this endpoint: ${what}.`,
    );
  };
  if (service === "billing" && account !== null) deny("connected accounts");
  if (service === "reporting" && method !== "GET") deny(`${method} ${path}`);
  if (service === "refunds" && method !== "GET" && !path.startsWith("/v1/refunds"))
    deny(`${method} ${path}`);
  if (service === "payments" && method !== "GET" && path.startsWith("/v1/refunds"))
    deny(`${method} ${path}`);
}

/** Each ticket's routes for the fake, registered in every new instance. */
export const fakeRouteSets: ((fake: FakeStripe) => void)[] = [];
