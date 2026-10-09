import { describe, expect, it } from "vitest";
import {
  assertSeedAllowed,
  mapSeedModules,
  mapSeedPermissions,
  mapSeedSettings,
  parsedSeedSettings,
  readSeedFile,
  seedFilePath,
  seedUuid,
} from "./seed.js";

const seed = readSeedFile(seedFilePath({}));

describe("seed ids", () => {
  it("gives the same UUID for the same slug, and different ones for different slugs", () => {
    expect(seedUuid("maya")).toBe(seedUuid("maya"));
    expect(seedUuid("maya")).not.toBe(seedUuid("diego"));
    expect(seedUuid("room_9")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("production guard", () => {
  it("refuses WEST4_ENV=production and a production-looking host", () => {
    expect(() =>
      assertSeedAllowed("postgres://x@localhost/west4", { WEST4_ENV: "production" }),
    ).toThrow(/never loads into production/);
    expect(() => assertSeedAllowed("postgres://x@west4-prod.rds.amazonaws.com/west4", {})).toThrow(
      /never loads into production/,
    );
    expect(() =>
      assertSeedAllowed("postgres://x@localhost/west4", { WEST4_ENV: "staging" }),
    ).not.toThrow();
    expect(() => assertSeedAllowed("postgres://x@localhost/west4", {})).not.toThrow();
  });
});

describe("settings mapping", () => {
  const values = mapSeedSettings(seed, 20);
  const parsed = Object.fromEntries(
    parsedSeedSettings(values).map((s) => [s.key, s.value]),
  ) as Record<string, Record<string, unknown>>;

  it("every key passes spec 03's schema", () => {
    expect(Object.keys(parsed)).toHaveLength(17);
    expect(parsed["kitchen"]).toEqual({ allergyNotice: null, lastOrder: null, unsentWarnMin: 5 });
  });

  it("maps the seed's names to the spec's", () => {
    expect((parsed["prices"]!["billing"] as { incrementMin: number }).incrementMin).toBe(1);
    expect(parsed["tabs"]!["flagOverCents"]).toBe(60000);
    expect(parsed["rooms"]!["cleaningEnds"]).toBe("staff");
    expect(parsed["rooms"]!["cleaningFlagMin"]).toBe(8);
    expect(parsed["barMode"]!["songsPerRound"]).toBe(1);
    expect(parsed["prices"]!["minSpend"]).toEqual([]);
    expect(parsed["ordering"]).toEqual({ hostLockDefault: false });
  });

  it("keeps the seed's nulls empty", () => {
    expect(parsed["safety"]!["occupancyLimit"]).toBeNull();
    expect(parsed["barMode"]!["songPriceCents"]).toBeNull();
  });

  it("numbers the week Sunday 0 to Saturday 6", () => {
    const weekly = parsed["hours"]!["weekly"] as { day: number; opens: string }[];
    expect(weekly.find((w) => w.day === 6)?.opens).toBe("14:00");
    expect(weekly.find((w) => w.day === 1)?.opens).toBe("16:00");
  });
});

describe("modules mapping", () => {
  it("turns on the 13 modules, and allows only phase 1 ones", () => {
    const rows = mapSeedModules(seed.venue);
    expect(rows.filter((r) => r.state === "on")).toHaveLength(13);
    expect(rows.find((r) => r.moduleId === "kitchen")).toEqual({
      moduleId: "kitchen",
      allowed: false,
      state: "off",
    });
    expect(rows.find((r) => r.moduleId === "song_system")).toEqual({
      moduleId: "song_system",
      allowed: true,
      state: "off",
    });
    expect(
      rows
        .filter((r) => !r.allowed)
        .map((r) => r.moduleId)
        .sort(),
    ).toEqual(["event_sales", "guests_loyalty", "kitchen", "multi_location"]);
  });
});

describe("permissions mapping", () => {
  it("finds West 4's table equal to the default one", () => {
    expect(mapSeedPermissions(seed.role_permissions)).toEqual([]);
  });

  it("writes a row where the seed differs", () => {
    const rows = seed.role_permissions.map((r) =>
      r.action.startsWith("Ask for a refund") ? { ...r, bartender: true } : r,
    );
    expect(mapSeedPermissions(rows)).toEqual([
      { role: "bartender", action: "refunds.request", allowed: true },
    ]);
  });
});
