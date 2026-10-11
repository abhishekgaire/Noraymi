// The isolated browser-test stack's database (E2E_ISOLATED=1): create it if it's missing, migrate
// it and load the demo seed. Runs before the isolated servers start (the guest web's first page
// needs the venue); the global setup loads the seed again once every server is up.
// Refuses the demo's own `west4` database and anything that isn't local.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
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

// Browsers upload photos, PDFs and CSVs straight to the local bucket with a presigned POST, and the
// bucket's CORS (docker-compose.yml) only lets the demo's own origins in. Add this stack's staff
// and guest origins (E2E_BUCKET_ORIGINS) to the rules already there, on the local store only.
const origins = (process.env["E2E_BUCKET_ORIGINS"] ?? "").split(",").filter(Boolean);
const endpoint = process.env["S3_ENDPOINT"] ?? "http://localhost:9000";
if (origins.length > 0) {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(endpoint))
    throw new Error(`e2e-db: the object store is not local (${endpoint})`);
  const s3sdk = createRequire(new URL("../apps/api/package.json", import.meta.url))(
    "@aws-sdk/client-s3",
  );
  const s3 = new s3sdk.S3Client({
    endpoint,
    region: process.env["S3_REGION"] ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? "west4",
      secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? "west4secret",
    },
  });
  const Bucket = process.env["S3_BUCKET_FILES"] ?? "west4-files";
  let rules = [];
  try {
    rules = (await s3.send(new s3sdk.GetBucketCorsCommand({ Bucket }))).CORSRules ?? [];
  } catch {
    rules = [];
  }
  const allowed = new Set(rules.flatMap((r) => r.AllowedOrigins ?? []));
  const missing = origins.filter((o) => !allowed.has(o));
  if (missing.length > 0) {
    rules.push({
      AllowedOrigins: missing,
      AllowedMethods: ["GET", "POST"],
      AllowedHeaders: ["*"],
      MaxAgeSeconds: 3000,
    });
    await s3.send(
      new s3sdk.PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }),
    );
    console.log(`e2e-db: ${Bucket} now takes uploads from ${missing.join(", ")}`);
  }
}
