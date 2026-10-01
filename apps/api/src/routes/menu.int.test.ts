import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M3-03 acceptance on the demo seed: the menu, 86 and the promotion checks on save. */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let who: Principal;
const as = (slug: string, role: string, session: "passkey" | "pin" = "pin"): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session,
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});
const req = (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: path.startsWith("/v1/") ? path : `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

interface Item {
  id: string;
  name: string;
  out_tonight: boolean;
  variants: { id: string; name: string; price_cents: number; out_tonight: boolean }[];
  groups: {
    name: string;
    required: boolean;
    options: { name: string; is_default: boolean; price_delta_cents: number }[];
  }[];
}
type Tree = { categories: { name: string; items: Item[] }[] };
const items = (t: Tree) => t.categories.flatMap((c) => c.items);
const named = (t: Tree, name: string) => items(t).find((i) => i.name === name)!;
const staffMenu = async () => (await req("GET", "/menu")).json<Tree>();
const guestMenu = async () =>
  (await req("GET", "/v1/public/venues/west4karaoke/menu")).json<Tree>();

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  await publishRulePack(raw, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  // A runner, who may carry drinks but not 86 them.
  const runner = await raw.query<{ id: string }>(
    "insert into users (name, email) values ('Rae Runner', 'rae@example.test') returning id",
  );
  const m = await raw.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status) values ($1, $2, 'staff', 'active') returning id",
    [venueId, runner.rows[0]!.id],
  );
  ids["rae"] = runner.rows[0]!.id;
  ids["rae.membership"] = m.rows[0]!.id;
  who = as("abhishek", "owner", "passkey");
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => who],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("the seed's menu", () => {
  it("loads 127 lines in 9 sections; a Margarita asks its flavor, Tito's defaults to Rocks", async () => {
    const t = await staffMenu();
    expect(t.categories.map((c) => c.name)).toEqual([
      "Beer",
      "Soju",
      "Cocktails",
      "Shots",
      "Spirits",
      "Wine",
      "Soft drinks",
      "Bottles",
      "Buckets",
    ]);
    expect(items(t)).toHaveLength(127);
    const marg = named(t, "Margarita");
    expect(marg.variants[0]!.price_cents).toBe(1300);
    expect(marg.groups[0]).toMatchObject({ name: "Flavor", required: true });
    expect(marg.groups[0]!.options.map((o) => o.name)).toEqual([
      "Raspberry",
      "Peach",
      "Strawberry",
    ]);
    const titos = items(t).find((i) => i.name.startsWith("Tito"))!;
    const how = titos.groups.find((g) => g.name === "How")!;
    expect(how.options.find((o) => o.is_default)?.name).toBe("Rocks");
    const mixer = titos.groups.find((g) => g.name === "Mixer")!;
    expect(mixer.options.find((o) => o.name === "Red Bull")?.price_delta_cents).toBe(600);
  });

  it("shows Hoegaarden, Casamigos Blanco and Casamigos · bottle 86'd in place, staff and guest", async () => {
    for (const t of [await staffMenu(), await guestMenu()]) {
      const out = items(t)
        .filter((i) => i.out_tonight)
        .map((i) => i.name);
      expect(out.sort()).toEqual(["Casamigos Blanco", "Casamigos · bottle", "Hoegaarden"]);
      expect(items(t)).toHaveLength(127);
    }
  });
});

describe("86", () => {
  it("86'ing Bud Light greys it everywhere at once, and tapping again brings it back", async () => {
    who = as("maya", "bartender");
    const bud = named(await staffMenu(), "Bud Light");
    const before = Number(
      (await raw.query("select count(*) from venue_events where type = 'menu.changed'")).rows[0]
        .count,
    );
    const r = await req("POST", `/menu/items/${bud.id}/out-tonight`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ out_tonight: true });
    expect(Temporal.Instant.from(r.json().out_until).toString()).toBe(
      Temporal.Instant.from("2026-09-26T06:00:00-04:00").toString(),
    );
    expect(named(await staffMenu(), "Bud Light").out_tonight).toBe(true);
    expect(named(await guestMenu(), "Bud Light").out_tonight).toBe(true);
    const after = Number(
      (await raw.query("select count(*) from venue_events where type = 'menu.changed'")).rows[0]
        .count,
    );
    expect(after).toBe(before + 1);
    expect(
      (await req("POST", `/menu/items/${bud.id}/out-tonight`, { out: false })).statusCode,
    ).toBe(200);
    expect(named(await staffMenu(), "Bud Light").out_tonight).toBe(false);
  });

  it("comes back on its own at 6:00 AM", async () => {
    who = as("diego", "front_desk");
    const bud = named(await staffMenu(), "Bud Light");
    await req("POST", `/menu/items/${bud.id}/out-tonight`, {});
    const nowBefore = clock.now();
    clock.set(Temporal.Instant.from("2026-09-26T06:00:00-04:00"));
    try {
      expect(named(await staffMenu(), "Bud Light").out_tonight).toBe(false);
    } finally {
      clock.set(nowBefore);
    }
    expect(named(await staffMenu(), "Bud Light").out_tonight).toBe(true);
    await req("POST", `/menu/items/${bud.id}/out-tonight`, { out: false });
  });

  it("86s one flavor or variant, not the whole item", async () => {
    who = as("maya", "bartender");
    const marg = named(await staffMenu(), "Margarita");
    const peach = await raw.query<{ id: string }>(
      "select id from menu_options where item_id = $1 and name = 'Peach'",
      [marg.id],
    );
    const r = await req("POST", `/menu/items/${marg.id}/out-tonight`, {
      option_id: peach.rows[0]!.id,
    });
    expect(r.statusCode).toBe(200);
    const after = named(await staffMenu(), "Margarita");
    expect(after.out_tonight).toBe(false);
    expect(
      after.groups[0]!.options.find((o) => o.name === "Peach") as unknown as {
        out_tonight: boolean;
      },
    ).toMatchObject({ out_tonight: true });
  });

  it("a runner's 86 answers 403", async () => {
    who = as("rae", "staff");
    const bud = named(await staffMenu(), "Bud Light");
    expect((await req("POST", `/menu/items/${bud.id}/out-tonight`, {})).statusCode).toBe(403);
  });
});

describe("saving runs the promotion checks", () => {
  it("refuses an open bar with no fixed quantity, saving nothing, and gives the reason", async () => {
    who = as("abhishek", "owner", "passkey");
    const marg = named(await staffMenu(), "Margarita");
    const r = await req("POST", "/packages", {
      name: "Open bar · 2 hours",
      price_cents: 6000,
      contents: [{ item_id: marg.id, qty: null }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/fixed quantity/);
    expect(r.json().error.details.refusals[0].code).toBe("alcohol_quantity_not_fixed");
    expect((await req("GET", "/packages")).json().items).toHaveLength(0);
  });

  it("saves a package that passes, stamped with the pack version, and sends menu.changed", async () => {
    const marg = named(await staffMenu(), "Margarita");
    const r = await req("POST", "/packages", {
      name: "Birthday · 2 hours",
      price_cents: 6000,
      contents: [{ item_id: marg.id, qty: 2 }],
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      checked_pack_version: "2026.09",
      private_function_only: false,
    });
    const p = await req("PATCH", `/packages/${r.json().id}`, { private_function_only: true });
    expect(p.statusCode).toBe(400);
    expect(p.json().error.details.refusals[0].code).toBe("private_function_not_cleared");
  });

  it("refuses a $6.00 Margarita happy hour and saves $6.50; refuses an hourly price with drinks", async () => {
    const marg = named(await staffMenu(), "Margarita");
    const rule = (price_cents: number, kind = "happy_hour") =>
      req("POST", "/price-rules", {
        name: "Happy hour",
        kind,
        days: [1, 2, 3, 4],
        from_min: 960,
        to_min: 1140,
        target: { item_ids: [marg.id] },
        price_cents,
      });
    const low = await rule(600);
    expect(low.statusCode).toBe(400);
    expect(low.json().error.message).toMatch(/\$6\.50/);
    expect((await rule(650)).statusCode).toBe(201);
    expect((await rule(1000, "hourly")).json().error.details.refusals[0].code).toBe(
      "hourly_includes_alcohol",
    );
  });

  it("refuses an alcohol variant at $0.00", async () => {
    const bud = named(await staffMenu(), "Bud Light");
    const r = await req("POST", "/menu/variants", {
      item_id: bud.id,
      name: "Free",
      price_cents: 0,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.refusals[0].code).toBe("free_alcohol");
  });

  it("adds a category, an item and its variant", async () => {
    const cat = await req("POST", "/menu/categories", { name: "Snacks", sort: 20 });
    expect(cat.statusCode).toBe(201);
    const item = await req("POST", "/menu/items", {
      category_id: cat.json().id,
      name: "Popcorn",
      button_name: "Popcorn",
    });
    expect(item.statusCode).toBe(201);
    expect(item.json()).toMatchObject({ alcohol: false, out_tonight: false });
    const v = await req("POST", "/menu/variants", {
      item_id: item.json().id,
      name: "Regular",
      price_cents: 600,
    });
    expect(v.statusCode).toBe(201);
    expect(named(await staffMenu(), "Popcorn").variants[0]!.price_cents).toBe(600);
  });

  it("a PIN session can't edit the menu", async () => {
    who = as("andy", "manager");
    expect((await req("POST", "/menu/categories", { name: "Nope" })).statusCode).toBe(403);
  });
});
