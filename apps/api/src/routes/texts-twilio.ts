import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  connectTwilio,
  decryptSecret,
  disconnectTwilio,
  encryptSecret,
  saveTextCampaign,
  twilioIntegration,
  venueForSmsNumber,
  venueForTwilioAccount,
  type Queryable,
  type TwilioIntegration,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { TwilioRefused, TwilioStepFailed, type TwilioAdmin } from "../texts/connect.js";
import type { TwilioAccount, VenueTextSettings } from "../texts/venue.js";

/**
 * Connect your Twilio account (T-01; D123; spec 11 · Accounts). The venue's own Twilio account,
 * connected by its owner or a manager; we hold none for it.
 *   GET    /v1/venues/{v}/texts/twilio           the connection, never the token
 *   POST   /v1/venues/{v}/texts/twilio/check     the account's +1 numbers and messaging services
 *                                                (read-only at Twilio; nothing saved)
 *   POST   /v1/venues/{v}/texts/twilio           Connect (or Replace keys): the number's incoming
 *                                                texts pointed at our webhook, the number put in the
 *                                                service, the campaign read, the token kept encrypted
 *   POST   /v1/venues/{v}/texts/twilio/refresh   Check again: the campaign's status from Twilio
 *   POST   /v1/venues/{v}/texts/twilio/disconnect  Disconnect: the keys forgotten at once
 * Twilio is called outside any transaction. The bodies carry the Auth Token, so no idempotency record
 * is kept for them (not even a hash); connecting is an upsert and repeating it changes nothing.
 */
const accountSid = z
  .string()
  .trim()
  .regex(/^AC[0-9a-f]{32}$/i);
const authToken = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{32}$/i);
const keysBody = z.object({ account_sid: accountSid, auth_token: authToken }).strict();
const connectBody = keysBody
  .extend({
    number_sid: z.string().regex(/^PN[0-9a-f]{32}$/i),
    service_sid: z.string().regex(/^MG[0-9a-f]{32}$/i),
  })
  .strict();

export interface TwilioView {
  state: "not_connected" | "waiting" | "approved";
  account: { sid_last4: string; name: string | null; trial: boolean } | null;
  number: string | null;
  service_sid: string | null;
  campaign: "not_registered" | "pending" | "approved" | "rejected";
  checked_at: string | null;
  connected_at: string | null;
  /** Whether texts reach real phones now: a server that doesn't wait for the campaign, or an approved one. */
  live: boolean;
}

export function twilioView(
  twilio: TwilioIntegration | null,
  requireApprovedCampaign: boolean,
): TwilioView {
  if (!twilio)
    return {
      state: "not_connected",
      account: null,
      number: null,
      service_sid: null,
      campaign: "not_registered",
      checked_at: null,
      connected_at: null,
      live: false,
    };
  const status = twilio.campaign.status;
  return {
    state: status === "approved" ? "approved" : "waiting",
    account: {
      sid_last4: twilio.accountSid.slice(-4),
      name: twilio.accountName,
      trial: twilio.trial,
    },
    number: twilio.phoneE164,
    service_sid: twilio.campaign.serviceSid,
    campaign: status,
    checked_at: twilio.campaign.checkedAt,
    connected_at: twilio.connectedAt,
    live: !requireApprovedCampaign || status === "approved",
  };
}

/** Twilio's answer as ours: wrong keys are the person's to fix, anything else is Twilio's trouble. */
async function atTwilio<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TwilioRefused)
      throw new ApiError("invalid_request", "Twilio didn't accept those keys", {
        details: { reason: "twilio_refused" },
      });
    if (e instanceof TwilioStepFailed)
      throw new ApiError("twilio_error", `Twilio couldn't be reached (${e.step})`, {
        details: { reason: "twilio_unavailable", step: e.step },
      });
    throw e;
  }
}

/** An account or number another venue already has: refused before anything at Twilio changes. */
async function refuseInUse(c: Queryable, venueId: string, sid: string, phone: string) {
  const byAccount = await venueForTwilioAccount(c, sid);
  if (byAccount && byAccount !== venueId)
    throw new ApiError("invalid_request", "this Twilio account is connected to another venue", {
      status: 409,
      details: { reason: "account_in_use" },
    });
  const byNumber = await venueForSmsNumber(c, phone);
  if (byNumber && byNumber !== venueId)
    throw new ApiError("invalid_request", "this number is connected to another venue", {
      status: 409,
      details: { reason: "number_in_use" },
    });
}

