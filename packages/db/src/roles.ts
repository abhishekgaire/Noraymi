import pg from "pg";

/**
 * Give app_rw (created by migration 0002, without login) the login password
 * the environment holds in APP_DB_PASSWORD. Locally the Compose init script
 * does this instead; staging and production run it after every migrate. The
 * password never appears in a migration file.
 */
export async function ensureAppRoleLogin(
  databaseUrl: string,
  log: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const password = env["APP_DB_PASSWORD"];
  if (password === undefined || password === "") return;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Role names and passwords can't be bound parameters; quote_literal keeps it safe.
    await client.query(
      `do $do$ begin
         execute format('alter role app_rw with login password %L', $1);
       end $do$`.replace("$1", `'${password.replace(/'/g, "''")}'`),
    );
    log("app_rw can log in with APP_DB_PASSWORD");
  } finally {
    await client.end();
  }
}
