import pg from "pg";
import { buildApp } from "./app.js";
import { makeClock } from "./clock.js";
import { databaseVendorObserver, setVendorObserver } from "./vendors/outcomes.js";
import { loadConfig } from "./config.js";
import { loadEmailSettings } from "./email/settings.js";
import { loadPushSettings } from "./push/settings.js";
import { setTelemetry, telemetryFromEnv } from "./telemetry/index.js";

const config = loadConfig();
// Traces, metrics and error reports (M8-16): where they go is OTEL_EXPORTER_OTLP_ENDPOINT's call.
const tel = setTelemetry(telemetryFromEnv("west4-api"));
process.on("SIGTERM", () => void tel.shutdown());
// Our error rate on Stripe and Twilio, counted per venue for the vendor-health job (M8-01).
const vendorPool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 2,
  application_name: "west4-vendor-calls",
});
setVendorObserver(databaseVendorObserver(vendorPool, makeClock(config, vendorPool)));
// The browser tests flip modules straight in the database between tests, which the module cache
// wouldn't see for a few seconds: locally, MODULE_CACHE_MS=0 reads every venue's modules afresh.
const moduleCacheMs =
  config.env === "local" && process.env["MODULE_CACHE_MS"] !== undefined
    ? Number(process.env["MODULE_CACHE_MS"])
    : undefined;
const app = buildApp({
  logger: true,
  config,
  email: loadEmailSettings(config.env),
  push: loadPushSettings(config.env),
  ...(moduleCacheMs !== undefined && Number.isFinite(moduleCacheMs) ? { moduleCacheMs } : {}),
});

app.listen({ port: config.port, host: config.host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
