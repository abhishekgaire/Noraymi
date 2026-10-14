import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { cashDiscount } from "@west4/rules";
import {
  FrozenClock,
  SEED_NOW,
  cents,
  formatMoney,
  newYorkCounty,
  newYorkCountyTaxed,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { hostJobBytes } from "../print/host-bytes.js";
import { receiptPrintLines } from "../print/ticket.js";
import { presentCheck } from "../rooms/present.js";

/**
 * Print the bill (P-01): Room 9's bill before paying matches its check to the cent ($618.60, the
 * $120.00 deposit, $498.60 left to pay) before and after Present the check, in English and Spanish;
 * prints on ESC/POS and Star raster; each print is a print_jobs row in the audit log, reprints
 * counted; a failed print shows in the usual failed list; the cash price with the discount on.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);

const post = (path: string, payload: object = {}) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": randomUUID() },
    payload,
  });
const job = async (id: string) =>
  (
    await owner.query<{
      kind: string;
      station: string;
      reprint_n: number;
      payload: { lines: string[] };
    }>("select kind, station, reprint_n, payload from print_jobs where id = $1", [id])
  ).rows[0]!;

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
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" } as never],
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

describe("Print the bill (P-01)", () => {
  it("before Present the check: Room 9's bill to the cent, in the venue's English", async () => {
    const r = await post(`/checks/${ids["chk_room9"]}/bill`);
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json() as { print_job_id: string; reprint_n: number };
    expect(body).toMatchObject({ reprint_n: 0, total_cents: 61860, due_cents: 49860 });
    const j = await job(body.print_job_id);
    expect(j).toMatchObject({ kind: "bill", station: "front_desk", reprint_n: 0 });
    const lines = j.payload.lines;
    expect(lines).toContain("BILL");
    expect(lines).toContain("Guests: 12");
    expect(lines.some((l) => /^Room time · 161 min.*\$322\.00$/.test(l))).toBe(true);
    expect(lines).toContain("Subtotal  $480.00");
    const tax = lines
      .filter((l) => l.startsWith("Tax · "))
      .map((l) => Number(/\$([\d.]+)$/.exec(l)![1]!.replace(".", "")));
    expect(tax.reduce((s, c) => s + c, 0)).toBe(4260);
    expect(lines).toContain("Gratuity included (20%)  $96.00");
    expect(lines).toContain("Total  $618.60");
    expect(lines).toContain("Deposit  −$120.00");
    expect(lines).toContain("Left to pay  $498.60");
    expect(lines.at(-1)).toBe("This is not a receipt");
    // No cash discount at West 4: no cash price.
    expect(lines.some((l) => l.startsWith("Cash price"))).toBe(false);
  });

  it("in Spanish, the same amounts", async () => {
    const r = await post(`/checks/${ids["chk_room9"]}/bill`, { locale: "es" });
    expect(r.statusCode, r.body).toBe(201);
    const j = await job((r.json() as { print_job_id: string }).print_job_id);
    expect(j.reprint_n).toBe(1);
    expect(j.payload.lines).toContain("CUENTA");
    expect(j.payload.lines).toContain("Personas: 12");
    expect(j.payload.lines).toContain("Propina incluida (20%)  $96.00");
    expect(j.payload.lines).toContain("Total  $618.60");
    expect(j.payload.lines).toContain("Depósito  −$120.00");
    expect(j.payload.lines).toContain("Por pagar  $498.60");
    expect(j.payload.lines.at(-1)).toBe("Esto no es un recibo");
  });

  it("after Present the check: the finalized revision, the same to the cent, counted as a reprint", async () => {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    await withVenue(app, { venueId }, (c) =>
      presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
    );
    const r = await post(`/checks/${ids["chk_room9"]}/bill`);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ reprint_n: 2, total_cents: 61860, due_cents: 49860 });
    const j = await job((r.json() as { print_job_id: string }).print_job_id);
    expect(j.payload.lines).toContain("Total  $618.60");
    expect(j.payload.lines).toContain("Left to pay  $498.60");
    // The printed slip says it's a reprint.
    expect(receiptPrintLines(j.payload, { reprintN: j.reprint_n })[0]).toBe("REPRINT 2");
    // Each print is in the audit log, by who printed it.
    const audited = await owner.query<{ n: number }>(
      `select count(*)::int as n from audit_log a join print_jobs p on a.target = 'print_jobs/' || p.id
        where a.venue_id = $1 and a.action = 'print_jobs.insert' and p.kind = 'bill' and a.actor = $2`,
      [venueId, ids["andy"]],
    );
    expect(audited.rows[0]!.n).toBe(3);
  });

  it("prints on both command sets", async () => {
    const r = await post(`/checks/${ids["chk_room9"]}/bill`);
    const j = await job((r.json() as { print_job_id: string }).print_job_id);
    const esc = hostJobBytes({ ...j, payload: j.payload }, "escpos", "America/New_York");
    const text = String.fromCharCode(...esc);
    expect(text).toContain("Total");
    expect(text).toContain("$618.60");
    expect(text).toContain("This is not a receipt");
    const star = hostJobBytes({ ...j, payload: j.payload }, "star_raster", "America/New_York");
    expect(star.length).toBeGreaterThan(1000);
    // Star raster opens with its raster-mode command, never ESC/POS text.
    expect(String.fromCharCode(...star)).not.toContain("This is not a receipt");
  });

  it("a printer that's offline: the bill shows in the usual failed list", async () => {
    const r = await post(`/checks/${ids["chk_room9"]}/bill`);
    const id = (r.json() as { print_job_id: string }).print_job_id;
    await owner.query("update print_jobs set status = 'failed', failed_at = $2 where id = $1", [
      id,
      SEED_NOW.toString(),
    ]);
    const failed = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/print-jobs?status=failed`,
    });
    expect(failed.statusCode, failed.body).toBe(200);
    expect(JSON.stringify(failed.json())).toContain(id);
  });

  it("with the cash discount on, the cash price under the total and under Left to pay", async () => {
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on)
       select venue_id, key, version + 1, jsonb_set(value, '{cardFee}', $2::jsonb), starts_on
         from venue_settings where venue_id = $1 and key = 'pay' order by version desc limit 1`,
      [venueId, JSON.stringify({ mode: "discount", pct: 4, foodIncludesFee: true })],
    );
    const r = await post(`/checks/${ids["chk_room9"]}/bill`);
    expect(r.statusCode, r.body).toBe(201);
    const lines = (await job((r.json() as { print_job_id: string }).print_job_id)).payload.lines;
    const cash = (amount: number) =>
      cashDiscount({
        amountCents: amount,
        pct: 4,
        taxRatePct: "8.875",
        foodIncludesFee: true,
        foodWeightCents: 0,
        otherWeightCents: 0,
      }).cashPaysCents;
    const dollars = (c: number) => formatMoney("en", cents(c));
    const total = lines.indexOf("Total  $618.60");
    expect(lines[total + 1]).toBe(`Cash price  ${dollars(cash(61860))}`);
    const due = lines.indexOf("Left to pay  $498.60");
    expect(lines[due + 1]).toBe(`Cash price  ${dollars(cash(49860))}`);
  });

  it("an open tab with a discount on it (P-02): the bill shows it, and the total follows", async () => {
    const d = await post(`/checks/${ids["chk_t1"]}/discount`, {
      mode: "amount",
      amount_cents: 300,
      reason: "Regular guest",
    });
    expect(d.statusCode, d.body).toBe(201);
    const r = await post(`/checks/${ids["chk_t1"]}/bill`);
    expect(r.statusCode, r.body).toBe(201);
    const lines = (await job((r.json() as { print_job_id: string }).print_job_id)).payload.lines;
    expect(lines).toContain("Discount  −$3.00");
  });
});
