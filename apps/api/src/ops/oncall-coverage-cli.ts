import { readFileSync } from "node:fs";
import pg from "pg";
import { loadConfig } from "../config.js";
import { makeClock } from "../clock.js";
import { venueClock } from "../rooms/assignment.js";
import { applyShift, checkCoverage, rotaFileSchema } from "./oncall-coverage.js";

/**
 * Ops: the gate's on-call rota (M9-16).
 *   pnpm --filter @west4/api oncall:coverage -- --rota docs/gate/oncall-rota.json
 *     checks every opening hour of the gate's nights (from the venue's own hours, through each night's
 *     close to the cutover) has a shift with a first and a second responder, two different active
 *     Console staff; prints each gap and exits non-zero on any.
 *   … --apply --by "<your name>"   puts the shift on now into the pager's first and second slots
 *     (run it at each handover, then `oncall:set -- --show`).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const path = arg("rota") ?? "docs/gate/oncall-rota.json";
  const file = rotaFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
  const clock = makeClock(config, pool);
  try {
    await clock.refresh?.();
    const venue = (
      await pool.query<{ id: string }>("select id from venues where slug = $1 or id::text = $1", [
        file.venue,
      ])
    ).rows[0];
    if (!venue) throw new Error(`no venue ${file.venue}`);
    const r = await checkCoverage(pool, venue.id, file);
    for (const p of r.problems) process.stdout.write(`problem: ${p}\n`);
    for (const u of r.unknown) process.stdout.write(`not an active Console staff member: ${u}\n`);
    for (const g of r.gaps)
      process.stdout.write(
        `gap ${g.businessDate}: ${g.from.toString()} to ${g.to.toString()} (${g.why})\n`,
      );
    process.stdout.write(
      `${r.ok ? "ok  " : "FAIL"} ${r.nights} nights, ${r.gaps.length} gaps, ${file.shifts.length} shifts\n`,
    );
    if (args.includes("--apply")) {
      const by = arg("by");
      if (!by) throw new Error("usage: --apply --by <your name>");
      const tz = (await venueClock(pool, venue.id)).timeZone;
      const set = await applyShift(pool, file, tz, clock.now(), by);
      process.stdout.write(
        set
          ? `on call now: first ${set[0]!.name}, second ${set[1]!.name}\n`
          : "no shift is on now\n",
      );
    }
    if (!r.ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
