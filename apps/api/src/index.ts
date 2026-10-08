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
const app = buildApp({
  logger: true,
  config,
  email: loadEmailSettings(config.env),
  push: loadPushSettings(config.env),
});

app.listen({ port: config.port, host: config.host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
