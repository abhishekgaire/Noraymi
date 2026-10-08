import type { JobHandler } from "@west4/db";
import { scrubText } from "@west4/shared";
import { telemetry } from "./index.js";

/**
 * Every job runs in a span named for its kind (M8-16), with its venue and attempt; a job that
 * throws is reported to error tracking, scrubbed, and counted, so the money jobs' failures feed
 * M8-17's alerts. The handler's own behavior (retries, the dead-letter queue) is unchanged.
 */
export function tracedHandlers<P extends string>(
  handlers: Readonly<Record<P, Readonly<Record<string, JobHandler>>>>,
): Record<P, Record<string, JobHandler>> {
  const out = {} as Record<P, Record<string, JobHandler>>;
  for (const [pool, byKind] of Object.entries(handlers) as [P, Record<string, JobHandler>][]) {
    const wrapped: Record<string, JobHandler> = {};
    out[pool] = wrapped;
    for (const [kind, handler] of Object.entries(byKind)) {
      wrapped[kind] = async (context) => {
        const t = telemetry();
        const attrs = { "job.kind": kind, "job.pool": pool, venue: context.job.venue_id ?? null };
        const span = t.startSpan(`job ${kind}`, { attributes: attrs });
        const started = Date.now();
        try {
          await handler(context);
          span.end();
          t.count("jobs.runs", 1, { ...attrs, failed: false });
        } catch (error) {
          span.end({ error });
          t.count("jobs.runs", 1, { ...attrs, failed: true });
          throw error;
        } finally {
          t.observe("jobs.duration", Date.now() - started, { "job.kind": kind, "job.pool": pool });
        }
      };
    }
  }
  return out;
}

/** The worker's log lines, scrubbed of personal data before they're written. */
export const scrubbedLog =
  (write: (line: string) => void) =>
  (line: string): void =>
    write(scrubText(line));
