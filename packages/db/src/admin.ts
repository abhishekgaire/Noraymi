import pg from "pg";
import { databaseName, withDatabase } from "./config.js";

/** Create an empty database on DATABASE_URL's server. */
export async function createDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  const client = new pg.Client({ connectionString: withDatabase(url, "postgres") });
  await client.connect();
  try {
    await client.query(`create database ${quoteIdent(name)}`);
  } finally {
    await client.end();
  }
}

/** Drop a database, disconnecting anyone still on it. */
export async function dropDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  const client = new pg.Client({ connectionString: withDatabase(url, "postgres") });
  await client.connect();
  try {
    await client.query(`drop database if exists ${quoteIdent(name)} with (force)`);
  } finally {
    await client.end();
  }
}

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing odd database name: ${name}`);
  return `"${name}"`;
}
