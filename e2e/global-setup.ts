import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DB } from "./stack.js";

/**
 * Every end-to-end run starts from a fresh load of the demo seed (M1-17), so
 * each test sees West 4 at Fri Sep 25, 2026, 10:41 PM. Needs Postgres:
 * `docker compose up -d` locally, the service container in CI. The seed goes
 * to the stack's database (e2e/stack.ts): `west4_e2e` in isolated mode.
 */
export default function globalSetup(): void {
  // The seed refuses `west4` while an API answers on :3000 (packages/db/src/demo-guard.ts). That
  // API is this run's own unless scripts/demo-start.sh is running (its pid marker is live): then
  // the refusal stands, and the founder's demo night is kept (use `pnpm e2e:isolated` beside it).
  const flag = demoRunning() ? "" : " --yes-wipe-demo";
  execSync(`pnpm seed${flag}`, { stdio: "inherit", env: { ...process.env, DATABASE_URL: DB } });
}

function demoRunning(): boolean {
  try {
    const pid = Number(readFileSync(".demo-logs/demo.pid", "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
