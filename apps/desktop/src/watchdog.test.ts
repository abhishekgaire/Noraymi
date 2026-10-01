import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The watchdog against a fake app: the app exits, and comes back within
 * 10 seconds with nobody touching anything; the app stops answering, and is
 * ended and started again. The same script runs under macOS's launchd and
 * Windows' scheduled task; here it runs under plain Node.js on any CI.
 */
const here = dirname(fileURLToPath(import.meta.url));
const watchdog = join(here, "..", "watchdog", "watchdog.cjs");

const FAKE_APP = `
const fs = require("node:fs");
const [, , alive, counter, mode] = process.argv;
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
fs.writeFileSync(counter, String(n));
fs.writeFileSync(alive, "");
if (mode === "crash-once" && n === 1) setTimeout(() => process.exit(1), 300);
else if (mode === "hang-once" && n === 1) { /* never touches alive again */ setInterval(() => {}, 1000); }
else setInterval(() => fs.utimesSync(alive, new Date(), new Date()), 200);
`;

const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
};

describe("the watchdog", () => {
  let dir = "";
  let dog: ChildProcess | null = null;
  afterEach(() => {
    dog?.kill("SIGTERM");
    dog = null;
    rmSync(dir, { recursive: true, force: true });
  });

  const launch = (mode: string, staleMs: number) => {
    dir = mkdtempSync(join(tmpdir(), "west4-watchdog-"));
    const app = join(dir, "app.cjs");
    writeFileSync(app, FAKE_APP);
    const alive = join(dir, "alive");
    const counter = join(dir, "starts");
    dog = spawn(
      process.execPath,
      [
        watchdog,
        "--app",
        process.execPath,
        "--alive",
        alive,
        "--stale-ms",
        String(staleMs),
        "--restart-ms",
        "500",
        "--poll-ms",
        "200",
        "--",
        app,
        alive,
        counter,
        mode,
      ],
      { stdio: "ignore" },
    );
    return { counter };
  };

  const starts = (counter: string) => {
    try {
      return Number(readFileSync(counter, "utf8"));
    } catch {
      return 0;
    }
  };

  it("brings the app back within 10 seconds after it exits", async () => {
    const { counter } = launch("crash-once", 30_000);
    const started = Date.now();
    expect(await waitFor(() => starts(counter) >= 2, 10_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("ends an app that stops answering and starts it again", async () => {
    const { counter } = launch("hang-once", 1500);
    expect(await waitFor(() => starts(counter) >= 2, 10_000)).toBe(true);
  });
});
