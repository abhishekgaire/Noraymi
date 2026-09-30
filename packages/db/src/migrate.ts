import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export interface Migration {
  /** The file name, for example 0001_baseline.sql. */
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrateOptions {
  readonly databaseUrl: string;
  /** Folder of plain SQL files named NNNN_name.sql. */
  readonly dir: string;
  readonly log?: (line: string) => void;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${migration}: ${message}`, options);
    this.name = "MigrationError";
  }
}

const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

// One lock key for every runner on the database, so two deploys never race.
const LOCK_KEY = 0x77_34_6d_69; // "w4mi"

/** Read and validate the migration files: names, no gaps, no duplicate numbers. */
export async function listMigrations(dir: string): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  let expected = 1;
  for (const name of entries) {
    const match = FILE_NAME.exec(name);
    if (!match) {
      throw new MigrationError(name, "file name must look like 0001_snake_case.sql");
    }
    const number = Number(match[1]);
    if (number !== expected) {
      throw new MigrationError(name, `expected migration number ${pad(expected)}`);
    }
    expected += 1;
    const filePath = path.join(dir, name);
    const sql = await readFile(filePath, "utf8");
    migrations.push({ name, path: filePath, sql, checksum: sha256(sql) });
  }
  return migrations;
}

/**
 * Apply every migration that isn't recorded yet, in order, each in its own
 * transaction. A failing migration rolls back and stops the run; nothing after
 * it is attempted. Runs as whichever role DATABASE_URL names: the table owner.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const migrations = await listMigrations(options.dir);
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const recorded = new Map<string, string>();
    const rows = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from schema_migrations",
    );
    for (const row of rows.rows) recorded.set(row.name, row.checksum);

    for (const migration of migrations) {
      const previous = recorded.get(migration.name);
      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new MigrationError(
            migration.name,
            "was edited after it was applied; add a new migration instead",
          );
        }
        skipped.push(migration.name);
        continue;
      }
      log(`applying ${migration.name}`);
      await client.query("begin");
      try {
        // Tells the DDL event trigger (0004) this DDL is a migration, not an alert.
        await client.query("select set_config('app.migrating', 'on', true)");
        await client.query(migration.sql);
        await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [
          migration.name,
          migration.checksum,
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new MigrationError(migration.name, errorMessage(error), { cause: error });
      }
      applied.push(migration.name);
    }
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
  } finally {
    await client.end();
  }
  return { applied, skipped };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
