import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { decide } from "../approvals/service.js";

/**
 * M6-15: fix a sent drink on a bar tab (spec 10 · Changing a sent drink; Money rules 7). Within the
 * reason-only limit a reason is enough; over it the line and the tab row read "Waiting for Andy" until
 * he decides on his own phone, and every screen hears about it (`check.updated`).
 */
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
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
const call = (method: "GET" | "POST", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
type TabView = {
  name: string;
  check_id: string;
  waiting_for: string | null;
  totals: { subtotal_cents: number; tax_cents: number; total_cents: number };
};
const tariq = async () =>
  ((await call("GET", "/tabs")).json().tabs as TabView[]).find((x) => x.name === "Tariq A.")!;
const lineOf = async (check: string, description: string) =>
  (await call("GET", `/checks/${ids[check]}`))
    .json()
    .lines.find(
      (l: { description: string; kind: string }) =>
        l.description === description && l.kind === "item",
    ) as { id: number; amount_cents: number };
const left = async () => (await call("GET", "/reason-only")).json().left_cents as number;
const checkEvents = async (checkId: string) =>
  Number(
    (
      await owner.query<{ n: string }>(
        "select count(*) as n from venue_events where type = 'check.updated' and entity_id = $1",
        [checkId],
      )
    ).rows[0]!.n,
  );
let andyPhone = "";
const andyDecides = (approvalId: string, decision: "approve" | "decline") =>
  withVenue(pool, { venueId }, (c) =>
    decide(c, venueId, approvalId, {
      decision,
      userId: ids["andy"]!,
      deviceId: andyPhone,
      at: clock.now(),
    }),
  );
const pendingApproval = async () =>
  (
    await owner.query<{ id: string }>(
      "select id from approvals where status = 'pending' and kind = 'void' and target_id = $1",
      [ids["chk_t5"]],
    )
  ).rows[0]?.id;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  pool = appPool(db.url);
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
  andyPhone = (
    await owner.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, user_id) values ($1, 'staff_phone', 'Andy''s phone', $2) returning id",
      [venueId, ids["andy"]],
    )
  ).rows[0]!.id;
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
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("fixing a sent drink on a bar tab", () => {
  it("Diego's seeded void of the Large bucket reads Waiting for Andy on the line and the tab row", async () => {
    as("maya", "bartender");
    const tab = await tariq();
    expect(tab.waiting_for).toMatch(/^Andy/);
    expect(tab.totals.total_cents).toBe(8601);
    const bucket = await lineOf("chk_t5", "Large bucket · 10 beers");
    const view = (await call("GET", `/checks/${ids["chk_t5"]}`)).json();
    expect(view.pending_fixes).toEqual([
      { line_id: bucket.id, kind: "void", waiting_for: expect.stringMatching(/^Andy/) },
    ]);
  });

  it("Andy declines it: nothing changes on the tab, the badge goes, and every screen hears", async () => {
    const before = await checkEvents(ids["chk_t5"]!);
    await andyDecides((await pendingApproval())!, "decline");
    as("maya", "bartender");
    const tab = await tariq();
    expect(tab.waiting_for).toBeNull();
    expect(tab.totals.total_cents).toBe(8601);
    expect(await checkEvents(ids["chk_t5"]!)).toBe(before + 1);
  });

  it("Diego asks again from the bar POS: $70.00 is over $25, so it waits for Andy and the tab row says so", async () => {
    as("diego", "front_desk");
    expect(await left()).toBe(7500);
    const before = await checkEvents(ids["chk_t5"]!);
    const bucket = await lineOf("chk_t5", "Large bucket · 10 beers");
    const r = await call("POST", `/checks/${ids["chk_t5"]}/lines/${bucket.id}/void`, {
      reason: "rang it wrong",
      made: false,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: expect.stringMatching(/^Andy/) },
    });
    expect(await checkEvents(ids["chk_t5"]!)).toBe(before + 1);
    expect((await tariq()).waiting_for).toMatch(/^Andy/);
    // Asking twice for the same line asks nothing new while it waits.
    const again = await call("POST", `/checks/${ids["chk_t5"]}/lines/${bucket.id}/void`, {
      reason: "rang it wrong",
      made: false,
    });
    expect(again.statusCode).toBe(202);
    expect(again.json().error.code).toBe("approval_pending");
    expect(
      (
        await owner.query(
          "select 1 from approvals where status = 'pending' and kind = 'void' and target_id = $1",
          [ids["chk_t5"]],
        )
      ).rowCount,
    ).toBe(1);
  });

  it("once Andy approves, Tariq A.'s tab reads $9.00 of drinks, $0.80 tax and $9.80 (bar_tab_t5_after_void_approved)", async () => {
    await andyDecides((await pendingApproval())!, "approve");
    as("diego", "front_desk");
    const tab = await tariq();
    expect(tab.waiting_for).toBeNull();
    expect(tab.totals).toMatchObject({ subtotal_cents: 900, tax_cents: 80, total_cents: 980 });
    // An approved fix doesn't count against Diego's reason-only limit.
    expect(await left()).toBe(7500);
  });

  it("Maya voids Jess P.'s Jäger Bomb with a reason alone: $63 left before, $51 after", async () => {
    as("maya", "bartender");
    expect(await left()).toBe(6300);
    const jager = await lineOf("chk_t1", "Jäger Bomb");
    const r = await call("POST", `/checks/${ids["chk_t1"]}/lines/${jager.id}/void`, {
      reason: "Rang it wrong",
      made: false,
    });
    expect(r.statusCode).toBe(201);
    expect(await left()).toBe(5100);
    const jess = ((await call("GET", "/tabs")).json().tabs as TabView[]).find(
      (x) => x.name === "Jess P.",
    )!;
    expect(jess.totals).toMatchObject({ subtotal_cents: 1800, tax_cents: 160, total_cents: 1960 });
  });
});
