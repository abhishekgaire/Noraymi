import pg from "pg";
import { Scheduler, Worker } from "@west4/db";
import { loadConfig } from "./config.js";
import { makeClock } from "./clock.js";
import { databaseVendorObserver, setVendorObserver } from "./vendors/outcomes.js";
import { makeHandlers, makeSweeps, schedules } from "./jobs/registry.js";
import { stripeFromEnv } from "./stripe/client.js";
import { makeS3 } from "./s3.js";
import { idKeyStore } from "./id-keys/store.js";
import { SmtpMailer } from "./email/mailer.js";
import { loadEmailSettings } from "./email/settings.js";
import { loadPushSettings } from "./push/settings.js";
import { WebPushSender } from "./push/sender.js";
import { loadTextSettings } from "./texts/settings.js";
import { LogTextSender, TwilioTextSender } from "./texts/sender.js";
import { FakeVenueClient, TwilioVenueClient, loadVenueTextSettings } from "./texts/venue.js";

// The job workers and the scheduler (M1-06). Three pools so a slow export
// never delays a capture; one scheduler leads at a time.
const config = loadConfig();
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 8,
  application_name: "west4-worker",
});
const clock = makeClock(config, pool);
const log = (line: string) => process.stdout.write(`${line}\n`);
// Our error rate on Stripe and Twilio, counted per venue for the vendor-health job (M8-01).
setVendorObserver(databaseVendorObserver(pool, clock));
const email = loadEmailSettings(config.env);
const mailer = new SmtpMailer(email.smtpUrl);
const textSender = () => {
  const settings = loadTextSettings(config.env);
  return settings.mode === "twilio" ? new TwilioTextSender(settings) : new LogTextSender();
};
const venueTextSettings = loadVenueTextSettings(config.env);
const stripe = stripeFromEnv(config.env);
const handlers = makeHandlers({
  stripe: {
    pool,
    client: stripe,
    clock,
    payAppUrl: config.payAppUrl,
    texts: { allowList: venueTextSettings.allowList },
  },
  venueTexts: {
    client:
      venueTextSettings.mode === "twilio"
        ? new TwilioVenueClient(venueTextSettings.twilioBaseUrl)
        : new FakeVenueClient(),
    settings: venueTextSettings,
    secretKey: config.auth.secretKey,
  },
  s3: makeS3(),
  // The ID-scan key store (M8-14), sealed with the server key.
  idKeys: idKeyStore(config.auth.secretKey),
  mailer,
  email,
  push: new WebPushSender(loadPushSettings(config.env)),
  texts: textSender(),
});
if (
  email.env === "staging" &&
  email.allowList?.addresses.size === 0 &&
  email.allowList.domains.size === 0
)
  log("email: EMAIL_ALLOW_LIST is empty on staging, so every email is refused until it is set");

const workers = (["critical", "normal", "bulk"] as const).map(
  (name) => new Worker(pool, { pool: name, handlers: handlers[name], clock, log }),
);
const scheduler = new Scheduler(pool, {
  schedules,
  sweeps: makeSweeps(pool, log, venueTextSettings, stripeFromEnv(config.env)),
  clock,
  log,
});

// Read the stored clock before anything runs (M6-28). Until its first read the stored clock answers
// the real time, so a worker starting on staging's simulated night would otherwise run its first
// sweeps days later than the night: the 4:30 AM tab cut-off charging every open tab, the 4 AM stop.
await clock.refresh?.();
for (const worker of workers) worker.start();
scheduler.start();
log(`worker up · env ${config.env} · pools critical, normal, bulk · scheduler polling`);

// The stored clock is re-read every few seconds so a move in staging reaches every process.
const refresh = setInterval(() => {
  void clock.refresh?.();
}, 2000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    clearInterval(refresh);
    void Promise.all([...workers.map((w) => w.stop()), scheduler.stop()]).then(async () => {
      mailer.close();
      await pool.end();
      process.exit(0);
    });
  });
}
