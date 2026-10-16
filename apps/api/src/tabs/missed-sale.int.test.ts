import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { decide } from "../approvals/service.js";
import { reportPrintLines, type NightReport } from "../nights/report.js";

/**
 * P-19: a missed sale on tonight's date. Off by default and refused on the server while off; owners
 * and managers only; a bar tab opened tonight is marked "From the night of <date>" with a reason,
 * approved per the venue's setting; it counts on tonight's Z with its earlier date shown, a closed
 * night's totals don't change, and it's in the audit log.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const TONIGHT = "2026-09-25";
const EARLIER = "2026-09-24";
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
const report = async (date: string) =>
  (await req("GET", `/nights/${date}/report`)).json() as NightReport;
const mark = (check: string, body: object) =>
  req("POST", `/checks/${ids[check]}/missed-sale`, body);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  who = as("andy", "manager");
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

describe("a missed sale on tonight's date", () => {
  it("is off by default, and the server refuses it while off", async () => {
    who = as("andy", "manager");
    const me = (await req("GET", "/modules")).json() as {
      modules: { id: string; state: string; allowed: boolean }[];
    };
    expect(me.modules.find((m) => m.id === "missed_sale")).toMatchObject({
      state: "off",
      allowed: true,
    });
    const off = await mark("chk_t1", { from_date: EARLIER, reason: "Rang on paper" });
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe("module_off");
    await raw.query(
      "insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'missed_sale', true, 'on')",
      [venueId],
    );
  });

  it("is for managers: a bartender is refused", async () => {
    who = as("maya", "bartender");
    const r = await mark("chk_t1", { from_date: EARLIER, reason: "Rang on paper" });
    expect(r.statusCode).toBe(403);
  });

  it("needs a reason and an earlier night, and goes on a bar tab only", async () => {
    who = as("andy", "manager");
    for (const body of [
      { from_date: EARLIER },
      { from_date: EARLIER, reason: "   " },
      { from_date: TONIGHT, reason: "x" },
      { from_date: "2026-09-26", reason: "x" },
      { from_date: "2026-02-30", reason: "x" },
      { from_date: "yesterday", reason: "x" },
    ]) {
      const r = await mark("chk_t1", body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await mark("chk_room9", { from_date: EARLIER, reason: "x" })).statusCode).toBe(400);
    const v = await view("chk_t1");
    expect(v.missed_sale).toBeNull();
    expect(v.pending_missed_sale).toBeNull();
  });

  it("waits for approval, then lands on tonight's Z with its earlier date; the earlier night doesn't change", async () => {
    const before = await report(TONIGHT);
    const earlierBefore = await report(EARLIER);
    who = as("andy", "manager");
    const r = await mark("chk_t1", { from_date: EARLIER, reason: " Rang on paper, printer down " });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ status: "approval_pending" });
    expect((await view("chk_t1")).pending_missed_sale).toMatchObject({ from_date: EARLIER });
    // A second ask while one waits is refused.
    const again = await mark("chk_t1", { from_date: EARLIER, reason: "again" });
    expect(again.json().error.code).toBe("approval_pending");

    const routed = (
      await raw.query<{ routed_to: string }>(
        "select routed_to from approvals where venue_id = $1 and id = $2",
        [venueId, r.json().approval_id],
      )
    ).rows[0]!.routed_to;
    const phone = await raw.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, user_id) values ($1, 'staff_phone', 'Approver phone', $2) returning id",
      [venueId, routed],
    );
    await withVenue(pool, { venueId }, (c) =>
      decide(c, venueId, r.json().approval_id, {
        decision: "approve",
        userId: routed,
        deviceId: phone.rows[0]!.id,
        at: clock.now(),
      }),
    );
    expect((await view("chk_t1")).missed_sale).toMatchObject({
      from_date: EARLIER,
      reason: "Rang on paper, printer down",
      added_by: "Andy C.",
    });
    const audited = await raw.query(
      "select 1 from audit_log where venue_id = $1 and split_part(target, '/', 1) = 'check_missed_sales'",
      [venueId],
    );
    expect(audited.rowCount).toBeGreaterThan(0);

    const after = await report(TONIGHT);
    // It already counts on tonight's date: the totals are tonight's, unchanged by the mark.
    expect(after.sales.net_cents).toBe(before.sales.net_cents);
    const tabSales = Number(
      (
        await raw.query<{ cents: string }>(
          `select coalesce(sum(amount_cents), 0)::text as cents from check_lines
            where venue_id = $1 and check_id = $2 and kind not in ('tax', 'gratuity', 'refund')`,
          [venueId, ids["chk_t1"]],
        )
      ).rows[0]!.cents,
    );
    expect(after.missed_sales).toMatchObject({
      sales_cents: tabSales,
      checks: [
        {
          where: "Jess P.",
          from_date: EARLIER,
          reason: "Rang on paper, printer down",
          asked_by: "Andy C.",
          sales_cents: tabSales,
        },
      ],
    });
    expect(tabSales).toBeGreaterThan(0);
    const printed = reportPrintLines(after, (c) => `$${(c / 100).toFixed(2)}`).join("\n");
    expect(printed).toContain(`Jess P. · From the night of ${EARLIER}`);
    // The earlier night's report is as it was.
    const earlierAfter = await report(EARLIER);
    expect(earlierAfter.sales).toEqual(earlierBefore.sales);
    expect(earlierAfter.missed_sales?.checks ?? []).toHaveLength(0);
  });

  it("a closed night takes no new row: closed nights never reopen", async () => {
    await raw.query(
      `insert into night_closes (venue_id, business_date, z_number, closed_at, closed_by)
       values ($1, $2, 1, $3, $4)`,
      [venueId, EARLIER, clock.now().toString(), ids["andy"]],
    );
    await expect(
      raw.query(
        `insert into check_missed_sales (venue_id, check_id, business_date, from_date, reason, added_by, added_at)
         values ($1, $2, $3, '2026-09-23', 'x', $4, now())`,
        [venueId, ids["chk_t2"], EARLIER, ids["andy"]],
      ),
    ).rejects.toThrow();
    // The mark is still allowed tonight, from the closed night.
    who = as("andy", "manager");
    await raw.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_at, saved_by)
       select $1, 'approvals', coalesce(max(version), 0) + 1, '{"mode":"none"}', '2026-09-01', now(), $2
         from venue_settings where venue_id = $1 and key = 'approvals'`,
      [venueId, ids["andy"]],
    );
    const r = await mark("chk_t2", { from_date: EARLIER, reason: "Comped by mistake" });
    expect(r.statusCode).toBe(201);
    expect((await view("chk_t2")).missed_sale).toMatchObject({ from_date: EARLIER });
  });

  it("comes off while the tab is open, even with the switch off", async () => {
    await raw.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'missed_sale'",
      [venueId],
    );
    who = as("andy", "manager");
    expect((await req("POST", `/checks/${ids["chk_t2"]}/missed-sale/remove`)).statusCode).toBe(200);
    expect((await view("chk_t2")).missed_sale).toBeNull();
    expect((await report(TONIGHT)).missed_sales?.checks.map((x) => x.where)).toEqual(["Jess P."]);
  });
});
