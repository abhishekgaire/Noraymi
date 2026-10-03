import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

/** The guest menu (M5-03): 86'd items in place, the happy-hour banner from dated price rules the checks pass. */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let margId: string;
const menu = async () =>
  (await api.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/menu" })).json();
const rule = (name: string, priceCents: number, extra = "") =>
  owner.query(
    `insert into price_rules (venue_id, name, kind, days, from_min, to_min, target, price_cents, checked_pack_version${extra ? ", ends_on" : ""})
     values ($1, $2, 'happy_hour', '{1,2,3,4}', 960, 1140, $3, $4, '2026.09'${extra ? ", $5" : ""})`,
    [venueId, name, JSON.stringify({ item_ids: [margId] }), priceCents, ...(extra ? [extra] : [])],
  );

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
  margId = (
    await owner.query<{ id: string }>(
      "select id from menu_items where venue_id = $1 and name = 'Margarita'",
      [venueId],
    )
  ).rows[0]!.id;
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

describe("the guest menu", () => {
  it("keeps Hoegaarden, Casamigos Blanco and Casamigos · bottle in place, marked out tonight", async () => {
    const m = await menu();
    const rows = m.categories.flatMap(
      (c: {
        items: {
          name: string;
          out_tonight: boolean;
          variants: { name: string; out_tonight: boolean }[];
        }[];
      }) =>
        c.items.flatMap((i) =>
          i.variants.map((v) => ({
            name: i.variants.length > 1 ? `${i.name} · ${v.name}` : i.name,
            out: i.out_tonight || v.out_tonight,
          })),
        ),
    );
    expect(
      rows.filter((r: { out: boolean }) => r.out).map((r: { name: string }) => r.name),
    ).toEqual(["Hoegaarden", "Casamigos Blanco", "Casamigos · bottle"]);
  });

  it("has no happy-hour banner with no price rules", async () => {
    expect((await menu()).happy_hours).toEqual([]);
  });

  it("shows a happy hour the checks pass, and hides one they refuse or one out of date", async () => {
    await rule("Happy hour", 650);
    // Saved under an older pack, or straight into the table: the checks refuse it now ($6.50 is the floor).
    await rule("Too cheap", 600);
    await rule("Last week", 700, "2026-09-20");
    const m = await menu();
    expect(m.happy_hours).toEqual([
      {
        name: "Happy hour",
        days: [1, 2, 3, 4],
        from_min: 960,
        to_min: 1140,
        pct_off: null,
        price_cents: 650,
        qty: 1,
        items: ["Margarita"],
      },
    ]);
  });

  it("shows no promotions with Packages & specials off", async () => {
    await owner.query("update venue_modules set state = 'off' where module_id = 'packages'");
    expect((await menu()).happy_hours).toEqual([]);
    await owner.query("update venue_modules set state = 'on' where module_id = 'packages'");
  });
});
