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

/**
 * The database URL: DATABASE_URL when set, else built from DB_HOST, DB_PORT,
 * DB_NAME, DB_USER and DB_PASSWORD (how ECS injects the managed RDS secret),
 * else the local default.
 */
export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  const direct = env["DATABASE_URL"];
  if (direct !== undefined && direct !== "") return direct;
  const host = env["DB_HOST"];
  if (host !== undefined && host !== "") {
    const user = encodeURIComponent(env["DB_USER"] ?? "west4");
    const password = env["DB_PASSWORD"];
    const auth = password === undefined ? user : `${user}:${encodeURIComponent(password)}`;
    const port = env["DB_PORT"] ?? "5432";
    const name = env["DB_NAME"] ?? "west4";
    const ssl = env["DB_SSL"] === "false" ? "" : "?sslmode=require";
    return `postgres://${auth}@${host}:${port}/${name}${ssl}`;
  }
  return defaultDatabaseUrl;
}

/**
 * What the API connects as: APP_DATABASE_URL, or the same parts as
 * databaseUrl() with APP_DB_USER and APP_DB_PASSWORD, else the local app_rw.
 */
export function appDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const direct = env["APP_DATABASE_URL"];
  if (direct !== undefined && direct !== "") return direct;
  const host = env["DB_HOST"];
  if (host !== undefined && host !== "") {
    return databaseUrl({
      ...env,
      DATABASE_URL: undefined,
      DB_USER: env["APP_DB_USER"] ?? "app_rw",
      DB_PASSWORD: env["APP_DB_PASSWORD"],
    });
  }
  return "postgres://app_rw:app_rw@localhost:5432/west4";
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
