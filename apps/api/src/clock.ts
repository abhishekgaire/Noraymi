import type pg from "pg";
import { StoredClock } from "@west4/db";
import { systemClock, type Clock } from "@west4/shared";
import type { Config } from "./config.js";

/**
 * The process's clock. Production: the real clock, always. Staging and local
 * (ALLOW_STAGING_FEATURES): the stored simulated clock, shared by the API,
 * the workers and the scheduler through the clock_control row.
 */
export function makeClock(
  config: Config,
  pool: pg.Pool,
): Clock & { refresh?: () => Promise<void> } {
  if (!config.allowStagingFeatures) return systemClock;
  return new StoredClock(pool);
}
