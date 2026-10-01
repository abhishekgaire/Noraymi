import pg from "pg";
import { encryptSecret, saveTwilioIntegration, withVenue } from "@west4/db";
import { loadConfig } from "../config.js";

/**
 * One-time setup (M2-09; spec 11 · Accounts): makes a venue's own Twilio
 * subaccount through our platform account, moves a number we already own
 * into it, and records it in `integrations` with the subaccount's token
 * encrypted. It never buys a number: that costs money and is the founder's
 * call in Twilio's console.
 *
 *   TWILIO_ACCOUNT_SID=AC… TWILIO_AUTH_TOKEN=… \
 *   pnpm --filter @west4/api twilio:subaccount -- --venue west4karaoke --number +1212…
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const slug = arg("venue");
  const number = arg("number");
  const master = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  if (!slug || !number || !/^\+1\d{10}$/.test(number))
    throw new Error("usage: --venue <slug> --number <+1 number we own>");
  if (!master || !token || /replace_me/.test(master + token))
    throw new Error("set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (our platform account)");
  const config = loadConfig();
  const owner = new pg.Pool({
    connectionString: process.env["DATABASE_URL"] ?? config.databaseUrl,
  });
  const auth = { authorization: `Basic ${Buffer.from(`${master}:${token}`).toString("base64")}` };
  const form = { ...auth, "content-type": "application/x-www-form-urlencoded" };
  try {
    const venue = (
      await owner.query<{ id: string; name: string }>(
        "select id, name from venues where slug = $1",
        [slug],
      )
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const made = await fetch("https://api.twilio.com/2010-04-01/Accounts.json", {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ FriendlyName: `${venue.name} (${slug})` }).toString(),
    });
    if (!made.ok) throw new Error(`Twilio answered ${made.status} making the subaccount`);
    const sub = (await made.json()) as { sid: string; auth_token: string };
    const list = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${master}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
      { headers: auth },
    );
    const found = ((await list.json()) as { incoming_phone_numbers?: { sid: string }[] })
      .incoming_phone_numbers?.[0];
    if (!found) throw new Error(`${number} isn't a number on our platform account`);
    const moved = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${master}/IncomingPhoneNumbers/${found.sid}.json`,
      {
        method: "POST",
        headers: form,
        body: new URLSearchParams({ AccountSid: sub.sid }).toString(),
      },
    );
    if (!moved.ok)
      throw new Error(`Twilio answered ${moved.status} moving ${number} to the subaccount`);
    await withVenue(owner, { venueId: venue.id }, (c) =>
      saveTwilioIntegration(c, venue.id, {
        accountSid: sub.sid,
        phoneE164: number,
        secretEnc: encryptSecret(config.auth.secretKey, sub.auth_token),
        at: new Date().toISOString(),
      }),
    );
    console.warn(
      `${venue.name}: subaccount ${sub.sid} with ${number} recorded. Turn on SMS pumping protection in its Messaging settings.`,
    );
  } finally {
    await owner.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
