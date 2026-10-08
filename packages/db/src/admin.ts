import pg from "pg";
import { databaseName, withDatabase } from "./config.js";

/** Create an empty database on DATABASE_URL's server, or a copy of `template` (nobody connected to it). */
export async function createDatabase(url: string, template?: string): Promise<void> {
  const name = databaseName(url);
  const client = new pg.Client({ connectionString: withDatabase(url, "postgres") });
  await client.connect();
  try {
    await client.query(
      `create database ${quoteIdent(name)}${template ? ` template ${quoteIdent(template)}` : ""}`,
    );
  } finally {
    await client.end();
  }
}

/**
 * Drop a database. Gives connections that are closing a moment to finish
 * (pools end their clients asynchronously), then disconnects anyone left.
 */
export async function dropDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  const client = new pg.Client({ connectionString: withDatabase(url, "postgres") });
  await client.connect();
  try {
    for (let i = 0; i < 80; i += 1) {
      const r = await client.query<{ n: string }>(
        "select count(*) as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [name],
      );
      if (r.rows[0]?.n === "0") break;
      if (i === 79) {
        const who = await client.query<{ application_name: string; state: string; query: string }>(
          "select application_name, state, left(query, 60) as query from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
          [name],
        );
        process.stderr.write(
          `dropDatabase: still connected after 5 s: ${JSON.stringify(who.rows)}\n`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await client.query(`drop database if exists ${quoteIdent(name)} with (force)`);
  } finally {
    await client.end();
  }
}

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing odd database name: ${name}`);
  return `"${name}"`;
}
