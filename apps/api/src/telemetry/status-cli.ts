import pg from "pg";
import { loadConfig } from "../config.js";
import { isPart, isPartState, readStatus, setOperatorStatus } from "./status.js";

/**
 * Ops: post or clear a part's state on the public status page (M8-16), for an incident, a drill
 * (M8-07) or maintenance. The note is public, so it never names a venue or a person.
 *   pnpm --filter @west4/api status:set -- --part payments --state degraded --note "…" --by "Abhishek"
 *   pnpm --filter @west4/api status:set -- --part payments --clear --by "Abhishek"
 *   pnpm --filter @west4/api status:set -- --show
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    if (!args.includes("--show")) {
      const part = arg("part") ?? "";
      const state = args.includes("--clear") ? null : (arg("state") ?? "");
      const by = arg("by");
      if (!isPart(part) || (state !== null && !isPartState(state)) || !by)
        throw new Error(
          "usage: --part ordering|payments|printing|texts (--state operational|degraded|outage|maintenance [--note <public note>] | --clear) --by <your name>",
        );
      await setOperatorStatus(pool, part, state, arg("note") ?? null, by, new Date().toISOString());
    }
    const status = await readStatus(pool);
    for (const p of status.parts)
      console.warn(`${p.part.padEnd(9)} ${p.state.padEnd(11)} ${p.note ?? ""}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("status-cli.ts") || process.argv[1]?.endsWith("status-cli.js"))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
