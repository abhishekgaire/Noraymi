import { loadConfig } from "./config.js";

// The job workers arrive with M1-06 (the jobs table, the scheduler and the
// simulated clock). Until then the worker container starts, checks its
// configuration the same way the API does, and stays up.
const config = loadConfig();
process.stdout.write(`worker up · env ${config.env}\n`);

const heartbeat = setInterval(() => {
  process.stdout.write(`worker alive ${new Date().toISOString()}\n`);
}, 60_000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    clearInterval(heartbeat);
    process.exit(0);
  });
}
