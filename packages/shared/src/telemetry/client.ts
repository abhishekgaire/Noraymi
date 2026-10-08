import { scrubText } from "./redact.js";
import { parseTraceparent } from "./core.js";

/**
 * The screens' side of error tracking (M8-16): the staff app, the desktop app and the guest web
 * send their errors, and the spans they time themselves, to POST /v1/public/telemetry, which
 * scrubs them again and passes them on. The screens hold no vendor key. Scrubbed here first, so
 * personal data never leaves the device; at most `maxPerMinute` errors a minute, each message
 * once a minute, so a loop can't flood it. Reporting never throws.
 */
export type ClientService = "staff" | "desktop" | "guest" | "console";

export interface ClientErrorReport {
  readonly type?: string;
  readonly message: string;
  readonly stack?: string;
  readonly page?: string;
  readonly traceparent?: string;
}

export interface ClientSpanReport {
  readonly name: string;
  readonly traceparent: string;
  readonly parent_span_id?: string;
  readonly duration_ms: number;
  readonly failed?: boolean;
}

export interface ClientTelemetryBody {
  readonly service: ClientService;
  readonly errors: readonly ClientErrorReport[];
  readonly spans?: readonly ClientSpanReport[];
}

export interface ClientReporter {
  error(error: unknown, extra?: { page?: string; traceparent?: string }): void;
  span(report: ClientSpanReport): void;
  /** Sends what's waiting now (tests, and before a page unloads). */
  flush(): Promise<void>;
}

/** A page path without its tokens: /r/<token> and /pay/<token> keep their shape, not the token. */
export function pagePath(path: string): string {
  return scrubText(path.split(/[?#]/)[0] ?? "").slice(0, 200);
}

export function makeClientReporter(options: {
  readonly service: ClientService;
  readonly post: (body: ClientTelemetryBody) => Promise<unknown>;
  readonly now?: () => number;
  readonly maxPerMinute?: number;
  readonly delayMs?: number;
}): ClientReporter {
  const now = options.now ?? Date.now;
  const max = options.maxPerMinute ?? 10;
  let windowStart = 0;
  let sentInWindow = 0;
  const lastSeen = new Map<string, number>();
  let errors: ClientErrorReport[] = [];
  let spans: ClientSpanReport[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (errors.length === 0 && spans.length === 0) return;
    const body: ClientTelemetryBody = { service: options.service, errors, spans };
    errors = [];
    spans = [];
    try {
      await options.post(body);
    } catch {
      // Offline or the API is down: the error is lost, the screen carries on.
    }
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(() => void flush(), options.delayMs ?? 2000);
  };

  return {
    error(error, extra = {}) {
      try {
        const e =
          error instanceof Error
            ? error
            : new Error(typeof error === "string" ? error : JSON.stringify(error));
        const message = scrubText(e.message || "Error").slice(0, 2000);
        const t = now();
        if (t - windowStart >= 60_000) {
          windowStart = t;
          sentInWindow = 0;
        }
        if (sentInWindow >= max || t - (lastSeen.get(message) ?? -Infinity) < 60_000) return;
        sentInWindow += 1;
        lastSeen.set(message, t);
        errors.push({
          type: e.name.slice(0, 100),
          message,
          ...(e.stack ? { stack: scrubText(e.stack).slice(0, 8000) } : {}),
          ...(extra.page ? { page: pagePath(extra.page) } : {}),
          ...(extra.traceparent && parseTraceparent(extra.traceparent)
            ? { traceparent: extra.traceparent }
            : {}),
        });
        schedule();
      } catch {
        // Never let reporting an error raise another.
      }
    },
    span(report) {
      if (!parseTraceparent(report.traceparent) || spans.length >= 20) return;
      spans.push({ ...report, name: scrubText(report.name).slice(0, 80) });
      schedule();
    },
    flush,
  };
}

/** Reports a window's uncaught errors and unhandled rejections. Answers a function that stops it. */
export function reportUncaught(
  target: {
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
  },
  reporter: ClientReporter,
  page: () => string,
): () => void {
  const onError = (event: unknown) =>
    reporter.error(
      (event as { error?: unknown; message?: string }).error ??
        (event as { message?: string }).message,
      {
        page: page(),
      },
    );
  const onRejection = (event: unknown) =>
    reporter.error((event as { reason?: unknown }).reason, { page: page() });
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
