import fp from "fastify-plugin";
import type { FastifyError, FastifyInstance, FastifyRequest, FastifyServerOptions } from "fastify";
import {
  failedOnOurSide,
  parseTraceparent,
  isSensitiveKey,
  partOfRoute,
  REDACTED,
  scrubText,
  scrubValue,
  type Span,
} from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { telemetry } from "./index.js";

declare module "fastify" {
  interface FastifyRequest {
    /** This request's span (M8-16): a child of the caller's traceparent when it sent one. */
    trace: Span | null;
  }
}

/** The route's pattern (/v1/venues/:venueId/orders), never its filled-in URL, which can carry a token. */
export const routeOf = (request: FastifyRequest): string =>
  request.routeOptions?.url ?? "unmatched";

/**
 * A span for every request, continuing the caller's trace (the W3C `traceparent` header), and the
 * numbers behind the targets: requests per part (ordering, payments, printing, texts), the ones we
 * failed (5xx), and how long they took. Errors we didn't mean (not an ApiError, not a 4xx) are
 * reported to error tracking, scrubbed, against the request's trace.
 */
export const telemetryPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("trace", null);

  app.addHook("onRequest", async (request) => {
    const t = telemetry();
    if (!t.enabled) return;
    const route = routeOf(request);
    request.trace = t.startSpan(`${request.method} ${route}`, {
      parent: parseTraceparent(request.headers["traceparent"] as string | undefined),
      attributes: {
        "http.request.method": request.method,
        "http.route": route,
        part: partOfRoute(route),
      },
    });
  });

  app.addHook("onError", async (request, _reply, error) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof ApiError || (status !== undefined && status < 500)) return;
    telemetry().captureError(error, { "http.route": routeOf(request) }, request.trace);
  });

  app.addHook("onResponse", async (request, reply) => {
    const t = telemetry();
    if (!t.enabled) return;
    const route = routeOf(request);
    const part = partOfRoute(route);
    const failed = failedOnOurSide(reply.statusCode);
    const attrs = {
      "http.route": route,
      "http.response.status_code": reply.statusCode,
      part,
      failed,
      venue: request.venueId ?? null,
    };
    request.trace?.setAttributes(attrs);
    request.trace?.end(failed ? { error: new Error(`answered ${reply.statusCode}`) } : {});
    t.count("http.server.requests", 1, attrs);
    t.observe("http.server.duration", reply.elapsedTime, { "http.route": route, part });
  });

  app.addHook("onClose", async () => {
    await telemetry().flush();
  });
});

/** A log call's fields: req and res go to their serializers above (which keep only safe fields). */
function scrubFields(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return scrubValue(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "req" || k === "res") out[k] = v;
    else out[k] = isSensitiveKey(k) && v != null ? REDACTED : scrubValue(v);
  }
  return out;
}

/**
 * The API's log options (pino, inside Fastify): requests are logged by their route pattern, not
 * their URL; every argument is scrubbed of phone numbers, emails, tokens and card numbers, and
 * anything under a personal or secret key is replaced, before the line is written.
 */
export function loggerOptions(
  extra: { level?: string; stream?: { write(line: string): void } } = {},
): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
    level: extra.level ?? "info",
    ...(extra.stream ? { stream: extra.stream } : {}),
    serializers: {
      req: (req: FastifyRequest) => ({
        method: req.method,
        route: req.routeOptions?.url ?? "unmatched",
        id: req.id,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      err: (err: FastifyError) =>
        scrubValue(err) as { [key: string]: unknown; type: string; message: string; stack: string },
    },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        // pino would write an Error's message as the line's msg unscrubbed: hand it over as err.
        const [first, ...rest] = args;
        const lead =
          first instanceof Error
            ? [{ err: scrubValue(first) }, scrubText(first.message)]
            : [typeof first === "string" ? scrubText(first) : scrubFields(first)];
        method.apply(this, [
          ...lead,
          ...rest.map((a) => (typeof a === "string" ? scrubText(a) : scrubValue(a))),
        ]);
      },
    },
  };
}
