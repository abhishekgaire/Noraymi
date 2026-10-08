import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { publishTestRulePack } from "./test-pack.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSeedFile } from "../seed.js";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "../test-helpers.js";
import { formatReport, ImportInvalid, resolveVenue, runImport, type Venue } from "./load.js";
import { checkMapping, type Mapping } from "./mapping.js";
import { ImportRefused, prepareImport } from "./prepare.js";

const fixtures = join(import.meta.dirname, "../../test-fixtures/import");
let db: TestDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let v: TwoVenues;
let venueA: Venue;
let venueB: Venue;

function fixture(dir: string, mappingFile = "mapping.json") {
  const mapping = checkMapping(
    JSON.parse(readFileSync(join(fixtures, dir, mappingFile), "utf8")),
  ).mapping!;
  return { mapping, read: (f: string) => readFileSync(join(fixtures, dir, f), "utf8") };
}

function prepared(dir: string, venue: Venue, edit?: (file: string, text: string) => string) {
  const { mapping, read } = fixture(dir);
  return prepareImport(mapping, (f) => (edit ? edit(f, read(f)) : read(f)), venue.timeZone);
}

/** Every row of the venue's imported tables, to show a second run changes none of them. */
async function snapshot(venueId: string): Promise<string> {
  const parts: unknown[] = [];
  for (const t of [
    "guests",
    "bookings",
    "consents",
    "menu_categories",
    "menu_items",
    "menu_variants",
    "memberships",
    "legacy_nightly_totals",
    "import_refs",
  ]) {
    const r = await owner.query(
      `select to_jsonb(x) as j from ${t} x where venue_id = $1 order by 1::text`,
      [venueId],
    );
    parts.push(r.rows.map((row: { j: unknown }) => JSON.stringify(row.j)).sort());
  }
  return JSON.stringify(parts);
}

const count = async (sql: string, params: unknown[]) =>
  Number(Object.values((await owner.query(sql, params)).rows[0] as object)[0]);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  // The menu goes in through the save path's promotion checks (M9-04): the venue's rule pack.
  await publishTestRulePack(owner);
  pool = new pg.Pool({ connectionString: db.url, max: 3 });
  v = await seedTwoVenues(db.url);
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