export function textsTwilioRoutes(
  app: FastifyInstance,
  options: {
    clock: Clock;
    secretKey: Buffer;
    admin: TwilioAdmin;
    texts: Pick<VenueTextSettings, "publicApiUrl" | "requireApprovedCampaign">;
  },
): void {
  const base = {
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
  } as const;
  const read = route(base);
  // The bodies carry the Auth Token: no idempotency record, and a tight rate limit.
  const keyed = route({ ...base, idempotency: "none", rateLimit: { max: 20, windowMs: 60_000 } });
  const write = route({ ...base, idempotency: "optional" });
  const waits = options.texts.requireApprovedCampaign;

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/texts/twilio",
    { config: read },
    async (request) =>
      twilioView(await request.inVenue((c) => twilioIntegration(c, request.venueId!)), waits),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/texts/twilio/check",
    { config: keyed },
    async (request) => {
      const parsed = keysBody.safeParse(request.body);
      // The refusal names the fields, never their values.
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { account_sid, auth_token }", {
          details: { fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))] },
        });
      const account: TwilioAccount = {
        accountSid: parsed.data.account_sid,
        authToken: parsed.data.auth_token,
      };
      const info = await atTwilio(() => options.admin.account(account));
      const [numbers, services] = await atTwilio(() =>
        Promise.all([options.admin.numbers(account), options.admin.services(account)]),
      );
      return {
        account: { sid_last4: account.accountSid.slice(-4), name: info.name, trial: info.trial },
        numbers: numbers.map((n) => ({ sid: n.sid, phone_e164: n.phoneE164, name: n.name })),
        services: services.map((s) => ({ sid: s.sid, name: s.name })),
      };
    },
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/texts/twilio",
    { config: keyed },
    async (request) => {
      const parsed = connectBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { account_sid, auth_token, number_sid, service_sid }",
          { details: { fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))] } },
        );
      const venueId = request.venueId!;
      const b = parsed.data;
      const account: TwilioAccount = { accountSid: b.account_sid, authToken: b.auth_token };
      // 1. Twilio, read-only: the keys, the number and the service are this account's.
      const info = await atTwilio(() => options.admin.account(account));
      const [numbers, services] = await atTwilio(() =>
        Promise.all([options.admin.numbers(account), options.admin.services(account)]),
      );
      const number = numbers.find((n) => n.sid.toLowerCase() === b.number_sid.toLowerCase());
      if (!number)
        throw new ApiError("invalid_request", "that number isn't in this Twilio account", {
          details: { reason: "number_not_found" },
        });
      const service = services.find((s) => s.sid.toLowerCase() === b.service_sid.toLowerCase());
      if (!service)
        throw new ApiError(
          "invalid_request",
          "that messaging service isn't in this Twilio account",
          {
            details: { reason: "service_not_found" },
          },
        );
      // 2. Not another venue's account or number, before anything at Twilio changes.
      await request.inVenue((c) => refuseInUse(c, venueId, account.accountSid, number.phoneE164));
      // 3. Twilio, the writes: the number's incoming texts, the service, then the campaign.
      const key = `west4-twilio-${venueId}-${randomUUID()}`;
      if (options.texts.publicApiUrl)
        await atTwilio(() =>
          options.admin.setIncoming(
            account,
            number.sid,
            `${options.texts.publicApiUrl}/v1/hooks/twilio`,
            `${key}:incoming`,
          ),
        );
      await atTwilio(() => options.admin.joinService(account, service.sid, number.sid, key));
      const status = await atTwilio(() => options.admin.campaign(account, service.sid));
      // 4. Stored, the token encrypted.
      const saved = await request.inVenue(async (c) => {
        try {
          await connectTwilio(c, venueId, {
            accountSid: account.accountSid,
            secretEnc: encryptSecret(options.secretKey, account.authToken),
            accountName: info.name,
            trial: info.trial,
            phoneE164: number.phoneE164,
            numberSid: number.sid,
            campaign: { serviceSid: service.sid, status },
            at: options.clock.now().toString(),
          });
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw new ApiError(
              "invalid_request",
              "this account or number is connected to another venue",
              {
                status: 409,
                details: { reason: "account_in_use" },
              },
            );
          throw e;
        }
        return twilioIntegration(c, venueId);
      });
      return twilioView(saved, waits);
    },
  );

  app.post<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/texts/twilio/refresh",
    { config: write },
    async (request) => {
      const venueId = request.venueId!;
      const twilio = await request.inVenue((c) => twilioIntegration(c, venueId));
      if (!twilio?.campaign.serviceSid)
        throw new ApiError("invalid_request", "connect your Twilio account first", {
          status: 409,
          details: { reason: "not_connected" },
        });
      const serviceSid = twilio.campaign.serviceSid;
      const status = await atTwilio(() =>
        options.admin.campaign(
          {
            accountSid: twilio.accountSid,
            authToken: decryptSecret(options.secretKey, twilio.secretEnc),
          },
          serviceSid,
        ),
      );
      const saved = await request.inVenue(async (c) => {
        await saveTextCampaign(c, venueId, "service", {
          serviceSid,
          status,
          at: options.clock.now().toString(),
        });
        return twilioIntegration(c, venueId);
      });
      return twilioView(saved, waits);
    },
  );

  app.post<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/texts/twilio/disconnect",
    { config: write },
    async (request) => {
      await request.inVenue((c) => disconnectTwilio(c, request.venueId!));
      return twilioView(null, waits);
    },
  );
}
