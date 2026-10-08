import { scrubText, scrubValue } from "./redact.js";

/**
 * Telemetry (M8-16; spec 13 · Watching production): spans, logs, error reports and metrics in
 * OpenTelemetry's model, for the API, the job workers, the staff app, the desktop app and the
 * guest web. Vendor-neutral: an exporter sends them as OTLP/HTTP JSON to whatever collector
 * OTEL_EXPORTER_OTLP_ENDPOINT names, or writes JSON lines to the log (CloudWatch keeps them 30
 * days), or keeps them in memory for tests. Every attribute, message and stack goes through
 * scrubValue before it's queued, so personal data never leaves the process.
 */

export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue | null | undefined>>;

export interface SpanRecord {
  readonly kind: "span";
  readonly service: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly status: "ok" | "error";
  readonly attributes: Readonly<Record<string, AttributeValue>>;
}

export type Severity = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  readonly kind: "log";
  readonly service: string;
  readonly atMs: number;
  readonly severity: Severity;
  readonly body: string;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
}

export interface MetricRecord {
  readonly kind: "metric";
  readonly service: string;
  readonly name: string;
  readonly type: "counter" | "histogram";
  readonly value: number;
  readonly unit: string;
  readonly atMs: number;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
}

export type TelemetryRecord = SpanRecord | LogRecord | MetricRecord;

export interface TelemetryExporter {
  export(records: readonly TelemetryRecord[]): Promise<void> | void;
}

/** W3C trace context: the ids that tie a span to its trace and parent. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

const HEX = (bytes: number): string => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};
export const newTraceId = (): string => HEX(16);
export const newSpanId = (): string => HEX(8);

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** A `traceparent` header's trace and parent span, or null when it's missing or malformed. */
export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  const m = TRACEPARENT.exec((header ?? "").trim().toLowerCase());
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { traceId: m[1]!, spanId: m[2]! };
}

export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

/** A fresh traceparent for a request a screen starts (the room page's order, for example). */
export function newTraceparent(): string {
  return formatTraceparent({ traceId: newTraceId(), spanId: newSpanId() });
}