describe("the rehearsal import from the demo seed", () => {
  let liveRun: string;

  it("dry run: reports 11 bookings with $990.00 of deposits and leaves the venue as it was", async () => {
    const before = await snapshot(v.venueA);
    const report = await runImport({
      pool,
      venue: venueA,
      prepared: prepared("rehearsal", venueA),
      dryRun: true,
    });
    expect(report.kinds.bookings).toMatchObject({
      in_files: 11,
      loaded: 11,
      in_db: 11,
      cents_in_files: 99000,
      cents_in_db: 99000,
    });
    expect(report.kinds.guests).toMatchObject({ in_files: 17, in_db: 17 });
    expect(report.kinds.menu).toMatchObject({ in_files: 127, in_db: 127 });
    expect(report.kinds.people).toMatchObject({
      in_db: 4,
      by: { owner: 1, manager: 1, bartender: 1, front_desk: 1 },
    });
    expect(report.reconciles).toBe(true);
    expect(formatReport(report)).toContain(
      "11 bookings with $990.00 of deposits (in files 11, $990.00; new 11, already 0, changed 0) · history 7, named_room 4",
    );
    expect(await snapshot(v.venueA)).toBe(before);
    const run = await owner.query("select mode, state, report from import_runs where id = $1", [
      report.run_id,
    ]);
    expect(run.rows[0]).toMatchObject({ mode: "dry_run", state: "done" });
  });

  it("live run: loads every record into the venue, with no PIN anywhere", async () => {
    const report = await runImport({
      pool,
      venue: venueA,
      prepared: prepared("rehearsal", venueA),
      dryRun: false,
      batchSize: 5,
    });
    liveRun = report.run_id;
    expect(report.reconciles).toBe(true);
    expect(report.kinds.bookings).toMatchObject({ loaded: 11, cents_in_db: 99000 });
    const b = await owner.query(
      `select count(*)::int as n, sum(deposit_legacy_cents)::int as cents, bool_and(source = 'import') as imported,
              bool_and(legacy_ref is not null) as refs, min(business_date)::text as d
         from bookings where venue_id = $1`,
      [v.venueA],
    );
    expect(b.rows[0]).toEqual({ n: 11, cents: 99000, imported: true, refs: true, d: "2026-09-25" });
    const marcus = await owner.query(
      `select b.party_size, b.status, r.name as room, g.name as guest from bookings b
         join rooms r on r.id = b.room_id join guests g on g.id = b.guest_id where b.legacy_ref = 'BK-MARCUS'`,
    );
    expect(marcus.rows[0]).toEqual({
      party_size: 12,
      status: "checked_in",
      room: "Room 9",
      guest: "Marcus T.",
    });
    expect(await count("select count(*) from menu_variants where venue_id = $1", [v.venueA])).toBe(
      127,
    );
    const people = await owner.query(
      `select count(*)::int as n, bool_and(status = 'invited') as invited, bool_and(pin_verifier is null) as no_pin
         from memberships m join import_refs r on r.target_id = m.id::text where r.kind = 'person' and m.venue_id = $1`,
      [v.venueA],
    );
    expect(people.rows[0]).toEqual({ n: 4, invited: true, no_pin: true });
  });

  it("gives every loaded row an audit row naming the import run", async () => {
    const missing = await owner.query(
      `select r.target_table, r.target_id from import_refs r
        where r.run_id = $1
          and not exists (select 1 from audit_log a
                           where a.venue_id = r.venue_id and a.request_id = 'import:' || r.run_id
                             and a.action = r.target_table || '.insert' and a.target = r.target_table || '/' || r.target_id)`,
      [liveRun],
    );
    expect(missing.rows).toEqual([]);
    expect(await count("select count(*) from import_refs where run_id = $1", [liveRun])).toBe(
      17 + 4 + 127 + 127 + 9 + 1 + 11,
    );
    // The variants and new users too: each insert of the run is audited under it, in the venue's chain.
    expect(
      await count(
        "select count(*) from audit_log where request_id = $1 and action in ('menu_variants.insert', 'users.insert')",
        [`import:${liveRun}`],
      ),
    ).toBe(127 + 4);
    expect(
      await count("select count(*) from audit_log where request_id = $1 and venue_id <> $2", [
        `import:${liveRun}`,
        v.venueA,
      ]),
    ).toBe(0);
  });

  it("running the same files again changes nothing", async () => {
    const before = await snapshot(v.venueA);
    const audits = await count(
      "select count(*) from audit_log where venue_id = $1 and action not like 'import_runs.%'",
      [v.venueA],
    );
    const report = await runImport({
      pool,
      venue: venueA,
      prepared: prepared("rehearsal", venueA),
      dryRun: false,
    });
    expect(report.kinds.bookings).toMatchObject({
      loaded: 0,
      already: 11,
      in_db: 11,
      cents_in_db: 99000,
    });
    expect(report.kinds.menu).toMatchObject({ loaded: 0, already: 127 });
    expect(report.reconciles).toBe(true);
    expect(await snapshot(v.venueA)).toBe(before);
    expect(
      await count(
        "select count(*) from audit_log where venue_id = $1 and action not like 'import_runs.%'",
        [v.venueA],
      ),
    ).toBe(audits);
  });

  it("a cutover delta adds only the new booking, and reports a changed one without applying it", async () => {
    const delta = prepared("rehearsal", venueA, (f, text) =>
      f !== "reservations.csv"
        ? text
        : text.replace("$120.00,Arrived", "$150.00,Arrived") +
          "BK-NEW,G-TANYA,Room 2,4,2026-10-02 21:00,2026-10-02 23:00,$40.00,Confirmed,TERMS-1\n",
    );
    const report = await runImport({ pool, venue: venueA, prepared: delta, dryRun: false });
    expect(report.kinds.bookings).toMatchObject({
      in_files: 12,
      loaded: 1,
      already: 10,
      changed: 1,
    });
    expect(report.changed).toEqual([
      { kind: "bookings", file: "reservations.csv", line: 3, legacy_ref: "BK-MARCUS" },
    ]);
    expect(report.reconciles).toBe(false);
    const r = await owner.query(
      "select legacy_ref, deposit_legacy_cents from bookings where legacy_ref in ('BK-MARCUS', 'BK-NEW') order by 1",
    );
    expect(r.rows).toEqual([
      { legacy_ref: "BK-MARCUS", deposit_legacy_cents: 12000 },
      { legacy_ref: "BK-NEW", deposit_legacy_cents: 4000 },
    ]);
  });
});

