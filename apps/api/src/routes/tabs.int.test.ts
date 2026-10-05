import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  newYorkCounty,
  newYorkCountyTaxed,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** Bar tabs on the bar POS (M6-02, M6-03): the list, "1 not sent", and Repeat round. */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const clock = new SimulatedClock(SEED_NOW);
const as = (slug: string, role: string) => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "POST" | "PUT", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
type TabView = {
  id: string;
  check_id: string;
  name: string;
  unsent: number;
  waiting_for: string | null;
  cut_off: unknown;
  totals: { total_cents: number };
};
const tabNamed = async (name: string) =>
  ((await call("GET", "/tabs")).json().tabs as TabView[]).find((x) => x.name === name)!;

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

describe("the bar tabs list", () => {
  it("lists the five tabs in the order opened, with the seed's totals and badges", async () => {
    as("maya", "bartender");
    const tabs = (await call("GET", "/tabs")).json().tabs as TabView[];
    expect(tabs.map((x) => x.name)).toEqual([
      "Hana K.",
      "Jess P.",
      "Luis M.",
      "Tariq A.",
      "Seat 6 · blue jacket",
    ]);
    expect(tabs.map((x) => x.totals.total_cents)).toEqual([4355, 3266, 6315, 8601, 1307]);
    expect(tabs[0]!.cut_off).toMatchObject({ by: "Andy" });
    expect(tabs[3]!.waiting_for).toMatch(/^Andy/);
  });

  it("Maya sees Diego's unsent Red Bull as “1 not sent” on Tariq A.'s row; Diego sees his own in the round", async () => {
    as("maya", "bartender");
    expect((await tabNamed("Tariq A.")).unsent).toBe(1);
    as("diego", "staff");
    expect((await tabNamed("Tariq A.")).unsent).toBe(0);
    const tariq = await tabNamed("Tariq A.");
    const draft = (await call("GET", `/drafts/${tariq.check_id}`)).json();
    expect(draft.lines).toHaveLength(1);
    // Unsent drinks aren't on the check.
    const check = (await call("GET", `/checks/${tariq.check_id}`)).json();
    expect(check.lines.map((l: { description: string }) => l.description)).not.toContain(
      "Red Bull",
    );
  });
});

describe("Repeat round", () => {
  it("copies Jess P.'s last round into Maya's unsent drinks; Send puts it on the tab", async () => {
    as("maya", "bartender");
    const jess = await tabNamed("Jess P.");
    const r = await call("POST", `/tabs/${jess.id}/repeat-round`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ added: 2, left_out: [] });
    const lines = r.json().lines as { variant_id: string; qty: number }[];
    expect(lines.map((l) => l.qty).sort()).toEqual([1, 2]);
    const sent = await call("POST", `/checks/${jess.check_id}/orders`, {
      client_order_id: "repeat-jess-1",
      lines,
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await tabNamed("Jess P.")).totals.total_cents).toBe(6533); // $60.00 + tax once on the tab, $5.33
    // The next repeat comes from that order.
    expect((await call("POST", `/tabs/${jess.id}/repeat-round`)).json()).toMatchObject({
      added: 2,
    });
  });

  it("leaves out a Hoegaarden that's 86'd tonight and says so", async () => {
    as("maya", "bartender");
    const luis = await tabNamed("Luis M.");
    const hoe = ids["menu_hoe_regular"]!;
    const modelo = ids["menu_modelo_regular"]!;
    await call("POST", `/checks/${luis.check_id}/orders`, {
      client_order_id: "luis-hoe-round",
      lines: [{ variant_id: modelo, qty: 1 }],
    });
    // Hoegaarden's in the last round as sent earlier tonight, before it ran out.
    await owner.query(
      `insert into order_items (venue_id, order_id, variant_id, item_id, qty, unit_cents, name_snapshot, alcohol, sort)
       select o.venue_id, o.id, $1::uuid, $2::uuid, 1, 900, 'Hoegaarden', true, 1
         from orders o where o.client_order_id = 'luis-hoe-round'`,
      [hoe, ids["menu_hoe"]],
    );
    const r = (await call("POST", `/tabs/${luis.id}/repeat-round`)).json();
    expect(r.left_out).toEqual([{ name: "Hoegaarden", reason: "out" }]);
    expect(r.added).toBe(1);
  });

  it("leaves out alcohol on a cut-off tab, and after 4 AM", async () => {
    as("maya", "bartender");
    const hana = await tabNamed("Hana K.");
    const cut = (await call("POST", `/tabs/${hana.id}/repeat-round`)).json();
    expect(cut.left_out.map((x: { reason: string }) => x.reason)).toEqual(["cut_off", "cut_off"]);
    clock.set(Temporal.Instant.from("2026-09-26T04:02:00-04:00"));
    const jess = await tabNamed("Jess P.");
    const late = (await call("POST", `/tabs/${jess.id}/repeat-round`)).json();
    expect(late.left_out.every((x: { reason: string }) => x.reason === "window_closed")).toBe(true);
    clock.set(SEED_NOW);
  });
});
