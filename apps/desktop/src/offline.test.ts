import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_NOW, Temporal } from "@west4/shared";
import { DesktopCache } from "./cache.js";
import { readOfflineRead, saveOfflineRead } from "./offline.js";

/**
 * The offline view's store (M8-03) on the simulated clock: the bar's tabs as
 * of the last sync at 10:41 PM Fri Sep 25, unreadable raw or with another key,
 * and gone at 6:00 AM Sat Sep 26.
 */
const KEY = "c".repeat(64);
const NEW_YORK = { timeZone: "America/New_York", dayCutover: "06:00" };
const V = "/v1/venues/0b6c0c9e-3d0a-4a43-9a43-1c1c2f5a7f10";
const NOW = Temporal.Instant.from(SEED_NOW);
const TABS = { tabs: [{ name: "Jess P.", totals: { total_cents: 3266 } }] };

describe("the offline view's store", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => {
    dir = mkdtempSync(join(tmpdir(), "west4-offline-"));
    const file = join(dir, "cache.sqlite");
    return { file, cache: DesktopCache.open(file, KEY, NEW_YORK) };
  };

  it("keeps a listed read with its sync time, and refuses anything else", () => {
    const { cache } = open();
    expect(saveOfflineRead(cache, NOW, `${V}/tabs`, JSON.stringify(TABS))).toBe(true);
    expect(readOfflineRead(cache, NOW, `${V}/tabs`)).toEqual({
      synced_at: NOW.toString(),
      body: TABS,
    });
    expect(saveOfflineRead(cache, NOW, "/v1/auth/me", "{}")).toBe(false);
    expect(saveOfflineRead(cache, NOW, `${V}/tabs`, "not json")).toBe(false);
    expect(saveOfflineRead(cache, NOW, `${V}/tabs`, { tabs: [] })).toBe(false);
    expect(saveOfflineRead(cache, NOW, `${V}/tabs`, "x".repeat(2_000_001))).toBe(false);
    expect(readOfflineRead(cache, NOW, "/v1/auth/me")).toBeNull();
    cache.close();
  });

  it("can't be read raw or without the keychain's key", () => {
    const { file, cache } = open();
    saveOfflineRead(cache, NOW, `${V}/tabs`, JSON.stringify(TABS));
    cache.close();
    const raw = readFileSync(file, "latin1");
    expect(raw).not.toContain("Jess P.");
    expect(raw).not.toContain("/tabs");
    expect(raw.startsWith("SQLite format 3")).toBe(false);
    expect(() => DesktopCache.open(file, "d".repeat(64), NEW_YORK)).toThrow(/not a database/);
  });

  it("keeps Fri Sep 25 through 5:59 AM, and has none of it at 6:00 AM Sat Sep 26", () => {
    const { cache } = open();
    saveOfflineRead(cache, NOW, `${V}/tabs`, JSON.stringify(TABS));
    const before = Temporal.Instant.from("2026-09-26T09:59:59Z");
    expect(readOfflineRead(cache, before, `${V}/tabs`)?.body).toEqual(TABS);
    const after = Temporal.Instant.from("2026-09-26T10:00:00Z");
    expect(readOfflineRead(cache, after, `${V}/tabs`)).toBeNull();
    expect(cache.businessDate()).toBe("2026-09-26");
    cache.close();
  });
});
