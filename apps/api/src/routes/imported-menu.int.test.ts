import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  checkMapping,
  generateSigningKey,
  ImportInvalid,
  loadDemoSeed,
  prepareImport,
  publishRulePack,
  resolveVenue,
  runImport,
  type ImportResult,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { menuHtml } from "../menu/pdf.js";

/**
 * M9-04 through the API: a made-up menu export imported into West 4 through
 * Admin → Menu's save path. The menu page, the PDF's page and the room page
 * show the same items and prices; alcohol and tax categories carry over;
 * the bar grid gets a new version from the next business date with each item
 * in a fixed slot; a package the promotion checks refuse stops the import.
 */
const dir = join(import.meta.dirname, "../../../../packages/db/test-fixtures/import/menu");
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let result: ImportResult;
const clock = new FrozenClock(SEED_NOW);

const files = (edit?: (file: string, text: string) => string) => {
  const mapping = checkMapping(
    JSON.parse(readFileSync(join(dir, "mapping.json"), "utf8")),
  ).mapping!;
  const read = (f: string) => {
    const text = readFileSync(join(dir, f), "utf8");
    return edit ? edit(f, text) : text;
  };
  return { mapping, read };
};
const importMenu = async (edit?: (file: string, text: string) => string, now = SEED_NOW) => {
  const venue = await resolveVenue(owner, venueId);
  const { mapping, read } = files(edit);
  return runImport({
    pool: owner,
    venue,
    prepared: prepareImport(mapping, read, venue.timeZone),
    dryRun: false,
    now,
  });
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
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
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => andy],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

const dollars = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