describe("refusals and problems", () => {
  it.each(["mapping-pin.json", "mapping-card.json", "mapping-card-in-notes.json"])(
    "%s is refused before anything loads",
    async (file) => {
      const before = await snapshot(v.venueB);
      const runs = await count("select count(*) from import_runs", []);
      const { mapping, read } = fixture("refused", file);
      expect(() => prepareImport(mapping, read, venueB.timeZone)).toThrow(ImportRefused);
      expect(await snapshot(v.venueB)).toBe(before);
      expect(await count("select count(*) from import_runs", [])).toBe(runs);
    },
  );

  it("a row with a problem stops the whole import, naming file and line", async () => {
    const p = prepared("sample", venueB, (f, text) =>
      f === "bookings.csv" ? text.replace("Room A,6", "Room 9,6") : text,
    );
    await expect(runImport({ pool, venue: venueB, prepared: p, dryRun: false })).rejects.toThrow(
      "bookings.csv:2 room \"Room 9\" isn't one of the venue's rooms",
    );
    expect(await count("select count(*) from guests where venue_id = $1", [v.venueB])).toBe(0);
  });
});

describe("the venue wall", () => {
  it("an import writes only its own venue, and can't reach another venue's guests or rooms", async () => {
    const aBefore = await snapshot(v.venueA);
    const report = await runImport({
      pool,
      venue: venueB,
      prepared: prepared("sample", venueB),
      dryRun: false,
    });
    expect(report.reconciles).toBe(true);
    // The opt-out stops every text; the opt-in with no form or IP is listed, never consent (M9-03).
    expect(report.kinds.consents).toMatchObject({
      in_db: 3,
      by: { "marketing sms given": 1, "texts sms revoked": 1, "texts sms given": 1 },
    });
    expect(report.consents).toMatchObject({
      marketing_with_proof: 1,
      opt_outs: 1,
      service: 1,
      dropped_no_proof: 1,
      dropped: [
        {
          file: "consents.csv",
          line: 5,
          legacy_ref: "C-4",
          missing: ["the form", "the IP address"],
        },
      ],
    });
    expect(formatReport(report)).toContain(
      "Consents in the files: 1 marketing opt-in(s) with proof, 1 opt-out(s), 1 service-text opt-in(s), 1 marketing opt-in(s) dropped for lack of proof",
    );
    const proofless = await owner.query(
      `select count(*)::int as n from consents where venue_id = $1 and kind = 'marketing' and revoked_at is null
          and (given_at is null or source is null or text_version is null or ip is null)`,
      [v.venueB],
    );
    expect(proofless.rows[0].n).toBe(0);
    expect(report.kinds.nightly_totals).toMatchObject({ in_db: 2, cents_in_db: 931050 });
    expect(report.kinds.bookings).toMatchObject({ in_db: 2, cents_in_db: 12500 });
    expect(await snapshot(v.venueA)).toBe(aBefore);
    expect(
      await count("select count(*) from audit_log where request_id = $1 and venue_id <> $2", [
        `import:${report.run_id}`,
        v.venueB,
      ]),
    ).toBe(0);

    // Venue A's imported guest G-TANYA is invisible from venue B.
    const { mapping } = fixture("sample");
    const crossing: Mapping = { ...mapping, files: { bookings: mapping.files.bookings! } };
    const csv =
      "booking_id,guest_id,room_name,pax,start_time,end_time,deposit_cents\nX-1,G-TANYA,Room A,2,2026-10-09 21:00,2026-10-09 22:00,0\n";
    const p = prepareImport(crossing, () => csv, venueB.timeZone);
    await expect(runImport({ pool, venue: venueB, prepared: p, dryRun: false })).rejects.toThrow(
      ImportInvalid,
    );
  });
});
