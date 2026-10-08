import type {
  AttributeValue,
  LogRecord,
  MetricRecord,
  SpanRecord,
  TelemetryExporter,
  TelemetryRecord,
} from "./core.js";

/**
 * OTLP/HTTP JSON (OpenTelemetry's own wire format), so any collector or vendor that speaks
 * OpenTelemetry takes our telemetry: the endpoint and its headers are settings
 * (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS), never code.
 */

type OtlpValue =
  { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

function value(v: AttributeValue): OtlpValue {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

const attrs = (a: Readonly<Record<string, AttributeValue>>) =>
  Object.entries(a).map(([key, v]) => ({ key, value: value(v) }));

const nanos = (ms: number): string => `${Math.round(ms)}000000`;

const SEVERITY: Record<LogRecord["severity"], number> = { debug: 5, info: 9, warn: 13, error: 17 };

/** Histogram bounds for durations in milliseconds; 3000 is the order-to-alarm target. */
export const DURATION_BOUNDS_MS = [50, 100, 250, 500, 1000, 2000, 3000, 5000, 10000, 30000];

const byService = <T extends TelemetryRecord>(records: readonly T[]): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of records) m.set(r.service, [...(m.get(r.service) ?? []), r]);
  return m;
};

const resource = (service: string, extra: Readonly<Record<string, AttributeValue>>) => ({
  attributes: attrs({ "service.name": service, ...extra }),
});
const SCOPE = { name: "west4" };

export function encodeSpans(
  spans: readonly SpanRecord[],
  extra: Readonly<Record<string, AttributeValue>> = {},
) {
  return {
    resourceSpans: [...byService(spans)].map(([service, list]) => ({
      resource: resource(service, extra),
      scopeSpans: [
        {
          scope: SCOPE,
          spans: list.map((s) => ({
            traceId: s.traceId,
            spanId: s.spanId,
            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
            name: s.name,
            kind: 1,
            startTimeUnixNano: nanos(s.startMs),
            endTimeUnixNano: nanos(s.endMs),
            attributes: attrs(s.attributes),
            status: { code: s.status === "error" ? 2 : 1 },
          })),
        },
      ],
    })),
  };
}

export function encodeLogs(
  logs: readonly LogRecord[],
  extra: Readonly<Record<string, AttributeValue>> = {},
) {
  return {
    resourceLogs: [...byService(logs)].map(([service, list]) => ({
      resource: resource(service, extra),
      scopeLogs: [
        {
          scope: SCOPE,
          logRecords: list.map((l) => ({
            timeUnixNano: nanos(l.atMs),
            severityNumber: SEVERITY[l.severity],
            severityText: l.severity.toUpperCase(),
            body: { stringValue: l.body },
            attributes: attrs(l.attributes),
            ...(l.traceId ? { traceId: l.traceId } : {}),
            ...(l.spanId ? { spanId: l.spanId } : {}),
          })),
        },
      ],
    })),
  };
}

export function encodeMetrics(
  metrics: readonly MetricRecord[],
  extra: Readonly<Record<string, AttributeValue>> = {},
) {
  return {
    resourceMetrics: [...byService(metrics)].map(([service, list]) => ({
      resource: resource(service, extra),
      scopeMetrics: [
        {
          scope: SCOPE,
          metrics: list.map((m) =>
            m.type === "counter"
              ? {
                  name: m.name,
                  unit: m.unit,
                  sum: {
                    aggregationTemporality: 1,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        asInt: String(Math.round(m.value)),
                        startTimeUnixNano: nanos(m.atMs),
                        timeUnixNano: nanos(m.atMs),
                        attributes: attrs(m.attributes),
                      },
                    ],
                  },
                }
              : {
                  name: m.name,
                  unit: m.unit,
                  histogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        count: "1",
                        sum: m.value,
                        min: m.value,
                        max: m.value,
                        explicitBounds: DURATION_BOUNDS_MS,
                        bucketCounts: [...DURATION_BOUNDS_MS, Infinity].map((b, i) =>
                          String(
                            m.value <= b && (i === 0 || m.value > DURATION_BOUNDS_MS[i - 1]!)
                              ? 1
                              : 0,
                          ),
                        ),
                        startTimeUnixNano: nanos(m.atMs),
                        timeUnixNano: nanos(m.atMs),
                        attributes: attrs(m.attributes),
                      },
                    ],
                  },
                },
          ),
        },
      ],
    })),
  };
}

/** "k1=v1,k2=v2" (OTEL_EXPORTER_OTLP_HEADERS) as a header map. */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    out[decodeURIComponent(pair.slice(0, i).trim())] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; keepalive?: boolean },
) => Promise<{ ok: boolean; status: number }>;

/** Posts each batch to <endpoint>/v1/traces, /v1/logs and /v1/metrics. */
export class OtlpHttpExporter implements TelemetryExporter {
  private readonly base: string;
  constructor(
    endpoint: string,
    private readonly headers: Record<string, string> = {},
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly resourceAttributes: Readonly<Record<string, AttributeValue>> = {},
  ) {
    this.base = endpoint.replace(/\/+$/, "");
  }

  async export(records: readonly TelemetryRecord[]): Promise<void> {
    const spans = records.filter((r): r is SpanRecord => r.kind === "span");
    const logs = records.filter((r): r is LogRecord => r.kind === "log");
    const metrics = records.filter((r): r is MetricRecord => r.kind === "metric");
    const posts: Promise<unknown>[] = [];
    const post = (path: string, body: unknown) =>
      posts.push(
        this.fetchImpl(`${this.base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers },
          body: JSON.stringify(body),
          keepalive: true,
        }),
      );
    if (spans.length) post("/v1/traces", encodeSpans(spans, this.resourceAttributes));
    if (logs.length) post("/v1/logs", encodeLogs(logs, this.resourceAttributes));
    if (metrics.length) post("/v1/metrics", encodeMetrics(metrics, this.resourceAttributes));
    await Promise.all(posts);
  }
}
