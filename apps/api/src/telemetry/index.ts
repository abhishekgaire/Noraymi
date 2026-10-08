import {
  JsonLinesExporter,
  OtlpHttpExporter,
  Telemetry,
  parseOtlpHeaders,
  type TelemetryExporter,
} from "@west4/shared";

/**
 * The API's and the job workers' telemetry (M8-16; spec 13 · Watching production). Where it goes
 * is a setting, never code:
 * - OTEL_EXPORTER_OTLP_ENDPOINT set: OTLP/HTTP JSON to that collector or vendor, with
 *   OTEL_EXPORTER_OTLP_HEADERS (k=v,k=v) for its key;
 * - otherwise on staging and production: one JSON line per record on stdout, which CloudWatch
 *   keeps 30 days and infra/staging/observability.tf turns into the dashboards' numbers;
 * - otherwise (local, tests): off, unless a test sets its own.
 * Everything is scrubbed of personal data before it's queued (@west4/shared telemetry/redact).
 */
export function exporterFromEnv(
  env: Record<string, string | undefined>,
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): TelemetryExporter | null {
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim();
  const deployment = env["WEST4_ENV"] ?? "local";
  if (endpoint)
    return new OtlpHttpExporter(
      endpoint,
      parseOtlpHeaders(env["OTEL_EXPORTER_OTLP_HEADERS"]),
      undefined,
      {
        "deployment.environment": deployment,
      },
    );
  if (deployment === "staging" || deployment === "production") return new JsonLinesExporter(write);
  return null;
}

export function telemetryFromEnv(
  service: string,
  env: Record<string, string | undefined> = process.env,
): Telemetry {
  return new Telemetry({
    service: env["OTEL_SERVICE_NAME"]?.trim() || service,
    exporter: exporterFromEnv(env),
  });
}

let current = new Telemetry({ service: "west4-api", exporter: null });

/** The process's telemetry; index.ts and worker.ts set it from the environment, tests set their own. */
export function telemetry(): Telemetry {
  return current;
}

export function setTelemetry(next: Telemetry): Telemetry {
  current = next;
  return next;
}
