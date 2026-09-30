import pg from "pg";
import { Scheduler, Worker } from "@west4/db";
import { loadConfig } from "./config.js";
import { makeClock } from "./clock.js";
import { makeHandlers, makeSweeps, schedules } from "./jobs/registry.js";
import { makeS3 } from "./s3.js";

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
const handlers = makeHandlers(makeS3());

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
      await pool.end();
      process.exit(0);
    });
  });
}
