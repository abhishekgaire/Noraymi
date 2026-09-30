import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, MigrationError } from "./migrate.js";
import { migrationsDir } from "./config.js";
import { createTestDatabase, type TestDatabase } from "./test-helpers.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

async function folderWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "west4-migrations-"));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}

describe("migrate", () => {
  it("runs the real migrations in order, and a second run applies nothing", async () => {
    const first = await migrate({ databaseUrl: db.url, dir: migrationsDir });
    expect(first.applied[0]).toBe("0001_baseline.sql");
    expect(first.skipped).toEqual([]);

    const second = await migrate({ databaseUrl: db.url, dir: migrationsDir });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);

    const rows = await query<{ name: string }>("select name from schema_migrations order by name");
    expect(rows.map((r) => r.name)).toEqual(first.applied);
  });

  it("records each file once and refuses an edited one", async () => {
    const dir = await folderWith({
      "0001_one.sql": "create table mig_one (id int);",
    });
    await migrate({ databaseUrl: db.url, dir: migrationsDir });
    // A separate throwaway database for the fixture set.
    const fixture = await createTestDatabase();
    try {
      await migrate({ databaseUrl: fixture.url, dir });
      await writeFile(path.join(dir, "0001_one.sql"), "create table mig_one (id bigint);");
      await expect(migrate({ databaseUrl: fixture.url, dir })).rejects.toThrow(
        /was edited after it was applied/,
      );
    } finally {
      await fixture.drop();
    }
  });

  it("rolls back a failing migration and stops the run", async () => {
    const fixture = await createTestDatabase();
    const dir = await folderWith({
      "0001_ok.sql": "create table mig_ok (id int);",
      "0002_bad.sql": "create table mig_bad (id int); select 1 / 0;",
      "0003_after.sql": "create table mig_after (id int);",
    });
    try {
      const error = await migrate({ databaseUrl: fixture.url, dir }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).migration).toBe("0002_bad.sql");

      const client = new pg.Client({ connectionString: fixture.url });
      await client.connect();
      try {
        const tables = await client.query<{ table_name: string }>(
          "select table_name from information_schema.tables where table_schema = 'public' order by 1",
        );
        expect(tables.rows.map((r) => r.table_name)).toEqual(["mig_ok", "schema_migrations"]);
        const recorded = await client.query<{ name: string }>(
          "select name from schema_migrations order by 1",
        );
        expect(recorded.rows.map((r) => r.name)).toEqual(["0001_ok.sql"]);
      } finally {
        await client.end();
      }

      // Fixing the file lets the run finish from where it stopped.
      await writeFile(path.join(dir, "0002_bad.sql"), "create table mig_bad (id int);");
      const resumed = await migrate({ databaseUrl: fixture.url, dir });
      expect(resumed.applied).toEqual(["0002_bad.sql", "0003_after.sql"]);
    } finally {
      await fixture.drop();
    }
  });
});