function cleanAttributes(attrs: Attributes | undefined): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  if (!attrs) return out;
  const scrubbed = scrubValue(attrs) as Record<string, unknown>;
  for (const [k, v] of Object.entries(scrubbed)) {
    if (typeof v === "string" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export interface Span extends TraceContext {
  readonly name: string;
  setAttributes(attrs: Attributes): void;
  /** Ends the span; `error` marks it failed and reports the error against it. */
  end(options?: { endMs?: number; error?: unknown }): void;
  readonly traceparent: string;
}

export interface TelemetryOptions {
  readonly service: string;
  readonly exporter: TelemetryExporter | null;
  readonly now?: () => number;
  /** Records are sent in batches every flushMs, or sooner when maxBatch are waiting. */
  readonly flushMs?: number;
  readonly maxBatch?: number;
  /** The most records kept while an exporter is slow; older ones are dropped and counted. */
  readonly maxQueue?: number;
}

export class Telemetry {
  readonly service: string;
  private readonly exporter: TelemetryExporter | null;
  private readonly now: () => number;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private queue: TelemetryRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending: Promise<void> = Promise.resolve();
  dropped = 0;

  constructor(options: TelemetryOptions) {
    this.service = options.service;
    this.exporter = options.exporter;
    this.now = options.now ?? Date.now;
    this.maxBatch = options.maxBatch ?? 200;
    this.maxQueue = options.maxQueue ?? 5000;
    const flushMs = options.flushMs ?? 5000;
    if (this.exporter && flushMs > 0) {
      this.timer = setInterval(() => void this.flush(), flushMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  get enabled(): boolean {
    return this.exporter !== null;
  }

  private push(record: TelemetryRecord): void {
    if (!this.exporter) return;
    this.queue.push(record);
    if (this.queue.length > this.maxQueue) {
      this.dropped += this.queue.length - this.maxQueue;
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    if (this.queue.length >= this.maxBatch) void this.flush();
  }

  /** A span, child of `parent` when given (a traceparent header or another span). */
  startSpan(
    name: string,
    options: { parent?: TraceContext | null; attributes?: Attributes; startMs?: number } = {},
  ): Span {
    const traceId = options.parent?.traceId ?? newTraceId();
    const spanId = newSpanId();
    const parentSpanId = options.parent?.spanId ?? null;
    const startMs = options.startMs ?? this.now();
    let attributes: Record<string, AttributeValue> = cleanAttributes(options.attributes);
    let ended = false;
    const span: Span = {
      traceId,
      spanId,
      name,
      traceparent: formatTraceparent({ traceId, spanId }),
      setAttributes: (attrs) => {
        attributes = { ...attributes, ...cleanAttributes(attrs) };
      },
      end: (o = {}) => {
        if (ended) return;
        ended = true;
        if (o.error !== undefined) this.captureError(o.error, {}, { traceId, spanId });
        this.push({
          kind: "span",
          service: this.service,
          traceId,
          spanId,
          parentSpanId,
          name: scrubText(name),
          startMs,
          endMs: Math.max(startMs, o.endMs ?? this.now()),
          status: o.error !== undefined ? "error" : "ok",
          attributes,
        });
      },
    };
    return span;
  }

  /**
   * A span a screen timed itself (the room page's send, for example), reported through the API:
   * its own ids, and its length; it ends when it's reported, on our clock, not the screen's.
   */
  recordSpan(span: {
    readonly context: TraceContext;
    readonly parentSpanId: string | null;
    readonly name: string;
    readonly durationMs: number;
    readonly status?: "ok" | "error";
    readonly attributes?: Attributes;
  }): void {
    const end = this.now();
    this.push({
      kind: "span",
      service: this.service,
      traceId: span.context.traceId,
      spanId: span.context.spanId,
      parentSpanId: span.parentSpanId,
      name: scrubText(span.name),
      startMs: end - Math.max(0, Math.round(span.durationMs)),
      endMs: end,
      status: span.status ?? "ok",
      attributes: cleanAttributes(span.attributes),
    });
  }

  log(severity: Severity, body: string, attributes?: Attributes, ctx?: TraceContext | null): void {
    this.push({
      kind: "log",
      service: this.service,
      atMs: this.now(),
      severity,
      body: scrubText(body),
      traceId: ctx?.traceId ?? null,
      spanId: ctx?.spanId ?? null,
      attributes: cleanAttributes(attributes),
    });
  }

  /**
   * Error tracking: the error as an OpenTelemetry exception log record (exception.type,
   * exception.message, exception.stacktrace), scrubbed, tied to its trace when there is one.
   */
  captureError(error: unknown, attributes?: Attributes, ctx?: TraceContext | null): void {
    const e = scrubValue(
      error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error)),
    ) as { type: string; message: string; stack?: string; code?: string };
    this.log(
      "error",
      e.message,
      {
        ...attributes,
        "exception.type": e.type,
        "exception.message": e.message,
        "exception.stacktrace": e.stack ?? null,
        "exception.code": e.code ?? null,
      },
      ctx,
    );
  }

  count(name: string, value = 1, attributes?: Attributes): void {
    this.metric("counter", name, value, "1", attributes);
  }

  /** One observation, in milliseconds unless `unit` says otherwise. */
  observe(name: string, value: number, attributes?: Attributes, unit = "ms"): void {
    this.metric("histogram", name, value, unit, attributes);
  }

  private metric(
    type: MetricRecord["type"],
    name: string,
    value: number,
    unit: string,
    attributes?: Attributes,
  ): void {
    if (!Number.isFinite(value)) return;
    this.push({
      kind: "metric",
      service: this.service,
      name,
      type,
      value,
      unit,
      atMs: this.now(),
      attributes: cleanAttributes(attributes),
    });
  }

  /** Sends what's queued. An exporter that fails loses that batch; telemetry never breaks a request. */
  flush(): Promise<void> {
    if (!this.exporter || this.queue.length === 0) return this.sending;
    const batch = this.queue;
    this.queue = [];
    const exporter = this.exporter;
    this.sending = this.sending.then(async () => {
      try {
        await exporter.export(batch);
      } catch {
        this.dropped += batch.length;
      }
    });
    return this.sending;
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/** Keeps every record, for tests. */
export class MemoryExporter implements TelemetryExporter {
  readonly records: TelemetryRecord[] = [];
  export(records: readonly TelemetryRecord[]): void {
    this.records.push(...records);
  }
  spans(): SpanRecord[] {
    return this.records.filter((r): r is SpanRecord => r.kind === "span");
  }
  logs(): LogRecord[] {
    return this.records.filter((r): r is LogRecord => r.kind === "log");
  }
  metrics(): MetricRecord[] {
    return this.records.filter((r): r is MetricRecord => r.kind === "metric");
  }
}

/**
 * One JSON line per record ({"telemetry":"span",…}), for a log that a collector or CloudWatch
 * reads: infra/staging's metric filters turn the lines into the dashboards' numbers.
 */
export class JsonLinesExporter implements TelemetryExporter {
  constructor(private readonly write: (line: string) => void) {}
  export(records: readonly TelemetryRecord[]): void {
    for (const r of records) {
      const { kind, ...rest } = r;
      this.write(JSON.stringify({ telemetry: kind, ...rest }));
    }
  }
}
