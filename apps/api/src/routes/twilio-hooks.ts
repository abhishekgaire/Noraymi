import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  decryptSecret,
  emitEvent,
  markMessage,
  recordWebhookEvent,
  twilioIntegration,
  venueForTwilioAccount,
  withVenue,
} from "@west4/db";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { validTwilioSignature } from "../texts/venue.js";

/**
 * `POST /v1/hooks/twilio/status` (M2-09): Twilio's status callback for a guest
 * text. The subaccount names the venue; its auth token checks the signature
 * before anything else; the event runs once through `webhook_events`; and the
 * message moves to sent, delivered or failed, never backwards.
 */
const STATUS = {
  sent: "sent",
  delivered: "delivered",
  failed: "failed",
  undelivered: "failed",
} as const;

export function twilioHookRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; secretKey: Buffer; publicApiUrl: string | null },
): void {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  app.post<{ Body: Record<string, string> }>(
    "/v1/hooks/twilio/status",
    { config: route({ principals: ["public"], module: "core", idempotency: "none" }) },
    async (request, reply) => {
      const params = request.body ?? {};
      const accountSid = params["AccountSid"];
      if (!accountSid) throw new ApiError("forbidden", "not a Twilio callback");
      const venueId = await venueForTwilioAccount(options.pool, accountSid);
      if (!venueId) throw new ApiError("forbidden", "not a Twilio callback");
      const url = `${options.publicApiUrl ?? `${request.protocol}://${request.headers.host}`}${request.url}`;
      const ok = await withVenue(
        options.pool,
        { venueId, requestId: request.requestId },
        async (c) => {
          const twilio = await twilioIntegration(c, venueId);
          if (!twilio) return false;
          const sig = request.headers["x-twilio-signature"];
          return validTwilioSignature(
            decryptSecret(options.secretKey, twilio.secretEnc),
            url,
            params,
            typeof sig === "string" ? sig : undefined,
          );
        },
      );
      if (!ok) throw new ApiError("forbidden", "the signature doesn't match");
      const sid = params["MessageSid"];
      const status = STATUS[params["MessageStatus"] as keyof typeof STATUS];
      if (!sid || !status) return reply.code(204).send(); // queued, accepted, sending: nothing to record
      await withVenue(options.pool, { venueId, requestId: request.requestId }, async (c) => {
        const first = await recordWebhookEvent(c, venueId, {
          provider: "twilio",
          eventId: `${sid}:${params["MessageStatus"]}`,
          type: "message.status",
          payload: { sid, status: params["MessageStatus"], error: params["ErrorCode"] ?? null },
        });
        if (!first) return;
        const moved = await markMessage(c, venueId, { sid }, status);
        if (moved?.changed)
          await emitEvent(c, {
            venueId,
            type: "message.updated",
            entityId: moved.id,
            entityVersion: 0,
          });
      });
      return reply.code(204).send();
    },
  );
}
