import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

/** The guest site's data (M5-01), on the seed's clock: Fri Sep 25, 10:41 PM. */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
const site = (query = "") =>
  api.inject({ method: "GET", url: `/v1/public/venues/west4karaoke/site${query}` });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  owner = new pg.Pool({ connectionString: db.url });
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock: new FrozenClock(SEED_NOW),
    moduleCacheMs: 0,
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("the guest site", () => {
  it("reads open until 4 AM at 10:41 PM on Fri Sep 25, with West 4's words and phone", async () => {
    const r = await site();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["cache-control"]).toContain("s-maxage=60");
    const s = r.json();
    expect(s.hours).toMatchObject({ open_now: true, closes: "2026-09-26T08:00:00Z" });
    expect(s.content.hero.headline).toBe("Lose your voice.");
    expect(s.phone).toBe("+12122550011");
    expect(s.venue.address).toMatchObject({ line1: "186 W 4th St" });
  });

  it("prices read $10 a person and the VIP room $250; all in, $12.89 and $322.19", async () => {
    expect((await site()).json().prices).toEqual({
      wording: "plusTaxAndGratuity",
      gratuity_pct: 20,
      per_person_cents: 1000,
      vip: { hourly_cents: 25000, from_guests: 20 },
    });
    await owner.query(
      `update venue_settings set value = '{"priceWording": "allIn"}' where key = 'website'`,
    );
    expect((await site()).json().prices).toMatchObject({
      wording: "allIn",
      per_person_cents: 1289,
      vip: { hourly_cents: 32219 },
    });
    await owner.query(
      `update venue_settings set value = '{"priceWording": "plusTaxAndGratuity"}' where key = 'website'`,
    );
  });

  it("the parties estimator: 12 guests for 3 hours is $360.00 of room time, $31.95 tax, $72.00 gratuity, $463.95", async () => {
    expect((await site("?guests=12&hours=3")).json().estimate).toEqual({
      hours: 3,
      room_time_cents: 36000,
      tax_cents: 3195,
      gratuity_cents: 7200,
      total_cents: 46395,
    });
  });

  it("3 guests on a Friday fit a small room billed for 4", async () => {
    expect((await site("?guests=3")).json().rooms).toMatchObject({
      min_guests_tonight: 4,
      guests: 3,
      fit: { tier: "small", billable_guests: 4, hourly_cents: 4000 },
    });
  });

  it("with no song catalog, the songbook has its count and no search; Sing at the bar is live with the queue page (M6-20)", async () => {
    const s = (await site()).json();
    expect(s.songs).toEqual({ count: 113000, search: false });
    expect(s.content.singAtTheBar).toMatchObject({ heading: "Sing at the bar.", live: true });
    expect(s.menu.find((m: { name: string }) => m.name === "Beer")).toMatchObject({
      fromCents: 800,
    });
  });

  it("sections follow the modules: booking off is shown as off, and the website off answers not found", async () => {
    await owner.query("update venue_modules set state = 'off' where module_id = 'online_booking'");
    expect((await site()).json().modules.booking).toBe(false);
    await owner.query("update venue_modules set state = 'off' where module_id = 'website'");
    expect((await site()).statusCode).toBe(404);
    await owner.query(
      "update venue_modules set state = 'on' where module_id in ('website', 'online_booking')",
    );
  });
});
