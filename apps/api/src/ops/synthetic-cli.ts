import pg from "pg";
import { loadConfig } from "../config.js";
import { setupSyntheticVenue } from "./synthetic-setup.js";

/**
 * Ops: make a venue our own test venue for the synthetic check (M8-18), and print the
 * SYNTHETIC_CHECK secret for the worker. The PIN is read from SYNTHETIC_PIN so it stays out of the
 * shell's history.
 *   SYNTHETIC_PIN=… pnpm --filter @west4/api synthetic:setup -- --venue <id> --membership <id> --api-url https://api… --by "<your name>"
 * The secret goes to stdout only: put it in the secrets store (SYNTHETIC_CHECK), never in a file.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const venueId = arg("venue");
  const membershipId = arg("membership");
  const apiUrl = arg("api-url");
  const by = arg("by");
  const pin = process.env["SYNTHETIC_PIN"];
  if (!venueId || !membershipId || !apiUrl || !by || !pin)
    throw new Error(
      "usage: SYNTHETIC_PIN=… synthetic:setup -- --venue <id> --membership <id> --api-url <url> --by <your name>",
    );
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    const made = await setupSyntheticVenue(pool, { venueId, membershipId, pin, apiUrl, by });
    console.warn(
      `venue ${venueId} is now our test venue; synthetic bar device ${made.device_id} paired in training.\n` +
        "Set the line below as the worker's SYNTHETIC_CHECK secret:",
    );
    process.stdout.write(`${JSON.stringify(made)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
