import { optedOut, twilioIntegration, type Queryable } from "@west4/db";
import type { VenueTextSettings } from "./venue.js";

/**
 * Whether a venue's texts are live (T-03; D123): its own Twilio account is connected and, on a
 * server that waits for one (production), its service campaign is approved. With a number, also
 * whether that number may get a text: +1 only, on staging's allow list, and not opted out. Until
 * then the caller sends by email, a push, or not at all; never from an account of ours.
 */
export type LiveSettings = Pick<VenueTextSettings, "requireApprovedCampaign" | "allowList">;

/** Local development and tests that don't say: a connection is enough, every +1 number allowed. */
export const LOCAL_TEXTS: LiveSettings = { requireApprovedCampaign: false, allowList: null };

export async function textsLive(
  c: Queryable,
  venueId: string,
  settings: LiveSettings,
  to?: string,
): Promise<boolean> {
  if (to !== undefined) {
    if (!/^\+1\d{10}$/.test(to)) return false;
    if (settings.allowList && !settings.allowList.includes(to)) return false;
  }
  const twilio = await twilioIntegration(c, venueId);
  if (!twilio) return false;
  if (settings.requireApprovedCampaign && twilio.campaign.status !== "approved") return false;
  if (to !== undefined && (await optedOut(c, venueId, to))) return false;
  return true;
}
