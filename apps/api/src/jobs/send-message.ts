import { z } from "zod";
import {
  claimSendAttempt,
  decryptSecret,
  emitEvent,
  markMessage,
  messageById,
  optedOut,
  recordProviderSid,
  stopMessage,
  twilioIntegration,
  type JobHandler,
} from "@west4/db";
import type { VenueTextClient, VenueTextSettings } from "../texts/venue.js";

/**
 * Sends one guest text (M2-09). The attempt is claimed in its own committed
 * transaction before Twilio is called, so a retried job (after a crash, a
 * timeout, anything) never sends twice: it finds the attempt taken and stops.
 * Twilio's callbacks move the message on from `sending`.
 */
const payload = z.object({ message_id: z.string().uuid() }).strict();

export function makeSendMessageHandler(
  client: VenueTextClient,
  settings: Pick<VenueTextSettings, "publicApiUrl">,
  secretKey: Buffer,
): JobHandler {
  return async ({ job, clock, step }) => {
    const { message_id } = payload.parse(job.payload);
    const venueId = job.venue_id;
    const ready = await step(async (c) => {
      const message = await messageById(c, venueId, message_id);
      if (!message) return null;
      const twilio = await twilioIntegration(c, venueId);
      if (!twilio) {
        // No number yet (the subaccount is set up once, by us): the text can't go, and staff see it failed.
        await markMessage(c, venueId, { id: message_id }, "failed");
        await emitEvent(c, {
          venueId,
          type: "message.updated",
          entityId: message_id,
          entityVersion: 0,
        });
        return null;
      }
      // An opt-out stops every text to the number at once, even one queued before it (M2-23).
      if (!message.stop_confirmation && (await optedOut(c, venueId, message.phone_e164))) {
        if (await stopMessage(c, venueId, message_id))
          await emitEvent(c, {
            venueId,
            type: "message.updated",
            entityId: message_id,
            entityVersion: 0,
          });
        return null;
      }
      if (!(await claimSendAttempt(c, venueId, message_id, clock.now().toString()))) return null;
      return { message, twilio };
    });
    if (!ready) return; // sent, or tried, before: never twice
    let sid: string;
    try {
      ({ sid } = await client.send(
        {
          accountSid: ready.twilio.accountSid,
          authToken: decryptSecret(secretKey, ready.twilio.secretEnc),
        },
        {
          to: ready.message.phone_e164,
          from: ready.twilio.phoneE164,
          messagingServiceSid:
            ready.message.category === "marketing"
              ? ready.twilio.marketingCampaign.serviceSid
              : ready.twilio.campaign.serviceSid,
          body: ready.message.body,
          statusCallback: settings.publicApiUrl
            ? `${settings.publicApiUrl}/v1/hooks/twilio/status`
            : null,
        },
      ));
    } catch (error) {
      // The attempt stays claimed, so no retry sends it; the message shows as failed for staff to call.
      await step(async (c) => {
        await markMessage(c, venueId, { id: message_id }, "failed");
        await emitEvent(c, {
          venueId,
          type: "message.updated",
          entityId: message_id,
          entityVersion: 0,
        });
      });
      throw error;
    }
    await step(async (c) => {
      await recordProviderSid(c, venueId, message_id, sid, clock.now().toString());
      await emitEvent(c, {
        venueId,
        type: "message.updated",
        entityId: message_id,
        entityVersion: 0,
      });
    });
  };
}
