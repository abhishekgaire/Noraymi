import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  FrozenClock,
  SEED_NOW,
  Temporal,
  newYorkCounty,
  newYorkCountyFood,
  newYorkCountyTaxed,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { buildNightJournal } from "../nights/journal.js";
import { nightReport } from "../nights/report.js";
import { reconcileNight } from "./night.js";
import { MAYA_BAR, playNight, type NightClient } from "./runner.js";
import { loadConfig } from "../config.js";
import "../payments/webhooks.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * Food taxed and reported (K-10; spec 16 · Tax; Money rules 8 and 9). Rule pack 2026.10.1 taxes food
 * at the drinks rate (the cautious default while the accountant answers). The seed's Friday is played
 * to its close with test food added (TEST wings on Room 9's check, TEST French Fries on Jess P.'s
 * tab): food is taxed once per rate with the rest of the check, is in Room 9's gratuity base, shows
 * on its own line in the Z report and the journal, and the night still reconciles to the cent.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;
const food: Record<string, string> = {};

type Role = "owner" | "manager" | "bartender" | "front_desk";
interface Who {
  slug: string;
  role: Role;
  session: SessionKind;
  device: string;
  deviceKind: "bar_computer" | "front_desk" | "staff_phone";
}
let who: Who;
const as = (slug: string, role: Role, session: SessionKind, device: string) => {
  who = {
    slug,
    role,
    session,
    device,
    deviceKind: device.startsWith("dev_phone")
      ? "staff_phone"
      : device === "dev_bar_computer"
        ? "bar_computer"
        : "front_desk",
  };
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed, newYorkCountyFood])
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
  // The test kitchen menu (test prices): TEST wings $12.00 and TEST French Fries $5.00, Kitchen on.
  const one = async (sql: string, params: unknown[]) =>
    (await owner.query<{ id: string }>(sql, params)).rows[0]!.id;
  const cat = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Food', 900, 'food') returning id",
    [venueId],
  );
  for (const [name, cents] of [
    ["TEST wings", 1200],
    ["TEST French Fries", 500],
  ] as const) {
    const item = await one(
      "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, $3, 'kitchen') returning id",
      [venueId, cat, name],
    );
    food[name] = await one(
      "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', $3) returning id",
      [venueId, item, cents],
    );
  }
  await owner.query(
    "update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id = 'kitchen'",
    [venueId],
  );
  const memberships = Object.fromEntries(
    (
      await owner.query<{ user_id: string; id: string }>(
        "select user_id, id from memberships where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.user_id, r.id]),
  );
  as("andy", "manager", "passkey", "dev_phone_andy");
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest): Promise<Principal> => {
        const userId = ids[who.slug]!;
        const deviceId = ids[who.device]!;
        Object.assign(request, {
          session: {
            assurance: who.session,
            membershipId: memberships[userId],
            deviceId,
          },
          signedDevice: { deviceId, venueId, kind: who.deviceKind },
        });
        return {
          kind: "user",
          userId,
          session: who.session,
          memberships: [{ venueId, membershipId: memberships[userId]!, role: who.role }],
        };
      },
    ],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

const client: NightClient = {
  async call(actor, method, path, body) {
    as(actor.who, actor.role, actor.session, actor.device);
    const r = await api.inject({
      method,
      url: `/v1/venues/${venueId}${path}`,
      headers: { "idempotency-key": `run-${++n}` },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: r.statusCode, json: r.body ? (r.json() as Record<string, unknown>) : {} };
  },
  async setClock(iso) {
    clock.set(Temporal.Instant.from(iso));
  },
};

describe("a night with food (K-10)", () => {
  it("food is taxed, in the gratuity base, on its own line in the Z report and journal, and the night reconciles", async () => {
    // Staff ring food before the close: a staff order is accepted as it's placed.
    for (const [check, variant] of [
      [ids["chk_room9"]!, food["TEST wings"]!],
      [ids["chk_t1"]!, food["TEST French Fries"]!],
    ] as const) {
      const r = await client.call(MAYA_BAR, "POST", `/checks/${check}/orders`, {
        client_order_id: `food-night-${check}`,
        lines: [{ variant_id: variant, qty: 1 }],
      });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    const steps = await playNight(client, "2026-09-25");
    expect(steps.at(-1)).toEqual({ step: "close", status: 200 });
    const result = await withVenue(app, { venueId }, (c) =>
      reconcileNight(c, venueId, "2026-09-25", clock.now()),
    );
    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);

    // Room 9's last revision: one tax line per rate on the whole base, food included, and the
    // gratuity on a base that includes the wings.
    const rev = await owner.query<{
      tax_category: string | null;
      kind: string;
      amount: string;
      base: string | null;
      version: string | null;
    }>(
      `select l.tax_category, l.kind, l.amount_cents::text as amount, l.taxable_base_cents::text as base,
              l.rule_pack_version as version
         from check_lines l where l.check_id = $1 and l.kind in ('tax', 'gratuity')
          and l.revision = (select max(revision) from check_lines where check_id = $1)
          and l.reverses_id is null`,
      [ids["chk_room9"]],
    );
    const taxLines = rev.rows.filter((r) => r.kind === "tax");
    expect(taxLines.length).toBeGreaterThan(0);
    expect(taxLines.every((t) => t.version === newYorkCountyFood.version)).toBe(true);
    const items = await owner.query<{ tax_category: string; sum: string }>(
      `select tax_category, sum(amount_cents)::text as sum from live_check_lines
        where check_id = $1 and kind in ('room_time', 'item', 'song', 'comp', 'void') group by tax_category`,
      [ids["chk_room9"]],
    );
    const base = items.rows.reduce((s, r) => s + Number(r.sum), 0);
    expect(items.rows.find((r) => r.tax_category === "food")?.sum).toBe("1200");
    const taxBase = taxLines.reduce((s, t) => s + Number(t.base ?? 0), 0);
    expect(taxBase).toBe(base);
    const gratuity = rev.rows.find((r) => r.kind === "gratuity");
    // 20% half up of a base that includes the $12.00 wings.
    expect(Number(gratuity!.amount)).toBe(Math.floor((base * 20 + 50) / 100));

    // The Z report and the journal: food on its own line.
    const report = await withVenue(app, { venueId }, (c) =>
      nightReport(c, venueId, "2026-09-25", clock.now()),
    );
    expect(report.sales.food_cents).toBe(1200 + 500);
    const journal = await withVenue(app, { venueId }, (c) =>
      buildNightJournal(c, venueId, "2026-09-25", report),
    );
    const salesFood = journal.lines.find((l) => l.account === "sales_food");
    expect(salesFood).toMatchObject({ debit_cents: 0, credit_cents: 1700 });
  });
});
