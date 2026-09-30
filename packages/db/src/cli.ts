import { createDatabase, dropDatabase } from "./admin.js";
import { databaseUrl, migrationsDir } from "./config.js";
import { migrate } from "./migrate.js";
import { ensureAppRoleLogin } from "./roles.js";
import { loadBuiltInRulePacks } from "./bootstrap.js";

const command = process.argv[2];
const log = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const url = databaseUrl();
  switch (command) {
    case "migrate": {
      const result = await migrate({ databaseUrl: url, dir: migrationsDir, log });
      log(
        result.applied.length === 0
          ? `nothing to apply (${result.skipped.length} already applied)`
          : `applied ${result.applied.length} migration(s)`,
      );
      await ensureAppRoleLogin(url, log);
      await loadBuiltInRulePacks(url, log);
      return;
    }
    case "reset": {
      // Local use only: drops the database and rebuilds it from scratch.
      const env = process.env["NODE_ENV"];
      if (env !== undefined && env !== "development" && env !== "test") {
        throw new Error(`db:reset refuses to run with NODE_ENV=${env}`);
      }
      if (!/localhost|127\.0\.0\.1|(^|@)db(:|\/)/.test(url)) {
        throw new Error("db:reset only runs against a local database");
      }
      log(`dropping and recreating ${url.replace(/\/\/.*@/, "//")}`);
      await dropDatabase(url);
      await createDatabase(url);
      const result = await migrate({ databaseUrl: url, dir: migrationsDir, log });
      log(`applied ${result.applied.length} migration(s)`);
      await ensureAppRoleLogin(url, log);
      await loadBuiltInRulePacks(url, log);
      return;
    }
    default:
      throw new Error(`usage: cli.js <migrate|reset> (got ${command ?? "nothing"})`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
