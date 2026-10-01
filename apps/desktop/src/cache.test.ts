import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_NOW } from "@west4/shared";
import { DesktopCache } from "./cache.js";

/**
 * The encrypted cache on the simulated clock: rows for Fri Sep 25 (the seed's
 * business date), kept through the night, gone at 6:00 AM on Sat Sep 26.
 */
const KEY = "a".repeat(64);
const NEW_YORK = { timeZone: "America/New_York", dayCutover: "06:00" };

describe("the desktop cache", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("holds the current business date's rows, and nothing from the day before after 6:00 AM", () => {
    dir = mkdtempSync(join(tmpdir(), "west4-cache-"));
    const file = join(dir, "cache.sqlite");
    const cache = DesktopCache.open(file, KEY, NEW_YORK);
    cache.put(SEED_NOW, "room", "9", { name: "Room 9", party: 12 });
    cache.put(SEED_NOW, "room", "5", { name: "Room 5" });
    expect(cache.businessDate()).toBe("2026-09-25");
    expect(cache.list("room")).toHaveLength(2);
    expect(cache.get("room", "9")).toEqual({ name: "Room 9", party: 12 });
    // 5:59 AM Sat Sep 26 New York is still Friday's business date.
    expect(cache.wipeIfPastCutover("2026-09-26T09:59:00Z")).toBe(false);
    expect(cache.list("room")).toHaveLength(2);
    // 6:00 AM: the cutover.
    expect(cache.wipeIfPastCutover("2026-09-26T10:00:00Z")).toBe(true);
    expect(cache.list("room")).toEqual([]);
    expect(cache.businessDate()).toBe("2026-09-26");
    cache.close();
  });

  it("can't be read without the key, or with another key, and the file holds no plaintext", () => {
    dir = mkdtempSync(join(tmpdir(), "west4-cache-"));
    const file = join(dir, "cache.sqlite");
    const cache = DesktopCache.open(file, KEY, NEW_YORK);
    cache.put(SEED_NOW, "guest", "marcus", { name: "Marcus T." });
    cache.close();
    expect(readFileSync(file, "latin1")).not.toContain("Marcus");
    expect(() => DesktopCache.open(file, "b".repeat(64), NEW_YORK)).toThrow(/not a database/);
    const again = DesktopCache.open(file, KEY);
    expect(again.get("guest", "marcus")).toEqual({ name: "Marcus T." });
    // The venue's clock was kept with the cache, so the wipe works before the next sign-in.
    expect(again.wipeIfPastCutover("2026-09-26T10:00:00Z")).toBe(true);
    again.close();
  });

  it("refuses rows before it knows the venue's clock", () => {
    dir = mkdtempSync(join(tmpdir(), "west4-cache-"));
    const cache = DesktopCache.open(join(dir, "cache.sqlite"), KEY);
    expect(() => cache.put(SEED_NOW, "room", "9", {})).toThrow(/venue clock/);
    cache.close();
  });
});
