import { fileURLToPath } from "node:url";
import path from "node:path";

/** The local Docker Compose database. Every environment overrides it through DATABASE_URL. */
export const defaultDatabaseUrl = "postgres://west4:west4@localhost:5432/west4";

/** packages/db/migrations, wherever this package is installed. */
export const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export function databaseUrl(): string {
  return process.env["DATABASE_URL"] ?? defaultDatabaseUrl;
}

/** The same server, a different database. Used to create and drop databases. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export function databaseName(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (name === "") throw new Error(`DATABASE_URL names no database: ${url}`);
  return name;
}