describe("the menu import (M9-04)", () => {
  it("a package the promotion checks refuse stops the import with the reason, and nothing loads", async () => {
    const before = await owner.query(
      "select count(*)::int as n from menu_items where venue_id = $1",
      [venueId],
    );
    const refused = importMenu((f, text) =>
      f === "packages.csv" ? text + "T-PKG-2,Test open bar,$30.00,Y,T-LAGER\n" : text,
    );
    await expect(refused).rejects.toThrow(ImportInvalid);
    await expect(refused).rejects.toThrow(
      /packages\.csv:3 the rule pack's promotion checks refuse "Test open bar"/,
    );
    const after = await owner.query(
      "select count(*)::int as n from menu_items where venue_id = $1",
      [venueId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const refs = await owner.query(
      "select count(*)::int as n from import_refs where venue_id = $1",
      [venueId],
    );
    expect(refs.rows[0].n).toBe(0);
  });

  it("loads the menu through the save path: variants, choices, the package checked against the rule pack", async () => {
    result = await importMenu();
    expect(result.reconciles).toBe(true);
    expect(result.kinds.menu).toMatchObject({
      in_db: 5,
      cents_in_db: 800 + 2400 + 300 + 1400 + 900,
    });
    expect(result.kinds.modifiers).toMatchObject({ in_db: 2 });
    expect(result.kinds.packages).toMatchObject({ in_db: 1, cents_in_db: 3500 });
    const pkg = await owner.query(
      "select checked_pack_version, contents from packages where venue_id = $1 and name = 'Test lager bucket'",
      [venueId],
    );
    expect(pkg.rows[0].checked_pack_version).not.toBe("unchecked");
    expect(pkg.rows[0].contents).toEqual([{ item_id: expect.any(String), qty: 5 }]);
    const marg = await owner.query(
      `select g.name as grp, g.required, o.name, o.price_delta_cents, o.is_default
         from menu_items i join modifier_groups g on g.item_id = i.id join menu_options o on o.group_id = g.id
        where i.venue_id = $1 and i.name = 'Test Margarita' order by o.sort`,
      [venueId],
    );
    expect(marg.rows).toEqual([
      { grp: "Flavor", required: true, name: "Classic", price_delta_cents: 0, is_default: true },
      {
        grp: "Flavor",
        required: true,
        name: "Strawberry",
        price_delta_cents: 200,
        is_default: false,
      },
    ]);
    // As after an Admin save: menu.changed goes out and the menu PDF is queued to render again.
    const pdf = await owner.query(
      "select count(*)::int as n from jobs where venue_id = $1 and kind = 'menu.pdf' and status = 'queued'",
      [venueId],
    );
    expect(pdf.rows[0].n).toBe(1);
  });

  it("every alcohol item carries the flag, and every item has a tax category", async () => {
    const r = await owner.query<{ name: string; alcohol: boolean; tax_category: string }>(
      `select i.name, i.alcohol, c.tax_category from menu_items i join menu_categories c on c.id = i.category_id
        where i.venue_id = $1 and i.name like 'Test %' order by i.name`,
      [venueId],
    );
    expect(r.rows).toEqual([
      { name: "Test Cola", alcohol: false, tax_category: "drink" },
      { name: "Test Fries", alcohol: false, tax_category: "food" },
      { name: "Test Lager", alcohol: true, tax_category: "drink" },
      { name: "Test Margarita", alcohol: true, tax_category: "drink" },
    ]);
  });

  it("the menu page, the PDF and the room page show the same items and prices", async () => {
    // The menu page and the room page both read the public menu; the PDF prints menuHtml of the same list.
    const page = await api.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/menu" });
    expect(page.statusCode, page.body).toBe(200);
    const menu = page.json() as {
      categories: {
        name: string;
        items: { name: string; variants: { name: string; price_cents: number }[] }[];
      }[];
      packages: { name: string; price_cents: number; hourly: boolean }[];
    };
    const html = menuHtml("West 4", menu.categories as never, menu.packages);
    const imported = menu.categories
      .flatMap((c) => c.items)
      .filter((i) => i.name.startsWith("Test "));
    expect(imported.map((i) => i.name).sort()).toEqual([
      "Test Cola",
      "Test Fries",
      "Test Lager",
      "Test Margarita",
    ]);
    const lager = imported.find((i) => i.name === "Test Lager")!;
    expect(lager.variants.map((v) => [v.name, v.price_cents])).toEqual([
      ["Pint", 800],
      ["Pitcher", 2400],
    ]);
    for (const item of imported) {
      expect(html).toContain(item.name);
      for (const v of item.variants) expect(html).toContain(dollars(v.price_cents));
    }
    expect(menu.packages).toContainEqual(
      expect.objectContaining({ name: "Test lager bucket", price_cents: 3500 }),
    );
    expect(html).toContain("Test lager bucket");
  });

  it("publishes a bar grid version from the next business date, each item's button in a fixed slot", async () => {
    expect(result.layout).toMatchObject({
      station: "bar",
      version: 2,
      starts_on: "2026-09-26",
      placed: 3,
      not_placed: [{ item: "Test Fries", why: "no bar grid section for its category" }],
    });
    const tonight = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/pos/layouts?station=bar`,
    });
    expect(tonight.json()).toMatchObject({
      tonight: { version: 1 },
      next: { version: 2, starts_on: "2026-09-26" },
    });
    const v1 = tonight.json().tonight.sections as Record<string, (string | null)[]>;
    clock.set(Temporal.ZonedDateTime.from("2026-09-26T20:00:00[America/New_York]").toInstant());
    const r = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/pos/layouts?station=bar`,
    });
    const v2 = r.json().tonight.sections as Record<string, (string | null)[]>;
    expect(r.json().tonight.version).toBe(2);
    // Nothing that was on the grid moved.
    for (const [section, slots] of Object.entries(v1))
      slots.forEach((id, i) => {
        if (id !== null) expect(v2[section]![i]).toBe(id);
      });
    const items = await owner.query<{ id: string; name: string; button_name: string }>(
      "select id, name, button_name from menu_items where venue_id = $1 and name like 'Test %'",
      [venueId],
    );
    const slotOf = (id: string) =>
      Object.entries(v2).flatMap(([s, slots]) => (slots.includes(id) ? [s] : []));
    const byName = Object.fromEntries(items.rows.map((i) => [i.name, i]));
    expect(slotOf(byName["Test Lager"]!.id)).toEqual(["beer"]);
    expect(slotOf(byName["Test Cola"]!.id)).toEqual(["soft"]);
    expect(slotOf(byName["Test Margarita"]!.id)).toEqual(["cocktails"]);
    expect(slotOf(byName["Test Fries"]!.id)).toEqual([]);
    expect(byName["Test Lager"]!.button_name).toBe("T Lager");
    clock.set(SEED_NOW);
  });

  it("running it again changes nothing and publishes no new grid", async () => {
    const again = await importMenu();
    expect(again.kinds.menu).toMatchObject({ loaded: 0, already: 5 });
    expect(again.layout).toBeNull();
    const versions = await owner.query(
      "select count(*)::int as n from pos_layouts where venue_id = $1 and station = 'bar'",
      [venueId],
    );
    expect(versions.rows[0].n).toBe(2);
  });
});
