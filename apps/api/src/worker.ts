import pg from "pg";
import { Scheduler, Worker } from "@west4/db";
import { loadConfig } from "./config.js";
import { makeClock } from "./clock.js";
import { makeHandlers, makeSweeps, schedules } from "./jobs/registry.js";
import { makeS3 } from "./s3.js";
import { SmtpMailer } from "./email/mailer.js";
import { loadEmailSettings } from "./email/settings.js";

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
const email = loadEmailSettings(config.env);
const mailer = new SmtpMailer(email.smtpUrl);
const handlers = makeHandlers({ s3: makeS3(), mailer, email });
if (
  email.env === "staging" &&
  email.allowList?.addresses.size === 0 &&
  email.allowList.domains.size === 0
)
  log("email: EMAIL_ALLOW_LIST is empty on staging, so every email is refused until it is set");

const workers = (["critical", "normal", "bulk"] as const).map(
  (name) => new Worker(pool, { pool: name, handlers: handlers[name], clock, log }),
);
const scheduler = new Scheduler(pool, { schedules, sweeps: makeSweeps(pool, log), clock, log });

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
