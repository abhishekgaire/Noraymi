import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSeedFile } from "../seed.js";
import { createTestDatabase, seedTwoVenues, type TestDatabase } from "../test-helpers.js";
import { formatReport, resolveVenue, runImport, type Venue } from "./load.js";
import { checkMapping } from "./mapping.js";
import {
  checkOldSystemTotals,
  compareWithOldSystem,
  dryRunReportMarkdown,
  formatComparison,
  type OldSystemTotals,
} from "./old-system.js";
import { prepareImport } from "./prepare.js";
import { publishTestRulePack } from "./test-pack.js";

/**
 * M9-06: the dry run that proves nothing is lost, rehearsed on the fixtures.
 * Bookings, deposits and consents are compared in count and to the cent with
 * the old system's own totals (not the export), a written report is made for
 * the owner to sign, and the cutover delta adds only the new bookings.
 */
const fixtures = join(import.meta.dirname, "../../test-fixtures/import");
let db: TestDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let venueA: Venue;
let venueB: Venue;

function prepared(dir: string, venue: Venue, edit?: (file: string, text: string) => string) {
  const mapping = checkMapping(
    JSON.parse(readFileSync(join(fixtures, dir, "mapping.json"), "utf8")),
  ).mapping!;
  const read = (f: string) => readFileSync(join(fixtures, dir, f), "utf8");
  return prepareImport(mapping, (f) => (edit ? edit(f, read(f)) : read(f)), venue.timeZone);
}

function totals(dir: string, change: Record<string, unknown> = {}): OldSystemTotals {
  const raw = JSON.parse(readFileSync(join(fixtures, dir, "old-system-totals.json"), "utf8"));
  const { totals: t, problems } = checkOldSystemTotals({ ...raw, ...change });
  expect(problems).toEqual([]);
  return t!;
}

/** Every imported row of the venue, payments and journals included. */
async function snapshot(venueId: string): Promise<string> {
  const parts: unknown[] = [];
  for (const t of ["guests", "bookings", "payments", "consents", "import_refs", "room_blocks"]) {
    const r = await owner.query(`select to_jsonb(x) as j from ${t} x where venue_id = $1`, [
      venueId,
    ]);
    parts.push(r.rows.map((row: { j: unknown }) => JSON.stringify(row.j)).sort());
  }
  return JSON.stringify(parts);
}

