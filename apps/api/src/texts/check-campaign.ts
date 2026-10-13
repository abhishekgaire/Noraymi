import pg from "pg";
import { decryptSecret, saveTextCampaign, twilioIntegration, withVenue } from "@west4/db";
import { loadConfig } from "../config.js";
import { readCampaignStatus } from "./campaign.js";

/**
 * Ops (M8-22, T-04; runbook docs/runbooks/texts-10dlc.md): re-reads a connected venue's service
 * campaign from Twilio with the venue's own stored keys, the same as Check again in Admin → Phone &
 * texts. With --marketing and --service, records the venue's marketing campaign's messaging service
 * (Marketing texts stays off until the lawyer answers). We hold no Twilio account for any venue (D123).
 *
 *   pnpm --filter @west4/api twilio:campaign -- --venue west4karaoke
 *   pnpm --filter @west4/api twilio:campaign -- --venue west4karaoke --marketing --service MG…
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const slug = arg("venue");
  const which = args.includes("--marketing") ? "marketing" : "service";
  const given = arg("service");
  if (!slug || (which === "marketing" && (!given || !/^MG[0-9a-f]{32}$/i.test(given))))
    throw new Error("usage: --venue <slug> [--marketing --service <MG… messaging service SID>]");
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
    if (!twilio)
      throw new Error(
        `${venue.name} hasn't connected its own Twilio account yet (Admin → Phone & texts)`,
      );
    const service = which === "marketing" ? given! : twilio.campaign.serviceSid;
    if (!service) throw new Error(`${venue.name} has no messaging service recorded`);
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
