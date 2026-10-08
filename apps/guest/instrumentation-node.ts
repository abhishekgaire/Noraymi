import type { Instrumentation } from "next";

/** The Node.js server's half of instrumentation.ts (M8-16): a scrubbed error report as a JSON line. */
export const reportServerError: Instrumentation.onRequestError = async (err, request, context) => {
  const { scrubText, scrubValue } = await import("@west4/shared");
  const e = scrubValue(err instanceof Error ? err : new Error(String(err))) as {
    type: string;
    message: string;
    stack?: string;
  };
  process.stdout.write(
    `${JSON.stringify({
      telemetry: "log",
      service: "west4-guest",
      atMs: Date.now(),
      severity: "error",
      body: e.message,
      attributes: {
        "exception.type": e.type,
        "exception.message": e.message,
        "exception.stacktrace": e.stack ?? null,
        "http.request.method": request.method,
        "http.route": scrubText(context.routePath),
        "next.router": context.routerKind,
      },
    })}\n`,
  );
};
