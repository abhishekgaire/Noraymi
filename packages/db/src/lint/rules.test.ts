import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrationsDir } from "../config.js";
import { emptyCatalog, lintDirectory, lintMigration } from "./index.js";
import type { RuleId } from "./index.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../lint-fixtures");

/** Tables earlier migrations are assumed to have created, for the fixtures. */
function catalogWithCore() {
  const catalog = emptyCatalog();
  for (const t of ["checks", "check_lines", "bookings", "rooms", "payments"])
    catalog.venueTables.add(t);
  return catalog;
}

const rules: RuleId[] = [
  "lock-timeout",
  "index-concurrently",
  "append-only-nullable",
  "money-rows-immutable",
  "venue-table-rls",
  "fk-names-venue",
  "app-rw-grants",
  "backfill-role",
];

describe("migration linter fixtures", () => {
  it("has a pass and a fail fixture for every rule", async () => {
    const files = await readdir(fixtures);
    for (const rule of rules) {
      expect(files, rule).toContain(`${rule}.pass.sql`);
      expect(files, rule).toContain(`${rule}.fail.sql`);
    }
  });

  for (const rule of rules) {
    it(`${rule}: the pass fixture is clean`, async () => {
      const source = await readFile(path.join(fixtures, `${rule}.pass.sql`), "utf8");
      const findings = lintMigration(`${rule}.pass.sql`, source, catalogWithCore());
      expect(findings.map((f) => `${f.line}: ${f.rule}: ${f.message}`)).toEqual([]);
    });

    it(`${rule}: the fail fixture is caught by that rule, naming the line`, async () => {
      const source = await readFile(path.join(fixtures, `${rule}.fail.sql`), "utf8");
      const findings = lintMigration(`${rule}.fail.sql`, source, catalogWithCore());
      expect(findings.length).toBeGreaterThan(0);
      expect(new Set(findings.map((f) => f.rule))).toEqual(new Set([rule]));
      for (const f of findings) expect(f.line).toBeGreaterThan(0);
    });
  }
});

describe("acceptance examples", () => {
  it("a migration without lock_timeout fails, naming the file and the line", () => {
    const findings = lintMigration("0009_x.sql", "create table t (id int);\n", emptyCatalog());
    expect(findings).toEqual([
      {
        file: "0009_x.sql",
        line: 1,
        rule: "lock-timeout",
        message: "set lock_timeout before the first statement",
      },
    ]);
  });

  it("references checks (id) fails and references checks (venue_id, id) passes", () => {
    const head =
      "set lock_timeout = '5s';\ncreate table x (id uuid primary key, venue_id uuid not null, check_id uuid not null, unique (venue_id, id),";
    const tail =
      ");\nalter table x enable row level security, force row level security;\ncreate policy venue_isolation on x using (true);";
    const bad = lintMigration(
      "bad.sql",
      `${head} foreign key (check_id) references checks (id)${tail}`,
      catalogWithCore(),
    );
    expect(bad.map((f) => f.rule)).toEqual(["fk-names-venue"]);
    const good = lintMigration(
      "good.sql",
      `${head} foreign key (venue_id, check_id) references checks (venue_id, id)${tail}`,
      catalogWithCore(),
    );
    expect(good).toEqual([]);
  });

  it("grant delete on check_lines to app_rw fails", () => {
    const findings = lintMigration(
      "g.sql",
      "set lock_timeout = '5s';\ngrant delete on check_lines to app_rw;",
      catalogWithCore(),
    );
    expect(findings.map((f) => f.rule)).toEqual(["app-rw-grants"]);
    expect(findings[0]?.line).toBe(2);
  });

  it("a venue table missing force row level security or unique (venue_id, id) fails", () => {
    const findings = lintMigration(
      "v.sql",
      `set lock_timeout = '5s';
create table t (id uuid primary key, venue_id uuid not null);
alter table t enable row level security;
create policy venue_isolation on t using (true);`,
      emptyCatalog(),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("force row level security");
    expect(findings[0]?.message).toContain("unique (venue_id, id)");
  });

  it("the catalog carries venue tables from one file to the next", () => {
    const catalog = emptyCatalog();
    lintMigration(
      "0001.sql",
      `set lock_timeout = '5s';
create table checks (id uuid primary key, venue_id uuid not null, unique (venue_id, id));
alter table checks enable row level security, force row level security;
create policy venue_isolation on checks using (true);`,
      catalog,
    );
    expect(catalog.venueTables.has("checks")).toBe(true);
    const later = lintMigration(
      "0002.sql",
      "set lock_timeout = '5s';\nalter table notes add column check_id uuid references checks (id);",
      catalog,
    );
    expect(later.map((f) => f.rule)).toEqual(["fk-names-venue"]);
  });
});

describe("the real migrations", () => {
  it("pass the linter", async () => {
    expect(await lintDirectory(migrationsDir)).toEqual([]);
  });
});
