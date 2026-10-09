import { execSync } from "node:child_process";
import { API } from "./stack.js";

/**
 * The one Friday night every spec shares (M1-17). The simulated clock lives in
 * the database and the API caches it for up to 2 seconds, so a spec that moves
 * it, or reseeds, leaves the next spec (in any project, in any order) wherever
 * it stopped. Every spec file that moves the clock puts it back after each test
 * with setClock(), and a reseed always pushes the clock through the API at once
 * (freshNight), so no request reads the night before it.
 */
/**
 * Reseeding inside the run calls the built loader directly: `pnpm seed` would also rebuild
 * packages/db, and a rebuilt dist restarts the API under `tsx watch` mid-test (ECONNREFUSED).
 * `pnpm e2e` builds everything once before the run, and the global setup uses `pnpm seed`.
 */
export const SEED_COMMAND = "node packages/db/dist/cli.js seed";

export const SEED_INSTANT = "2026-09-26T02:41:00Z"; // Fri Sep 25, 2026, 10:41 PM in New York

export async function setClock(iso: string = SEED_INSTANT): Promise<void> {
  const r = await fetch(`${API}/v1/ops/clock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server_time: iso }),
  });
  if (!r.ok) throw new Error(`the simulated clock didn't move (${r.status})`);
}

/** A fresh load of the demo seed, with the API's clock at the seed's 10:41 PM straight away. */
export async function freshNight(): Promise<void> {
  execSync(SEED_COMMAND, { stdio: ["ignore", "ignore", "pipe"] });
  await setClock();
}
