// Local only: a guest texts the venue, as Twilio would deliver it, so the demo can test STOP, HELP and
// replies (docs/manual-test.md section 13).
//   node scripts/demo-text.mjs "STOP"                    # from Jae & co.'s number (+13475550165)
//   node scripts/demo-text.mjs "please stop texting me" +12125550123
//   node scripts/demo-text.mjs --venue singsing "HELP"
// The demo has no Twilio, so the first run gives the venue a pretend Twilio connection (its number is
// the venue's own phone setting and its token "demo-token"; a reset removes it, and the next run adds
// it again). Texts the app sends stay fake either way: they only show in Messages. The text is then
// posted to the running API's Twilio webhook, signed with that token, exactly as Twilio signs it.
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = await import(pathToFileURL(path.join(root, "packages/db/dist/index.js")).href);

const url = process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4";
const api = (process.env["API_URL"] ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
if ((process.env["WEST4_ENV"] ?? "local") !== "local")
  throw new Error("demo-text: local only (WEST4_ENV isn't local)");
if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname))
  throw new Error(`demo-text: not a local database (${url})`);

const args = process.argv.slice(2);
let slug = "west4karaoke";
const vi = args.indexOf("--venue");
if (vi >= 0) {
  slug = args[vi + 1] ?? "";
  args.splice(vi, 2);
}
const [body, from = "+13475550165"] = args;
if (!body || !/^\+1\d{10}$/.test(from)) {
  console.error(
    'usage: node scripts/demo-text.mjs [--venue <slug>] "<text>" [+1 phone, no spaces]',
  );
  process.exit(1);
}

const TOKEN = "demo-token";
const client = new pg.Client({ connectionString: url, application_name: "west4-demo-text" });
await client.connect();
let to;
try {
  const venue = (await client.query("select id from venues where slug = $1", [slug])).rows[0];
  if (!venue) throw new Error(`demo-text: no venue ${slug}`);
  const existing = (
    await client.query(
      "select config->>'phone_e164' as phone from integrations where venue_id = $1 and kind = 'twilio'",
      [venue.id],
    )
  ).rows[0];
  if (existing?.phone) {
    to = existing.phone;
  } else {
    const phone = (
      await client.query(
        `select value->>'textNumber' as n from venue_settings
          where venue_id = $1 and key = 'phone' order by version desc limit 1`,
        [venue.id],
      )
    ).rows[0]?.n;
    if (!phone)
      throw new Error("demo-text: the venue has no texting number (Admin → Phone & texts)");
    const key = db.parseAuthSecretKey(process.env["AUTH_SECRET_KEY"] ?? db.LOCAL_DEV_AUTH_KEY);
    await client.query(
      `insert into integrations (venue_id, kind, status, external_id, config)
       values ($1, 'twilio', 'connected', $3, $2)`,
      [
        venue.id,
        JSON.stringify({ phone_e164: phone, secret_enc: db.encryptSecret(key, TOKEN) }),
        `ACdemo${venue.id.replace(/-/g, "")}`,
      ],
    );
    to = phone;
    console.log(`Gave ${slug} a pretend Twilio connection on ${phone}.`);
  }
} finally {
  await client.end();
}

// Twilio's signature: HMAC-SHA1 of the URL followed by every field name and value, sorted by name.
const hook = `${api}/v1/hooks/twilio`;
const params = {
  Body: body,
  From: from,
  MessageSid: `SMdemo${randomBytes(12).toString("hex")}`,
  To: to,
};
const signed = Object.keys(params)
  .sort()
  .reduce((acc, k) => acc + k + params[k], hook);
const signature = createHmac("sha1", TOKEN).update(signed, "utf8").digest("base64");
const res = await fetch(hook, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
  body: new URLSearchParams(params).toString(),
});
if (!res.ok) {
  console.error(`demo-text: the API refused it (${res.status}): ${await res.text()}`);
  process.exit(1);
}
console.log(`Texted "${body}" from ${from} to ${slug} (${to}). Open Messages in the staff app.`);
