import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { cashDiscount } from "@west4/rules";
import { newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { applyCashDiscount } from "./surcharge.js";

/**
 * The cash discount at the counter (O-09; Money rules 10; spec 17 · Step details 7) against
 * Postgres with row-level security on: with `foodIncludesFee` false, the cash's food share is never
 * discounted; with it true (or missing), the whole cash is. The stored cash_discount and tax lines
 * are what `cashDiscount` gives, and the cash pays the rest.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let venueId = "";
let checkId = "";
const DATE = "2026-09-25";

async function setDiscount(cardFee: Record<string, unknown>) {
  await owner.query(
    `insert into venue_settings (venue_id, key, version, value, starts_on)
     select venue_id, key, version + 1, jsonb_set(value, '{cardFee}', $2::jsonb), starts_on
       from venue_settings where venue_id = $1 and key = 'pay' order by version desc limit 1`,
    [venueId, JSON.stringify(cardFee)],
  );
}

async function weights() {
  const r = await owner.query<{ tax_category: string | null; kind: string; amount_cents: number }>(
    "select tax_category, kind, amount_cents::int as amount_cents from check_lines where check_id = $1",
    [checkId],
  );
  let food = 0;
  let other = 0;
  for (const l of r.rows) {
    if (l.tax_category === "food") food += l.amount_cents;
    else if (l.tax_category !== null && l.kind !== "tax" && l.kind !== "cash_discount")
      other += l.amount_cents;
  }
  return { food, other };
}

async function discountLines() {
  return (
    await owner.query<{ kind: string; amount_cents: number }>(
      `select kind, amount_cents::int as amount_cents from check_lines where check_id = $1
          and (kind = 'cash_discount' or description = 'Tax · cash discount') order by id`,
      [checkId],
    )
  ).rows;
}

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
  // An open room check with drinks; a $50.00 food line added to it.
  checkId = (
    await owner.query<{ id: string }>(
      `select k.id from checks k where k.venue_id = $1 and k.kind = 'room' and k.status = 'open'
          and exists (select 1 from check_lines l where l.check_id = k.id and l.tax_category = 'drink')
        order by k.id limit 1`,
      [venueId],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents,
       tax_category, tax_rate, business_date, added_at)
     values ($1, $2, 'item', 'Test food', 1, 5000, 5000, 'food', 0.08875, $3, now())`,
    [venueId, checkId, DATE],
  );
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await db?.drop();
});

describe("the cash discount and food (O-09)", () => {
  it("with food at cash prices, only the rest of the cash is discounted, as the rule gives it", async () => {
    await setDiscount({ mode: "discount", pct: 4, foodIncludesFee: false });
    const w = await weights();
    expect(w.food).toBe(5000);
    expect(w.other).toBeGreaterThan(0);
    const expected = cashDiscount({
      amountCents: 10000,
      pct: 4,
      taxRatePct: "8.875",
      foodIncludesFee: false,
      foodWeightCents: w.food,
      otherWeightCents: w.other,
    });
    expect(expected.excludedFoodCents).toBeGreaterThan(0);
    const pays = await withVenue(app, { venueId }, (c) =>
      applyCashDiscount(c, venueId, {
        checkId,
        amountCents: 10000,
        businessDate: DATE,
        at: "2026-09-26T02:45:00Z",
      }),
    );
    expect(pays).toBe(expected.cashPaysCents);
    expect(await discountLines()).toEqual([
      { kind: "cash_discount", amount_cents: -expected.discountCents },
      { kind: "tax", amount_cents: -expected.taxOffCents },
    ]);
  });

  it("with food prices including the fee (or the answer missing), the whole cash is discounted", async () => {
    for (const cardFee of [
      { mode: "discount", pct: 4, foodIncludesFee: true },
      { mode: "discount", pct: 4 },
    ]) {
      await setDiscount(cardFee);
      const before = (await discountLines()).length;
      const pays = await withVenue(app, { venueId }, (c) =>
        applyCashDiscount(c, venueId, {
          checkId,
          amountCents: 10000,
          businessDate: DATE,
          at: "2026-09-26T02:46:00Z",
        }),
      );
      // 4% of $100.00 is $4.00; its tax at 8.875% is $0.355, half up to $0.36.
      expect(pays).toBe(10000 - 400 - 36);
      expect((await discountLines()).slice(before)).toEqual([
        { kind: "cash_discount", amount_cents: -400 },
        { kind: "tax", amount_cents: -36 },
      ]);
    }
  });

  it("with the Cash discount switch off, cash pays the full amount whatever the rate says", async () => {
    await setDiscount({ mode: "discount", pct: 4, foodIncludesFee: true });
    await owner.query(
      `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'cash_discount', true, 'off')
       on conflict (venue_id, module_id) do update set state = 'off'`,
      [venueId],
    );
    const before = (await discountLines()).length;
    const pays = await withVenue(app, { venueId }, (c) =>
      applyCashDiscount(c, venueId, {
        checkId,
        amountCents: 10000,
        businessDate: DATE,
        at: "2026-09-26T02:47:00Z",
      }),
    );
    expect(pays).toBe(10000);
    expect((await discountLines()).length).toBe(before);
  });
});
