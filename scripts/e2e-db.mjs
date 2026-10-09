// The isolated browser-test stack's database (E2E_ISOLATED=1): create it if it's missing, migrate
// it and load the demo seed. Runs before the isolated servers start (the guest web's first page
// needs the venue); the global setup loads the seed again once every server is up.
// Refuses the demo's own `west4` database and anything that isn't local.
import { execSync } from "node:child_process";
import pg from "pg";

const url = process.env["DATABASE_URL"] ?? "";
const parsed = new URL(url);
const name = decodeURIComponent(parsed.pathname.slice(1));
if (!/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname))
  throw new Error(`e2e-db: not local (${url})`);
if (name === "west4") throw new Error("e2e-db: refusing the demo database west4");

parsed.pathname = "/postgres";
const admin = new pg.Client({ connectionString: parsed.toString() });
await admin.connect();
try {
  const found = await admin.query("select 1 from pg_database where datname = $1", [name]);
  if (found.rowCount === 0) {
    await admin.query(`create database "${name.replace(/"/g, '""')}"`);
    console.log(`e2e-db: created ${name}`);
  }
} finally {
  await admin.end();
}
execSync("pnpm db:migrate", { stdio: ["ignore", "ignore", "inherit"] });
execSync("pnpm seed", { stdio: ["ignore", "ignore", "inherit"] });
console.log(`e2e-db: ${name} migrated and seeded`);
