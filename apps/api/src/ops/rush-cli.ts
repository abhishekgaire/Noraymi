import pg from "pg";
import { databaseUrl, withVenue } from "@west4/db";
import { loadAuthConfig, type West4Env } from "../config.js";
import { RUSH_ORDERS, driveRush, practiceRooms } from "./rush.js";

/**
 * The rush driver (M9-11; docs/trial/rush-script.md):
 *   pnpm --filter @west4/api rush:drive -- --api <API url> [--venue west4karaoke] [--speed 1] [--dry-run]
 * Places the script's room orders on the open practice sessions at their times. Needs the
 * database and the AUTH_SECRET_KEY the API runs with (to open the practice rooms' codes).
 * `--dry-run` lists the rooms and the schedule and orders nothing.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const slug = opt("--venue") ?? "west4karaoke";
  const apiUrl = opt("--api");
  if (!apiUrl)
    throw new Error("usage: rush:drive -- --api <API url> [--venue slug] [--speed n] [--dry-run]");
  const env = (process.env["WEST4_ENV"] ?? "local") as West4Env;
  const { secretKey } = loadAuthConfig(env, process.env);
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const venue = (
      await pool.query<{ id: string }>("select id from venues where slug = $1", [slug])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const rooms = await withVenue(pool, { venueId: venue.id, requestId: "ops:rush" }, (c) =>
      practiceRooms(c, venue.id, secretKey),
    );
    console.warn(`practice rooms: ${rooms.map((r) => r.roomName).join(", ") || "none"}`);
    if (args.includes("--dry-run")) {
      for (const [n, o] of RUSH_ORDERS.entries())
        console.warn(
          `order ${n + 1} at ${o.atS} s: ${o.drinks} ${o.alcohol ? "with alcohol" : "soft"}`,
        );
      return;
    }
    const runId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const result = await driveRush(
      { apiUrl, slug, rooms, runId, speed: Number(opt("--speed") ?? "1") },
      { log: (line) => console.warn(line) },
    );
    console.warn(`placed ${result.placed} of ${RUSH_ORDERS.length} room orders (run ${runId})`);
    for (const f of result.failed) console.error(`- ${f}`);
    if (result.failed.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
