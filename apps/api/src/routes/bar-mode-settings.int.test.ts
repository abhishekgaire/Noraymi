import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Admin → Bar mode, the settings (M6-26; Settings · BarModeSettings, promotion checks; Song systems
 * and texts · Bar mode, Promotions): West 4's values, a free drink with a song refused by the
 * promotion checks with the reason, the cautious ranges, and a free night: Sofia R.'s song needs no
 * credit and starts at $0.00.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let n = 0;
const clock = new SimulatedClock(SEED_NOW);
const as = (slug: string, role: string, session: "passkey" | "pin" = "passkey") => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session,
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "POST" | "PUT", path: string, payload?: object) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `bar-mode-${++n}` },
    ...(payload ? { payload } : {}),
  });
type BarMode = {
  songPriceCents: number | null;
  drinkCredit: boolean;
  freeNights: number[];
  songsPerRound: number;
  alerts: { beforeYou: number; upNextText: boolean };
  upNextCount: number;
  freeDrinkWithSong?: boolean;
};
const barMode = async () => (await call("GET", "/settings/barMode")).json().value as BarMode;
const save = (value: BarMode) => call("PUT", "/settings", { values: { barMode: value } });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("Admin → Bar mode settings", () => {
  it("West 4: no song price, drink credit on, no free nights, 1 song per round, both alerts on, 5 on the TV", async () => {
    as("abhishek", "owner");
    expect(await barMode()).toMatchObject({
      songPriceCents: null,
      drinkCredit: true,
      freeNights: [],
      songsPerRound: 1,
      alerts: { beforeYou: 2, upNextText: true },
      upNextCount: 5,
    });
  });

  it("a free drink with a song is refused by the promotion checks with the reason, and nothing saves", async () => {
    as("abhishek", "owner");
    const current = await barMode();
    const r = await save({ ...current, songsPerRound: 2, freeDrinkWithSong: true });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("a free drink with a song is free alcohol");
    expect((await barMode()).songsPerRound).toBe(1);
  });

  it("refuses a $0.00 song price, a night named twice and a TV of 0 singers", async () => {
    as("abhishek", "owner");
    const current = await barMode();
    const r = await save({ ...current, songPriceCents: 0, freeNights: [1, 1], upNextCount: 0 });
    expect(r.statusCode).toBe(400);
    const message = r.json().error.message as string;
    expect(message).toContain("A song price is more than $0.00");
    expect(message).toContain("Each free night is a different day");
    expect(message).toContain("1 to 10 singers");
  });

  it("a song price and 2 songs per round save and read back", async () => {
    as("abhishek", "owner");
    const current = await barMode();
    const r = await save({ ...current, songPriceCents: 500, songsPerRound: 2 });
    expect(r.statusCode, r.body).toBe(200);
    expect(await barMode()).toMatchObject({ songPriceCents: 500, songsPerRound: 2 });
    const back = await save({ ...current, songPriceCents: null, songsPerRound: 1 });
    expect(back.statusCode, back.body).toBe(200);
  });

  it("on a free night (Friday) Sofia R.'s song isn't flagged and starts at $0.00 without a credit", async () => {
    as("abhishek", "owner");
    const flagOf = async () =>
      (
        (await call("GET", "/song-queue")).json().up_next as { id: string; flag: string | null }[]
      ).find((s) => s.id === ids["song_sg_sofia"])?.flag;
    as("maya", "bartender", "pin");
    expect(await flagOf()).toBe("needs_drink_credit");
    as("abhishek", "owner");
    const current = await barMode();
    expect((await save({ ...current, freeNights: [5] })).statusCode).toBe(200);
    as("maya", "bartender", "pin");
    expect(await flagOf()).toBeNull();
    const credits = async () =>
      (
        await owner.query(
          "select count(*)::int as n from song_credits where singer_id = $1 and used_at is not null",
          [ids["sg_sofia"]],
        )
      ).rows[0].n as number;
    const before = await credits();
    const res = await call("POST", `/song-queue/${ids["song_sg_sofia"]}/start`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ paid_with: "price", amount_cents: 0 });
    expect(await credits()).toBe(before);
  });
});
