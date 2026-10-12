// Local only: the guest links the demo night has but no text carries (docs/manual-test.md 4.1 and 12.2).
//   node scripts/demo-links.mjs
// Prints Room 9's host link (Marcus T.'s, the seed's fixed token) and makes a manage link for
// Jae & co.'s booking (a new one each run; the last one stops working). Run it again after a reset.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = await import(pathToFileURL(path.join(root, "packages/db/dist/index.js")).href);

const url = process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4";
const guest = (process.env["GUEST_APP_URL"] ?? "http://localhost:3001").replace(/\/+$/, "");
if ((process.env["WEST4_ENV"] ?? "local") !== "local")
  throw new Error("demo-links: local only (WEST4_ENV isn't local)");
if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname))
  throw new Error(`demo-links: not a local database (${url})`);

const client = new pg.Client({ connectionString: url, application_name: "west4-demo-links" });
await client.connect();
try {
  console.log(`Room 9 host link (Marcus T.): ${guest}/r/${db.seedHostToken("sess_room9")}`);
  const token = randomBytes(24).toString("base64url");
  const r = await client.query(
    `update bookings set manage_token_hash = $1
      where id = (select row_id from seed_ids s join venues v on v.id = s.venue_id
                   where v.slug = 'west4karaoke' and s.slug = 'bk_jae')`,
    [db.payTokenHash(token)],
  );
  if (r.rowCount === 1) console.log(`Jae & co.'s manage link: ${guest}/b/${token}`);
  else
    console.log(
      "Jae & co.'s booking isn't in the database: reset the night (scripts/demo-local.sh).",
    );
} finally {
  await client.end();
}
