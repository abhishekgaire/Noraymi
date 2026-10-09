import { execSync } from "node:child_process";
import { DB } from "./stack.js";

/**
 * Every end-to-end run starts from a fresh load of the demo seed (M1-17), so
 * each test sees West 4 at Fri Sep 25, 2026, 10:41 PM. Needs Postgres:
 * `docker compose up -d` locally, the service container in CI. The seed goes
 * to the stack's database (e2e/stack.ts): `west4_e2e` in isolated mode.
 */
export default function globalSetup(): void {
  execSync("pnpm seed", { stdio: "inherit", env: { ...process.env, DATABASE_URL: DB } });
}
