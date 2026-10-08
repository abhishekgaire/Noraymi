import pg from "pg";
import { decryptSecret, saveTextCampaign, twilioIntegration, withVenue } from "@west4/db";
import { loadConfig } from "../config.js";
import { readCampaignStatus } from "./campaign.js";

/**
 * Ops (M8-22; runbook docs/runbooks/texts-10dlc.md): records the messaging
 * service a venue's 10DLC campaign uses and the status Twilio reports for
 * it. Production sends no text until the service campaign reads approved,
 * and no marketing text until the marketing campaign does. Run again after
 * Twilio says the campaign was approved.
 *
 *   pnpm --filter @west4/api twilio:campaign -- --venue west4karaoke --service MG… [--marketing]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const slug = arg("venue");
  const service = arg("service");
  const which = args.includes("--marketing") ? "marketing" : "service";
  if (!slug || !service || !/^MG[0-9a-f]{32}$/i.test(service))
    throw new Error("usage: --venue <slug> --service <MG… messaging service SID> [--marketing]");
  const config = loadConfig();
  const owner = new pg.Pool({
    connectionString: process.env["DATABASE_URL"] ?? config.databaseUrl,
  });
  try {
    const venue = (
      await owner.query<{ id: string; name: string }>(
        "select id, name from venues where slug = $1",
        [slug],
      )
    ).rows[0];
    if (!venue) throw new Error(`no venue ${slug}`);
    const twilio = await withVenue(owner, { venueId: venue.id }, (c) =>
      twilioIntegration(c, venue.id),
    );
    if (!twilio) throw new Error(`${venue.name} has no Twilio subaccount yet (twilio:subaccount)`);
    const status = await readCampaignStatus(
      {
        accountSid: twilio.accountSid,
        authToken: decryptSecret(config.auth.secretKey, twilio.secretEnc),
      },
      service,
      process.env["TWILIO_MESSAGING_BASE"] ? { baseUrl: process.env["TWILIO_MESSAGING_BASE"] } : {},
    );
    await withVenue(owner, { venueId: venue.id }, (c) =>
      saveTextCampaign(c, venue.id, which, {
        serviceSid: service,
        status,
        at: new Date().toISOString(),
      }),
    );
    console.warn(`${venue.name}: ${which} campaign on ${service} is ${status}.`);
  } finally {
    await owner.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
