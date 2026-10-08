import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../config.js";
import { makeClock } from "../clock.js";
import { ROTA_HINT, raisePage, readRota, setRota, type Slot } from "./paging.js";

/**
 * Ops: the on-call rota and the test page (M8-17; spec 13 · On call). Who is on call is
 * configuration: one of our Console staff per slot, by their Console email, with a phone for texts
 * when they want one. Nothing is filled in for you.
 *   pnpm --filter @west4/api oncall:set -- --slot first --email <Console staff email> [--phone +1…] --by "<your name>"
 *   pnpm --filter @west4/api oncall:set -- --show
 *   pnpm --filter @west4/api oncall:set -- --test-page --by "<your name>"
 * The test page goes to the first responder; if nobody acknowledges it in the Console within 10
 * minutes, the alert sweep sends it to the second.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
  const clock = makeClock(config, pool);
  try {
    await clock.refresh?.();
    if (args.includes("--test-page")) {
      const by = arg("by");
      if (!by) throw new Error("usage: --test-page --by <your name>");
      const made = await raisePage(
        pool,
        {
          rule: "test-page",
          key: `test-page:${randomUUID()}`,
          summary: `Test page from ${by.slice(0, 100)}`,
          test: true,
        },
        clock.now(),
      );
      console.warn(`test page ${made?.page.id} opened; the alert sweep sends it within 30 seconds`);
    } else if (!args.includes("--show")) {
      const slot = arg("slot");
      const email = arg("email");
      const by = arg("by");
      if ((slot !== "first" && slot !== "second") || !email || !by)
        throw new Error(
          "usage: --slot first|second --email <Console staff email> [--phone +1…] --by <your name>",
        );
      await setRota(pool, slot as Slot, email, arg("phone") ?? null, by);
    }
    const rota = await readRota(pool);
    for (const s of ["first", "second"] as const) {
      const r = rota.find((x) => x.slot === s);
      console.warn(
        `${s.padEnd(6)} ${r ? `${r.name} · ${r.email}${r.phone ? " · text" : ""}` : "(empty)"}`,
      );
    }
    if (rota.length < 2) console.warn(ROTA_HINT);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("oncall-cli.ts") || process.argv[1]?.endsWith("oncall-cli.js"))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
