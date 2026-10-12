/**
 * Keeps `pnpm db:reset` and `pnpm seed` off the demo night someone is clicking through.
 * The demo (scripts/demo-start.sh) runs its API on :3000 against the `west4` database; wiping
 * or reseeding that database under it throws away everything done in the demo so far.
 * Both commands refuse while that API answers, unless `--yes-wipe-demo` is passed
 * (scripts/demo-local.sh passes it: resetting the night is its whole job).
 */
import { databaseName } from "./config.js";

export const WIPE_DEMO_FLAG = "--yes-wipe-demo";
export const DEMO_DATABASE = "west4";
export const DEMO_HEALTH_URL = "http://127.0.0.1:3000/v1/health";

/** True when the demo API answers its health check within a second. */
export async function demoApiAnswering(healthUrl: string = DEMO_HEALTH_URL): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The refusal message when the command would wipe the running demo, else null. */
export async function demoWipeRefusal(options: {
  command: "reset" | "seed";
  url: string;
  argv: readonly string[];
  apiAnswering?: () => Promise<boolean>;
}): Promise<string | null> {
  if (options.argv.includes(WIPE_DEMO_FLAG)) return null;
  if (databaseName(options.url) !== DEMO_DATABASE) return null;
  const answering = await (options.apiAnswering ?? (() => demoApiAnswering()))();
  if (!answering) return null;
  const what = options.command === "reset" ? "drop and rebuild" : "wipe and reseed";
  return [
    `Refusing to ${what} the "${DEMO_DATABASE}" database: the demo API on :3000 is running against it,`,
    "and this would throw away everything done in the demo so far.",
    `Stop the demo first (Ctrl+C in its terminal), use another database (DB_NAME=…),`,
    `or, if you really mean to wipe the demo, run it again with ${WIPE_DEMO_FLAG}.`,
  ].join("\n");
}
