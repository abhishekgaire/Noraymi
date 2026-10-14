import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { checkDiscount, checkTotals, salesTaxRule, type TaxCategory } from "@west4/rules";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { decide } from "../approvals/service.js";
import { auditNight } from "../reconcile/audit.js";
import { receiptModel } from "../receipts/model.js";

/**
 * P-02: a % or $ discount on a whole check. Within the reason-only limit it goes on at once; over it,
 * it waits for approval; each finalize writes its `discount` lines by category, the gratuity on
 * what's left; the money audit works it out again; removing it is allowed before payment; the
 * switch off refuses the route.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let who: Principal;
const as = (slug: string, role: string): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: role === "manager" || role === "owner" ? "passkey" : "pin",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});
const req = (method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const view = async (check: string) => (await req("GET", `/checks/${ids[check]}`)).json();
const left = async () => (await req("GET", "/reason-only")).json().left_cents as number;
interface Line {
  id: number;
  kind: string;
  description: string;
  amount_cents: number;
  tax_category: TaxCategory | null;
  reverses_id: number | null;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  const owner = new pg.Pool({ connectionString: db.url });
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  await owner.end();
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  who = as("maya", "bartender");
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
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("a discount on a whole check", () => {
  it("is on by default on every plan (the switch reads as Payments & checks)", async () => {
    who = as("andy", "manager");
    const me = (await req("GET", "/modules")).json() as {
      modules: { id: string; state: string; allowed: boolean }[];
    };
    expect(me.modules.find((m) => m.id === "check_discount")).toMatchObject({
      state: "on",
      allowed: true,
    });
  });

  it("refuses a bad body: no reason, a percent over 100, an amount of $0.00", async () => {
    who = as("maya", "bartender");
    for (const body of [
      { mode: "pct", pct: 10 },
      { mode: "pct", pct: 120, reason: "x" },
      { mode: "amount", amount_cents: 0, reason: "x" },
    ])
      expect((await req("POST", `/checks/${ids["chk_t1"]}/discount`, body)).statusCode).toBe(400);
  });

  it("Maya takes $3.00 off Jess P.'s tab with a reason: no approval, the tax follows, and her limit counts it", async () => {
    who = as("maya", "bartender");
    const before = await view("chk_t1");
    const leftBefore = await left();
    const r = await req("POST", `/checks/${ids["chk_t1"]}/discount`, {
      mode: "amount",
      amount_cents: 300,
      reason: "Regular guest",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: "added", discount_cents: 300 });
    const after = await view("chk_t1");
    expect(after.discount).toMatchObject({ mode: "amount", amount_cents: 300, cents: 300 });
    expect(after.totals.discount_cents).toBe(300);
    expect(after.totals.subtotal_cents).toBe(before.totals.subtotal_cents - 300);
    // Tax on the discounted drinks, half up (no gratuity on a bar tab at West 4).
    const tax = salesTaxRule(newYorkCountyTaxed);
    const worked = checkTotals(
      [{ kind: "item", taxCategory: "drink", cents: after.totals.subtotal_cents }],
      { tax, gratuityPct: null },
    );
    expect(after.totals.tax_cents).toBe(worked.taxCents);
    expect(await left()).toBe(leftBefore - 300);
    // One stands at a time.
    const again = await req("POST", `/checks/${ids["chk_t1"]}/discount`, {
      mode: "pct",
      pct: 5,
      reason: "x",
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details).toMatchObject({ reason: "discount_standing" });
  });

  it("removing it before payment gives the limit back and the check its price", async () => {
    who = as("maya", "bartender");
    const leftBefore = await left();
    expect((await req("POST", `/checks/${ids["chk_t1"]}/discount/remove`)).statusCode).toBe(200);
    const v = await view("chk_t1");
    expect(v.discount).toBeNull();
    expect(v.totals.discount_cents).toBe(0);
    expect(await left()).toBe(leftBefore + 300);
    const audit = await raw.query(
      "select 1 from audit_log where action like 'check_discounts.%' and venue_id = $1",
      [venueId],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(2);
  });

  it("10% off Room 9 is over $25: it waits for Andy, and goes on only once he approves", async () => {
    who = as("maya", "bartender");
    const r = await req("POST", `/checks/${ids["chk_room9"]}/discount`, {
      mode: "pct",
      pct: 10,
      reason: "Slow service",
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: "Andy C." },
    });
    let v = await view("chk_room9");
    expect(v.discount).toBeNull();
    expect(v.pending_discount).toMatchObject({ waiting_for: "Andy C." });
    expect(v.pending_discount.cents).toBeGreaterThan(2500);
    const phone = await raw.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, user_id) values ($1, 'staff_phone', 'Andy''s phone', $2) returning id",
      [venueId, ids["andy"]],
    );
    await withVenue(pool, { venueId }, (c) =>
      decide(c, venueId, r.json().approval_id, {
        decision: "approve",
        userId: ids["andy"]!,
        deviceId: phone.rows[0]!.id,
        at: clock.now(),
      }),
    );
    v = await view("chk_room9");
    expect(v.pending_discount).toBeNull();
    expect(v.discount).toMatchObject({ mode: "pct", pct: "10", approved_by: "Andy C." });
  });

  it("finalizing writes the discount by category; tax and the gratuity are on what's left; the audit is clean", async () => {
    who = as("maya", "bartender");
    const f = await req("POST", `/checks/${ids["chk_room9"]}/finalize`);
    expect(f.statusCode).toBe(200);
    const v = await view("chk_room9");
    const lines = v.lines as Line[];
    const reversed = new Set(lines.map((l) => l.reverses_id).filter((x) => x !== null));
    const standing = lines.filter((l) => l.reverses_id === null && !reversed.has(l.id));
    const net = standing
      .filter((l) => !["tax", "gratuity", "discount"].includes(l.kind))
      .map((l) => ({ kind: l.kind, taxCategory: l.tax_category, cents: l.amount_cents }));
    const d = checkDiscount(net, { mode: "pct", pct: "10" });
    const discountLines = standing.filter((l) => l.kind === "discount");
    expect(discountLines.length).toBeGreaterThanOrEqual(2);
    for (const l of discountLines) {
      expect(l.description).toMatch(/^Discount 10% · /);
      expect(-l.amount_cents).toBe(d.byCategoryCents[l.tax_category!]);
    }
    const t = checkTotals(
      [
        ...net,
        ...discountLines.map((l) => ({
          kind: l.kind,
          taxCategory: l.tax_category,
          cents: l.amount_cents,
        })),
      ],
      { tax: salesTaxRule(newYorkCountyTaxed), gratuityPct: 20 },
    );
    expect(f.json()).toMatchObject({
      subtotal_cents: t.subtotalCents,
      tax_cents: t.taxCents,
      gratuity_cents: t.gratuityCents,
      total_cents: t.totalCents,
    });
    // The gratuity is 20% of what's left after the discount.
    expect(t.gratuityBaseCents).toBe(d.baseCents - d.discountCents);
    // A second finalize with nothing changed writes no new discount lines.
    await req("POST", `/checks/${ids["chk_room9"]}/finalize`);
    const again = (await view("chk_room9")).lines as Line[];
    expect(again.filter((l) => l.kind === "discount").length).toBe(
      lines.filter((l) => l.kind === "discount").length,
    );
    // The receipt prints it as one line.
    const receipt = await withVenue(pool, { venueId }, (c) =>
      receiptModel(c, venueId, ids["chk_room9"]!),
    );
    expect(receipt!.lines).toEqual(
      expect.arrayContaining([{ label: "Discount · 10%", amount_cents: -d.discountCents }]),
    );
    // The money audit, on the check as finalized: clean, and a cent moved is caught.
    await raw.query("update checks set status = 'finalized' where venue_id = $1 and id = $2", [
      venueId,
      ids["chk_room9"],
    ]);
    const number = v.check.number as number;
    const audit = await withVenue(pool, { venueId }, (c) =>
      auditNight(c, venueId, "2026-09-25", clock.now()),
    );
    expect(audit.errors.filter((e) => e.ref === `#${number}`)).toEqual([]);
    // Closed for payment now: the discount can't change.
    const closed = await req("POST", `/checks/${ids["chk_room9"]}/discount/remove`);
    expect(closed.statusCode).toBe(409);
  });

  it("the exceptions list shows it, with who gave and who approved it", async () => {
    who = as("andy", "manager");
    const r = await req("GET", "/reports/exceptions?date=2026-09-25");
    expect(r.statusCode).toBe(200);
    expect(r.json().exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "discount",
          what: "Discount 10%",
          why: "Slow service",
          approved_by: "Andy C.",
        }),
      ]),
    );
  });

  it("with the switch off the route is refused; a standing discount can still be taken off", async () => {
    who = as("maya", "bartender");
    expect(
      (
        await req("POST", `/checks/${ids["chk_t2"]}/discount`, {
          mode: "pct",
          pct: 5,
          reason: "Regular guest",
        })
      ).statusCode,
    ).toBe(201);
    await raw.query(
      "insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'check_discount', true, 'off')",
      [venueId],
    );
    const off = await req("POST", `/checks/${ids["chk_t1"]}/discount`, {
      mode: "pct",
      pct: 5,
      reason: "Regular guest",
    });
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe("module_off");
    expect((await req("POST", `/checks/${ids["chk_t2"]}/discount/remove`)).statusCode).toBe(200);
    await raw.query(
      "delete from venue_modules where venue_id = $1 and module_id = 'check_discount'",
      [venueId],
    );
  });
});