const future = (extra = "") =>
  prepared("rehearsal", venueA, (f, text) =>
    f !== "reservations.csv" ? text : text.replaceAll(",Arrived,", ",Confirmed,") + extra,
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  await publishTestRulePack(owner);
  pool = new pg.Pool({ connectionString: db.url, max: 3 });
  const v = await seedTwoVenues(db.url);
  for (const r of readSeedFile().rooms) {
    await owner.query(
      `insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max, is_vip) values ($1, $2, $3, $4, $5, $6)`,
      [v.venueA, r.name, r.size_tier, r.capacity_min, r.capacity_max, r.is_vip],
    );
  }
  await owner.query(
    `insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max) values ($1, 'Room A', 'small', 2, 8)`,
    [v.venueB],
  );
  venueA = await resolveVenue(owner, v.venueA);
  venueB = await resolveVenue(owner, v.venueB);
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("the old system's totals file", () => {
  it("takes deposits as the old report prints them, never as a float, and names what's missing", () => {
    expect(
      checkOldSystemTotals({
        taken_from: "Reservations summary",
        taken_at: "Oct 9",
        bookings: 3,
        deposits: "$1,234.50",
        consents: 0,
      }).totals,
    ).toMatchObject({ deposit_cents: 123450 });
    expect(checkOldSystemTotals({ bookings: 1.5, deposits: 12.5, consents: -1 }).problems).toEqual([
      '"taken_from" is required',
      '"taken_at" is required',
      '"bookings" must be a whole number of records',
      '"consents" must be a whole number of records',
      '"deposits" is required, as "$1,234.50"',
    ]);
  });
});

describe("the import dry run (M9-06)", () => {
  it("matches the old system's bookings, deposits and consents in count and to the cent, and changes nothing", async () => {
    const before = await snapshot(venueA.id);
    const report = await runImport({
      pool,
      venue: venueA,
      prepared: future(),
      dryRun: true,
      cutoverDate: "2026-09-24",
    });
    const c = compareWithOldSystem(report, totals("rehearsal"));
    expect(c.matches).toBe(true);
    expect(formatComparison(c)).toEqual([
      "match · Bookings: old system 11, saved 11",
      "match · Deposits: old system $990.00, saved $990.00",
      "match · Consents: old system 0, saved 0",
      "match · Guests: old system 17, saved 17",
      "Matches the old system in count and to the cent.",
    ]);
    expect(await snapshot(venueA.id)).toBe(before);
  });

  it("counts a marketing opt-in without proof as listed, not lost, and says so", async () => {
    const report = await runImport({
      pool,
      venue: venueB,
      prepared: prepared("sample", venueB),
      dryRun: true,
    });
    const c = compareWithOldSystem(report, totals("sample"));
    expect(c.matches).toBe(true);
    expect(c.rows.find((r) => r.what === "Consents")).toMatchObject({
      saved: "4",
      note: "1 marketing opt-in(s) without proof listed, not imported as consent",
    });
  });

  it("names every difference, one booking or one cent, and the report can't be signed", async () => {
    const report = await runImport({
      pool,
      venue: venueA,
      prepared: future(),
      dryRun: true,
      cutoverDate: "2026-09-24",
    });
    const t = totals("rehearsal", { bookings: 12, deposits: "$990.01" });
    const c = compareWithOldSystem(report, t);
    expect(c.matches).toBe(false);
    expect(formatComparison(c)).toEqual([
      "DIFFERENT · Bookings: old system 12, saved 11",
      "DIFFERENT · Deposits: old system $990.01, saved $990.00",
      "match · Consents: old system 0, saved 0",
      "match · Guests: old system 17, saved 17",
      "Does NOT match the old system: fix every difference and run the dry run again.",
    ]);
    const md = dryRunReportMarkdown(report, t, c, formatReport(report));
    expect(md).toContain("| Deposits | $990.01 | $990.00 | **Different** |");
    expect(md).toContain("this report can't be signed");
  });

  it("writes a report for the owner to sign with counts and cents only, no guest's details", async () => {
    const report = await runImport({
      pool,
      venue: venueA,
      prepared: future(),
      dryRun: true,
      cutoverDate: "2026-09-24",
    });
    const t = totals("rehearsal");
    const md = dryRunReportMarkdown(
      report,
      t,
      compareWithOldSystem(report, t),
      formatReport(report),
    );
    expect(md).toContain("| Bookings | 11 | 11 | Match |");
    expect(md).toContain("**Result: matches the old system in count and to the cent.**");
    expect(md).toContain("- Signature: ____________________");
    const customers = readFileSync(join(fixtures, "rehearsal/customers.csv"), "utf8");
    // No guest's name, phone or email from the export is in the report.
    for (const line of customers.trim().split("\n").slice(1)) {
      for (const cell of line.split(",").slice(1))
        if (cell.length > 3) expect(md).not.toContain(cell);
    }
  });

  it("the rehearsed delta adds only the new bookings and changes nothing already imported", async () => {
    const live = await runImport({
      pool,
      venue: venueA,
      prepared: future(),
      dryRun: false,
      cutoverDate: "2026-09-24",
    });
    expect(compareWithOldSystem(live, totals("rehearsal")).matches).toBe(true);
    const before = await snapshot(venueA.id);
    const extra =
      "BK-LATE-1,G-TANYA,Room 2,4,2026-10-02 21:00,2026-10-02 23:00,$40.00,Confirmed,TERMS-1\n" +
      "BK-LATE-2,G-MARCUS,Room 3,4,2026-10-03 21:00,2026-10-03 23:00,$25.50,Confirmed,TERMS-1\n";
    const delta = await runImport({
      pool,
      venue: venueA,
      prepared: future(extra),
      dryRun: false,
      cutoverDate: "2026-09-25",
    });
    expect(delta.kinds.bookings).toMatchObject({ loaded: 2, already: 11, changed: 0 });
    expect(delta.deposits.held_cents).toBe(6550);
    expect(
      compareWithOldSystem(delta, totals("rehearsal", { bookings: 13, deposits: "$1,055.50" }))
        .matches,
    ).toBe(true);
    // Every row the first run saved is exactly as it was; only the two new bookings were added.
    const after = JSON.parse(await snapshot(venueA.id)) as string[][];
    const was = JSON.parse(before) as string[][];
    was.forEach((rows, i) => {
      for (const row of rows) expect(after[i]).toContain(row);
    });
    const added = await owner.query<{ legacy_ref: string }>(
      `select legacy_ref from bookings where venue_id = $1 and legacy_ref like 'BK-LATE-%' order by 1`,
      [venueA.id],
    );
    expect(added.rows.map((r) => r.legacy_ref)).toEqual(["BK-LATE-1", "BK-LATE-2"]);
    expect(after[1]!.length - was[1]!.length).toBe(2);
  });
});
