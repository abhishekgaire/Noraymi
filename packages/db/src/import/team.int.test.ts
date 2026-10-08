import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seedTwoVenues, type TestDatabase } from "../test-helpers.js";
import { formatReport, ImportInvalid, resolveVenue, runImport, type Venue } from "./load.js";
import { checkMapping, type Mapping } from "./mapping.js";
import { ImportRefused, prepareImport } from "./prepare.js";

/**
 * M9-05: the team imports as people and roles only. Each person is an
 * invited membership with their name, phone, email, role and language, the
 * PIN's length for their role, and no PIN and no badge; they choose their own
 * PIN from their invite (M9-08). The files are made up for the test.
 */
let db: TestDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let venue: Venue;
let ownerA: string;

const MAPPING: Mapping = checkMapping({
  mapping_version: 1,
  source: "team-test",
  files: {
    people: {
      file: "team.csv",
      columns: {
        legacy_ref: "Employee",
        name: "Name",
        email: "Email",
        phone: "Cell",
        role: "Job",
        locale: "Language",
      },
      values: {
        role: {
          Owner: "owner",
          "General Manager": "manager",
          Bartender: "bartender",
          Host: "front_desk",
          Barback: "staff",
        },
      },
    },
  },
}).mapping!;

const TEAM =
  "Employee,Name,Email,Cell,Job,Language\n" +
  "E-1,Test Manager,test.manager@example.com,(212) 555-0301,General Manager,English\n" +
  "E-2,Test Bartender,,(212) 555-0302,Bartender,Spanish\n" +
  "E-3,Test Host,test.host@example.com,,Host,\n" +
  "E-4,Test Barback,,,Barback,es\n";

const run = (text: string, mapping = MAPPING) =>
  runImport({
    pool,
    venue,
    prepared: prepareImport(mapping, () => text, venue.timeZone),
    dryRun: false,
  });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  pool = new pg.Pool({ connectionString: db.url, max: 3 });
  const v = await seedTwoVenues(db.url);
  ownerA = v.ownerA;
  venue = await resolveVenue(owner, v.venueA);
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("the team import (M9-05)", () => {
  it("makes each person an invited membership in one of the five roles, with no PIN and no badge", async () => {
    const report = await run(TEAM);
    expect(report.reconciles).toBe(true);
    expect(report.kinds.people).toMatchObject({
      in_db: 4,
      by: { manager: 1, bartender: 1, front_desk: 1, staff: 1 },
    });
    expect(formatReport(report)).toContain(
      "4 people (in files 4; new 4, already 0, changed 0) · bartender 1, front_desk 1, manager 1, staff 1",
    );
    const r = await owner.query(
      `select u.name, u.email, u.phone_e164, m.role, m.status, m.locale, m.pin_digits, m.pin_verifier,
              (select count(*)::int from staff_badges b where b.membership_id = m.id) as badges
         from import_refs x join memberships m on m.id::text = x.target_id join users u on u.id = m.user_id
        where x.run_id = $1 and x.kind = 'person' order by x.legacy_ref`,
      [report.run_id],
    );
    expect(r.rows).toEqual([
      {
        name: "Test Manager",
        email: "test.manager@example.com",
        phone_e164: "+12125550301",
        role: "manager",
        status: "invited",
        locale: "en",
        pin_digits: 6,
        pin_verifier: null,
        badges: 0,
      },
      {
        name: "Test Bartender",
        email: null,
        phone_e164: "+12125550302",
        role: "bartender",
        status: "invited",
        locale: "es",
        pin_digits: 4,
        pin_verifier: null,
        badges: 0,
      },
      {
        name: "Test Host",
        email: "test.host@example.com",
        phone_e164: null,
        role: "front_desk",
        status: "invited",
        locale: "en",
        pin_digits: 4,
        pin_verifier: null,
        badges: 0,
      },
      {
        name: "Test Barback",
        email: null,
        phone_e164: null,
        role: "staff",
        status: "invited",
        locale: "es",
        pin_digits: 4,
        pin_verifier: null,
        badges: 0,
      },
    ]);
    // Every membership the run inserted: none has a PIN or a badge.
    const inserted = await owner.query(
      `select count(*)::int as n,
              count(*) filter (where m.pin_verifier is not null or exists
                (select 1 from staff_badges b where b.membership_id = m.id))::int as with_pin_or_badge
         from audit_log a join memberships m on a.target = 'memberships/' || m.id
        where a.request_id = $1 and a.action = 'memberships.insert'`,
      [`import:${report.run_id}`],
    );
    expect(inserted.rows[0]).toEqual({ n: 4, with_pin_or_badge: 0 });
  });

  it("refuses a team file with a PIN column before anything loads", async () => {
    const runs = async () =>
      (await owner.query("select count(*)::int as n from import_runs")).rows[0].n as number;
    const before = await runs();
    const file = readFileSync(
      join(import.meta.dirname, "../../test-fixtures/import/refused/staff-with-pin.csv"),
      "utf8",
    );
    expect(file.split("\n")[0]).toContain("PIN");
    const withPin: Mapping = {
      ...MAPPING,
      files: {
        people: {
          file: "team.csv",
          columns: { legacy_ref: "Staff #", name: "Name", role: "Position" },
          values: { role: { Bartender: "bartender" } },
        },
      },
    };
    expect(() => prepareImport(withPin, () => file, venue.timeZone)).toThrow(ImportRefused);
    // Another spelling of a PIN column, in a file the mapping doesn't even read it from.
    expect(() =>
      prepareImport(
        MAPPING,
        () => TEAM.replace("Language\n", "Language,Staff Pin\n"),
        venue.timeZone,
      ),
    ).toThrow(/looks like a PIN/);
    expect(await runs()).toBe(before);
  });

  it("refuses a role that isn't one of Owner, Manager, Bartender, Front desk and Staff", async () => {
    const unmapped = "Employee,Name,Email,Cell,Job,Language\nE-9,Test DJ,,,DJ,\n";
    await expect(run(unmapped)).rejects.toThrow(ImportInvalid);
    await expect(run(unmapped)).rejects.toThrow(`role "DJ" isn't in the mapping's values`);
    const raw: Mapping = {
      ...MAPPING,
      files: { people: { ...MAPPING.files.people!, values: {} } },
    };
    await expect(run(unmapped, raw)).rejects.toThrow(
      `role "DJ" must be one of owner, manager, bartender, front_desk, staff`,
    );
  });

  it("leaves someone already on the team as they are, PIN and all", async () => {
    await owner.query("update users set email = 'owner.a@example.com' where id = $1", [ownerA]);
    await owner.query(
      "update memberships set pin_verifier = 'test-verifier' where venue_id = $1 and user_id = $2",
      [venue.id, ownerA],
    );
    const before = await owner.query(
      "select m.id, m.role, m.status, m.pin_verifier, u.email from memberships m join users u on u.id = m.user_id where m.venue_id = $1 and m.user_id = $2",
      [venue.id, ownerA],
    );
    const email = before.rows[0]!.email as string | null;
    expect(email).not.toBeNull();
    const report = await run(
      `Employee,Name,Email,Cell,Job,Language\nE-OWN,Same Owner,${email},,Bartender,\n`,
    );
    expect(report.kinds.people).toMatchObject({ loaded: 1, in_db: 1 });
    const after = await owner.query(
      "select m.id, m.role, m.status, m.pin_verifier, u.email from memberships m join users u on u.id = m.user_id where m.venue_id = $1 and m.user_id = $2",
      [venue.id, ownerA],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
