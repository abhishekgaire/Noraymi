import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { computeReport } from "../nights/report.js";
import { buildNightJournal } from "../nights/journal.js";
import { reconcileNight } from "../reconcile/night.js";

/**
 * P-06: change a tip after paying. An outside card machine's tip changes to match the machine and
 * the tip ledger, Close the night's totals and the reconcile follow to the cent; over the limits
 * it waits for approval; a captured Stripe card is refused with the reason; after the night is
 * closed the difference posts to tonight, pointing back, and the closed night's tips still match.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let paymentId = "";
const clock = new SimulatedClock(SEED_NOW);
const NIGHT = "2026-09-25";
const changeTip = (payment: string, tip: number) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/payments/${payment}/tip`,
    headers: { "idempotency-key": `k-${Math.random()}` },
    payload: { tip_cents: tip },
  });
const ledgerFor = async (payment: string) =>
  (
    await raw.query<{
      business_date: string;
      adjusts: string | null;
      cents: string;
      user_id: string;
    }>(
      `select business_date::text, adjusts_business_date::text as adjusts, amount_cents::text as cents, user_id
         from tip_ledger where payment_id = $1 order by created_at, id`,
      [payment],
    )
  ).rows;
const tipDiffs = async (date: string) =>
  (
    await withVenue(pool, { venueId }, (c) => reconcileNight(c, venueId, date, clock.now()))
  ).differences.filter((d) => d.rule === "tip_ledger");

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
  const maya: Principal = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => maya],
    moduleCacheMs: 0,
  });
  await app.ready();
  await raw.query(
    "insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'outside_card', true, 'on')",
    [venueId],
  );
  const paid = await app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${ids["chk_room9"]}/payments`,
    headers: { "idempotency-key": "k-outside" },
    payload: { method: "outside_card", amount_cents: 3800, tip_cents: 500, note: "Auth 0X12AB" },
  });
  expect(paid.statusCode, paid.body).toBe(201);
  paymentId = paid.json().id as string;
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("change a tip after paying (P-06)", () => {
  it("lists the check's payments: the outside machine's can change, a captured card says why not", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/checks/${ids["chk_room9"]}/tips`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const rows = r.json().payments as { payment_id: string; change: string | null }[];
    expect(rows.find((p) => p.payment_id === paymentId)).toMatchObject({
      change: "outside",
      tip_cents: 500,
      label: "Auth 0X12AB",
    });
  });

  it("changes an outside machine's tip: the ledger and Close the night's totals match to the cent", async () => {
    const r = await changeTip(paymentId, 800);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().tip_cents).toBe(800);
    const ledger = await ledgerFor(paymentId);
    expect(ledger.reduce((s, l) => s + Number(l.cents), 0)).toBe(800);
    // The difference is credited to whoever took it, on its own night.
    expect(ledger.at(-1)).toMatchObject({
      cents: "300",
      business_date: NIGHT,
      adjusts: null,
      user_id: ids["maya"],
    });
    const change = (
      await raw.query(
        "select from_cents::int, to_cents::int, business_date::text, adjusts_business_date, changed_by from tip_changes",
      )
    ).rows;
    expect(change).toEqual([
      {
        from_cents: 500,
        to_cents: 800,
        business_date: NIGHT,
        adjusts_business_date: null,
        changed_by: ids["maya"],
      },
    ]);
    const report = await withVenue(pool, { venueId }, (c) =>
      computeReport(c, venueId, NIGHT, clock.now(), "x"),
    );
    expect(report.payments).toMatchObject({
      outside_card_cents: 3800,
      outside_card_tips_cents: 800,
      outside_card_total_cents: 4600,
    });
    expect(await tipDiffs(NIGHT)).toEqual([]);
    // The change is audited.
    expect(
      (await raw.query("select 1 from audit_log where action = 'tip_changes.insert'")).rowCount,
    ).toBeGreaterThan(0);
  });

  it("refuses the same tip, and a tip over $50 waits for the manager", async () => {
    const same = await changeTip(paymentId, 800);
    expect(same.statusCode).toBe(400);
    expect(same.json().error.details).toMatchObject({ reason: "unchanged" });
    const big = await changeTip(paymentId, 6000);
    expect(big.statusCode, big.body).toBe(202);
    expect(big.json().status).toBe("approval_pending");
    const again = await changeTip(paymentId, 900);
    expect(again.json().error.details).toMatchObject({ reason: "tip_waiting" });
    expect(
      (
        await raw.query<{ tip_cents: string }>("select tip_cents from payments where id = $1", [
          paymentId,
        ])
      ).rows[0]!.tip_cents,
    ).toBe("800");
    await raw.query("update approvals set status = 'expired' where kind = 'tip_change'");
  });

  it("refuses a captured Stripe card with the reason", async () => {
    const card = (
      await raw.query<{ id: string }>(
        `select id from payments where venue_id = $1 and status = 'captured'
            and method in ('card_present', 'card_online', 'card_on_file') limit 1`,
        [venueId],
      )
    ).rows[0]!;
    const r = await changeTip(card.id, 1000);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toMatchObject({ reason: "captured_card" });
  });

  it("after the night is closed, posts the difference to tonight pointing back; the closed night still matches", async () => {
    await raw.query(
      `insert into night_closes (venue_id, business_date, z_number, closed_at, closed_by)
       values ($1, $2, 1, $3, $4)`,
      [venueId, NIGHT, clock.now().toString(), ids["maya"]],
    );
    const r = await changeTip(paymentId, 900);
    expect(r.statusCode, r.body).toBe(200);
    const last = (await ledgerFor(paymentId)).at(-1)!;
    expect(last).toMatchObject({
      cents: "100",
      business_date: "2026-09-26",
      adjusts: NIGHT,
      user_id: ids["maya"],
    });
    const change = (
      await raw.query<{ business_date: string; adjusts: string }>(
        "select business_date::text, adjusts_business_date::text as adjusts from tip_changes where to_cents = 900",
      )
    ).rows[0]!;
    expect(change).toEqual({ business_date: "2026-09-26", adjusts: NIGHT });
    expect(await tipDiffs(NIGHT)).toEqual([]);
    expect(await tipDiffs("2026-09-26")).toEqual([]);
    // Tonight's Z lists it, and its journal clears it through the outside machine's account.
    const tonight = await withVenue(pool, { venueId }, (c) =>
      computeReport(c, venueId, "2026-09-26", clock.now(), "x"),
    );
    expect(tonight.adjustments).toContainEqual({
      what: "tip",
      description: "outside_card_tip",
      for_business_date: NIGHT,
      amount_cents: 100,
    });
    const journal = await withVenue(pool, { venueId }, (c) =>
      buildNightJournal(c, venueId, "2026-09-26", tonight),
    );
    const clearing = journal.lines.filter(
      (l) => l.account === "outside_card_clearing" && l.memo === `for ${NIGHT}`,
    );
    expect(clearing.reduce((s, l) => s + l.debit_cents - l.credit_cents, 0)).toBe(100);
  });
});
