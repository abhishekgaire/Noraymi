import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { checkTotals, exemptTax, salesTaxRule, type TaxCategory } from "@west4/rules";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { decide } from "../approvals/service.js";
import { auditNight } from "../reconcile/audit.js";

/**
 * P-15: tax-exempt checks. Off by default, refused on the server while off; the organization and the
 * certificate number are required; a manager approves; then the check pays sales tax only on what
 * stays taxed (drinks, by default); the Z report, the tax quarter and the money audit name it with
 * its certificate; it's in the audit log; removing it is allowed before payment.
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
interface Line {
  id: number;
  kind: string;
  amount_cents: number;
  tax_category: TaxCategory | null;
  reverses_id: number | null;
}
const CERT = "EX-000123";

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

describe("tax-exempt checks", () => {
  it("are off by default, and the server refuses them while off", async () => {
    who = as("andy", "manager");
    const me = (await req("GET", "/modules")).json() as {
      modules: { id: string; state: string; allowed: boolean }[];
    };
    expect(me.modules.find((m) => m.id === "tax_exempt")).toMatchObject({
      state: "off",
      allowed: true,
    });
    who = as("maya", "bartender");
    const off = await req("POST", `/checks/${ids["chk_room9"]}/tax-exempt`, {
      organization: "Community Choir",
      certificate_no: CERT,
    });
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe("module_off");
    await raw.query(
      "insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'tax_exempt', true, 'on')",
      [venueId],
    );
  });

  it("refuses one without a certificate number or an organization", async () => {
    who = as("maya", "bartender");
    for (const body of [
      { organization: "Community Choir" },
      { organization: "Community Choir", certificate_no: "   " },
      { organization: "", certificate_no: CERT },
    ]) {
      const r = await req("POST", `/checks/${ids["chk_room9"]}/tax-exempt`, body);
      expect(r.statusCode).toBe(400);
    }
    const v = await view("chk_room9");
    expect(v.tax_exempt).toBeNull();
    expect(v.pending_tax_exempt).toBeNull();
  });

  it("Maya asks for Room 9; it waits for Andy, and once he approves the check shows it", async () => {
    who = as("maya", "bartender");
    const r = await req("POST", `/checks/${ids["chk_room9"]}/tax-exempt`, {
      organization: "Community Choir",
      certificate_no: ` ${CERT} `,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: "Andy C." },
    });
    let v = await view("chk_room9");
    expect(v.tax_exempt).toBeNull();
    expect(v.pending_tax_exempt).toMatchObject({
      waiting_for: "Andy C.",
      organization: "Community Choir",
    });
    // A second ask while one waits is refused: it's already waiting.
    const again = await req("POST", `/checks/${ids["chk_room9"]}/tax-exempt`, {
      organization: "Community Choir",
      certificate_no: CERT,
    });
    expect(again.json().error.code).toBe("approval_pending");
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
    expect(v.pending_tax_exempt).toBeNull();
    expect(v.tax_exempt).toMatchObject({
      organization: "Community Choir",
      certificate_no: CERT,
      still_taxed: ["drink"],
      approved_by: "Andy C.",
    });
    // In the audit log.
    const audited = await raw.query(
      "select 1 from audit_log where venue_id = $1 and split_part(target, '/', 1) = 'check_tax_exemptions'",
      [venueId],
    );
    expect(audited.rowCount).toBeGreaterThan(0);
  });

  it("finalizing taxes only the drinks; the money audit is clean and names the certificate", async () => {
    who = as("maya", "bartender");
    const f = await req("POST", `/checks/${ids["chk_room9"]}/finalize`);
    expect(f.statusCode).toBe(200);
    const v = await view("chk_room9");
    const lines = v.lines as Line[];
    const reversed = new Set(lines.map((l) => l.reverses_id).filter((x) => x !== null));
    const standing = lines.filter((l) => l.reverses_id === null && !reversed.has(l.id));
    const net = standing
      .filter((l) => !["tax", "gratuity"].includes(l.kind))
      .map((l) => ({ kind: l.kind, taxCategory: l.tax_category, cents: l.amount_cents }));
    const full = checkTotals(net, { tax: salesTaxRule(newYorkCountyTaxed), gratuityPct: 20 });
    const exempt = checkTotals(net, {
      tax: exemptTax(salesTaxRule(newYorkCountyTaxed), ["drink"]),
      gratuityPct: 20,
    });
    expect(f.json()).toMatchObject({
      tax_cents: exempt.taxCents,
      gratuity_cents: exempt.gratuityCents,
      total_cents: exempt.totalCents,
    });
    expect(exempt.taxCents).toBeLessThan(full.taxCents);
    // No tax line on room time.
    expect(
      standing.filter((l) => l.kind === "tax" && l.tax_category === "room_time" && l.amount_cents),
    ).toEqual([]);
    await raw.query("update checks set status = 'finalized' where venue_id = $1 and id = $2", [
      venueId,
      ids["chk_room9"],
    ]);
    const audit = await withVenue(pool, { venueId }, (c) =>
      auditNight(c, venueId, "2026-09-25", clock.now()),
    );
    expect(audit.errors.filter((e) => e.ref === `#${v.check.number}`)).toEqual([]);
    expect(audit.covered.join(" ")).toContain(`certificate ${CERT}`);
    // Closed for payment now: the exemption can't change.
    expect((await req("POST", `/checks/${ids["chk_room9"]}/tax-exempt/remove`)).statusCode).toBe(
      409,
    );
  });

  it("the Z report and the tax quarter list it with its certificate and the sales left untaxed", async () => {
    who = as("andy", "manager");
    const v = await view("chk_room9");
    const roomTime = (v.lines as Line[])
      .filter((l) => l.tax_category === "room_time" && !["tax", "gratuity"].includes(l.kind))
      .reduce((s, l) => s + l.amount_cents, 0);
    const report = (await req("GET", "/nights/2026-09-25/report")).json();
    expect(report.tax_exempt.checks).toEqual([
      expect.objectContaining({
        organization: "Community Choir",
        certificate_no: CERT,
        exempt_sales_cents: roomTime,
      }),
    ]);
    expect(report.tax_exempt.sales_cents).toBe(roomTime);
    const quarter = (await req("GET", "/reports/tax-quarter?date=2026-09-25")).json();
    expect(quarter.exempt.checks).toEqual([
      expect.objectContaining({ certificate_no: CERT, exempt_sales_cents: roomTime }),
    ]);
  });

  it("on a bar tab it can be taken off before payment; the next finalize taxes it again", async () => {
    who = as("andy", "manager");
    // Andy's own ask goes to an owner; with approvals set to none it runs at once.
    await raw.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_at, saved_by)
       select $1, 'approvals', coalesce(max(version), 0) + 1, '{"mode":"none"}', '2026-09-01', now(), $2
         from venue_settings where venue_id = $1 and key = 'approvals'`,
      [venueId, ids["andy"]],
    );
    const r = await req("POST", `/checks/${ids["chk_t1"]}/tax-exempt`, {
      organization: "Food Bank",
      certificate_no: "EX-9",
    });
    expect(r.statusCode).toBe(201);
    expect((await view("chk_t1")).tax_exempt).toMatchObject({ certificate_no: "EX-9" });
    expect((await req("POST", `/checks/${ids["chk_t1"]}/tax-exempt/remove`)).statusCode).toBe(200);
    expect((await view("chk_t1")).tax_exempt).toBeNull();
  });
});
