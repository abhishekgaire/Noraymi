import { assertOutsideTransaction, type CampaignStatus } from "@west4/db";
import type { TwilioAccount } from "./venue.js";

/**
 * A venue's 10DLC campaign status, read from Twilio (M8-22; spec 11 ·
 * Accounts). The brand and campaign are registered through Twilio's own
 * 10DLC process in its console; we only read back what the carriers decided,
 * from the messaging service the venue's number sits in. Never inside a
 * database transaction.
 */
export async function readCampaignStatus(
  account: TwilioAccount,
  serviceSid: string,
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<CampaignStatus> {
  assertOutsideTransaction("text");
  const base = options.baseUrl ?? "https://messaging.twilio.com";
  const response = await (options.fetchImpl ?? fetch)(
    `${base}/v1/Services/${encodeURIComponent(serviceSid)}/Compliance/Usa2p`,
    {
      headers: {
        authorization: `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`,
      },
    },
  );
  if (!response.ok) throw new Error(`Twilio answered ${response.status} for the campaign`);
  const body = (await response.json()) as { compliance?: { campaign_status?: string }[] };
  return campaignStatusOf(body.compliance?.map((c) => c.campaign_status ?? "") ?? []);
}

/** Twilio's campaign states as ours: only VERIFIED lets texts go. */
export function campaignStatusOf(states: readonly string[]): CampaignStatus {
  if (states.length === 0) return "not_registered";
  if (states.some((s) => s === "VERIFIED")) return "approved";
  if (states.every((s) => s === "FAILED" || s === "SUSPENDED")) return "rejected";
  return "pending";
}
