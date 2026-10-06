import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-helpers.js";
import { RETENTION } from "./retention.js";

/**
 * GA-M4 and GA-M2 (M7-20): `app_rw` can't delete or truncate any money, tip, drawer or night row, and
 * the insert-only ones (lines, moves, the ledger, shares, closes, payouts) can't be updated either. The
 * tables that change state as the night runs (a payment's status, a drawer session's count, a pool's
 * status, a shift's end) may update only the columns granted for that, never an amount once written.
 */
let db: TestDatabase;
let owner: pg.Pool;

const KEPT = [
  "checks",
  "check_lines",
  "check_revisions",
  "payments",
  "payment_allocations",
  "payment_events",
  "refunds",
  "venue_counters",
  "night_closes",
  "drawer_sessions",
  "drawer_moves",
  "drawer_handovers",
  "staff_banks",
  "tip_ledger",
  "tip_pools",
  "tip_pool_occupations",
  "tip_shares",
  "time_punches",
  "shifts",
  "payouts",
  "payout_lines",
  "exports",
];
const INSERT_ONLY = [
  "check_lines",
  "check_revisions",
  "payment_events",
  "night_closes",
  "drawer_moves",
  "tip_ledger",
  "tip_pool_occupations",
  "tip_shares",
  "payouts",
  "payout_lines",
];
/** Amounts that never change once written, on tables whose other columns may. */
const FIXED_AMOUNTS: Record<string, string[]> = {
  // A late payment's business date moves to where money posts now (M7-02), so it isn't fixed.
  payments: ["amount_cents", "method", "training"],
  payment_allocations: ["amount_cents", "check_id", "payment_id"],
  refunds: ["amount_cents", "payment_id"],
  drawer_sessions: ["opening_cents", "business_date", "drawer_id"],
  staff_banks: ["business_date", "user_id"],
  tip_pools: ["business_date", "method"],
  shifts: ["membership_id", "clock_in_punch_id"],
  exports: ["journals", "file", "business_date"],
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Pool({ connectionString: db.url });
});
afterAll(async () => {
  await owner.end();
  await db.drop();
});

const can = async (table: string, privilege: string) =>
  (
    await owner.query<{ ok: boolean }>("select has_table_privilege('app_rw', $1, $2) as ok", [
      `public.${table}`,
      privilege,
    ])
  ).rows[0]!.ok;
const canColumn = async (table: string, column: string) =>
  (
    await owner.query<{ ok: boolean }>(
      "select has_column_privilege('app_rw', $1, $2, 'UPDATE') as ok",
      [`public.${table}`, column],
    )
  ).rows[0]!.ok;

describe("the money, tip, drawer and night rows (GA-M4, GA-M2)", () => {
  it.each(KEPT)("app_rw can't delete or truncate %s", async (table) => {
    expect(await can(table, "DELETE")).toBe(false);
    expect(await can(table, "TRUNCATE")).toBe(false);
  });

  it.each(INSERT_ONLY)("app_rw can't update %s at all", async (table) => {
    expect(await can(table, "UPDATE")).toBe(false);
    const columns = await owner.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
      [table],
    );
    for (const c of columns.rows)
      expect(await canColumn(table, c.column_name), `${table}.${c.column_name}`).toBe(false);
  });

  it.each(Object.entries(FIXED_AMOUNTS))(
    "app_rw can't change %s's written amounts",
    async (table, columns) => {
      for (const column of columns)
        expect(await canColumn(table, column), `${table}.${column}`).toBe(false);
    },
  );

  it("keeps the tip, pool, share, ledger, punch and shift rows 6 years, and the money rows 3", () => {
    const years = Object.fromEntries(RETENTION.map((r) => [r.table, r.years]));
    for (const t of ["tip_ledger", "tip_pools", "tip_shares", "time_punches", "shifts"])
      expect(years[t]).toBe(6);
    for (const t of ["checks", "check_lines", "payments", "refunds", "night_closes"])
      expect(years[t]).toBeGreaterThanOrEqual(3);
  });
});
