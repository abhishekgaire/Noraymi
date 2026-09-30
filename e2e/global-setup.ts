import { execSync } from "node:child_process";

/**
 * Every end-to-end run starts from a fresh load of the demo seed (M1-17), so
 * each test sees West 4 at Fri Sep 25, 2026, 10:41 PM. Needs Postgres:
 * `docker compose up -d` locally, the service container in CI.
 */
export default function globalSetup(): void {
  execSync("pnpm seed", { stdio: "inherit" });
}
