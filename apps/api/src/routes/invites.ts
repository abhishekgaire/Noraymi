import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  codesEqual,
  createChallenge,
  createPhoneCode,
  createStaffPhone,
  inviteByToken,
  markInviteUsed,
  markPhoneVerified,
  pinVerifier,
  setPinVerifier,
  sha256Hex,
  tryPhoneCode,
  withVenue,
  type InviteByToken,
} from "@west4/db";
import { pinProblem, type Clock } from "@west4/shared";
import type { PublicFormGuard } from "../captcha/guard.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { enqueueText } from "../jobs/send-text.js";
import { enqueueEmail } from "../jobs/send-email.js";
import type { EmailSettings } from "../email/settings.js";
import { LOCAL_TEXTS, textsLive, type LiveSettings } from "../texts/live.js";

/**
 * The invite link on the person's own phone (M1-23, spec 02 · PINs, N25).
 * No session: the token is the key, hashed before it's looked up, and every
 * route here is rate-limited and sends no-store headers. The steps: confirm
 * the phone number with a texted code (once, behind the CAPTCHA and the daily
 * limits on phone codes, M2-27; emailed to the invite's address instead while
 * the venue's own texts aren't live, T-03), choose a PIN and the language,
 * and claim the phone as the person's staff_phone. Owners and managers get a
 * one-time code to enrol a passkey through /v1/auth/enroll.
 */
export const PHONE_CODE_MINUTES = 10;
export const PHONE_CODE_MAX_TRIES = 5;
const ENROL_CODE_MINUTES = 15;

type TokenParams = { token: string };

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "an E.164 number");
const phoneBody = z.object({ phone_e164: e164 }).strict();
const verifyBody = z.object({ phone_e164: e164, code: z.string().regex(/^\d{6}$/) }).strict();
const finishBody = z
  .object({
    pin: z.string().max(6),
    locale: z.enum(["en", "es"]),
    phone_name: z.string().trim().min(1).max(80).optional(),
    public_key: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** "mina@example.com" as "m•••@example.com". */
const maskEmail = (email: string) => {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
};

const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export function invitesRoutes(
  app: FastifyInstance,
  options: {
    pool: pg.Pool;
    clock: Clock;
    pepper: Buffer;
    forms: PublicFormGuard;
    /** Whether a venue's own texts are live (T-03); the tests' default is a connection being enough. */
    texts?: LiveSettings;
    email?: Pick<EmailSettings, "allowList">;
  },
): void {
  const publicToken = route({
    principals: ["public"],
    module: "core",
    idempotency: "none",
    tokenRoute: true,
    rateLimit: { max: 30, windowMs: 60_000 },
  });

  const state = (invite: InviteByToken): "open" | "used" | "replaced" | "expired" => {
    if (invite.replacedAt) return "replaced";
    if (invite.usedAt) return "used";
    return invite.expiresAt <= options.clock.now().toString() ? "expired" : "open";
  };

  const openInvite = async (token: string): Promise<InviteByToken> => {
    const invite = await inviteByToken(options.pool, sha256Hex(token));
    if (!invite) throw new ApiError("not_found", "this link isn't valid");
    const s = state(invite);
    if (s !== "open") throw new ApiError("forbidden", `this link is ${s}`);
    return invite;
  };

  app.get<{ Params: TokenParams }>(
    "/v1/invites/:token",
    { config: publicToken },
    async (request) => {
      const invite = await inviteByToken(options.pool, sha256Hex(request.params.token));
      if (!invite) throw new ApiError("not_found", "this link isn't valid");
      return {
        state: state(invite),
        venue_name: invite.venueName,
        name: invite.name,
        role: invite.role,
        pin_digits: invite.pinDigits,
        locale: invite.locale,
        phone_verified: invite.phoneVerified,
        needs_passkey: invite.role === "owner" || invite.role === "manager",
        // How the phone code will come (T-03): by text from the venue's own live texts, else by email.
        code_by: (await withVenue(options.pool, { venueId: invite.venueId }, (c) =>
          textsLive(c, invite.venueId, options.texts ?? LOCAL_TEXTS, undefined, "staffCodes"),
        ))
          ? "text"
          : "email",
      };
    },
  );

  app.post<{ Params: TokenParams; Body: unknown }>(
    "/v1/invites/:token/phone",
    { config: publicToken },
    async (request, reply) => {
      const { token: captcha, body } = options.forms.split(request.body);
      const parsed = phoneBody.safeParse(body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { phone_e164, captcha_token }");
      const invite = await openInvite(request.params.token);
      // The CAPTCHA, then the daily limits on phone codes (M2-27), before any text.
      const caller = await options.forms.check(request, reply, captcha);
      const code = sixDigits();
      const now = options.clock.now();
      const sentBy = await withVenue(
        options.pool,
        { venueId: invite.venueId, userId: invite.userId, requestId: request.requestId },
        async (c): Promise<"text" | "email"> => {
          // The venue's own texts (T-03; D123), or the invite's email until they're live.
          const live = await textsLive(
            c,
            invite.venueId,
            options.texts ?? LOCAL_TEXTS,
            parsed.data.phone_e164,
            "staffCodes",
          );
          if (!live && !invite.email)
            throw new ApiError(
              "invalid_request",
              "this venue can't text codes yet · ask for an invite by email",
              { status: 409, details: { reason: "texts_not_live" } },
            );
          await options.forms.use(
            c,
            invite.venueId,
            "phoneCode",
            caller,
            { phoneE164: parsed.data.phone_e164 },
            now,
          );
          await createPhoneCode(c, {
            venueId: invite.venueId,
            membershipId: invite.membershipId,
            phoneE164: parsed.data.phone_e164,
            codeHash: sha256Hex(code),
            expiresAt: now.add({ minutes: PHONE_CODE_MINUTES }).toString(),
          });
          if (live) {
            await enqueueText(c, {
              venueId: invite.venueId,
              runAt: now,
              template: "phone_code",
              to: parsed.data.phone_e164,
              locale: invite.locale,
              data: { venueName: invite.venueName, code, minutes: PHONE_CODE_MINUTES },
            });
            return "text";
          }
          await enqueueEmail(c, options.email ?? { allowList: null }, {
            venueId: invite.venueId,
            runAt: now,
            to: invite.email!,
            locale: invite.locale,
            template: "sign_in_code",
            data: {
              venueName: invite.venueName,
              name: invite.name,
              code,
              expiresMinutes: PHONE_CODE_MINUTES,
            },
          });
          return "email";
        },
      );
      return reply.code(200).send({
        code_sent: true,
        sent_by: sentBy,
        // Where the emailed code went, shown masked ("m•••@example.com").
        ...(sentBy === "email" ? { email_hint: maskEmail(invite.email!) } : {}),
        expires_minutes: PHONE_CODE_MINUTES,
      });
    },
  );

  app.post<{ Params: TokenParams; Body: unknown }>(
    "/v1/invites/:token/phone/verify",
    { config: publicToken },
    async (request, reply) => {
      const parsed = verifyBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { phone_e164, code }");
      const invite = await openInvite(request.params.token);
      await withVenue(
        options.pool,
        { venueId: invite.venueId, userId: invite.userId, requestId: request.requestId },
        async (c) => {
          const open = await tryPhoneCode(
            c,
            invite.venueId,
            invite.membershipId,
            parsed.data.phone_e164,
            options.clock.now().toString(),
          );
          if (!open) throw new ApiError("invalid_request", "ask for a new code");
          if (open.attempts > PHONE_CODE_MAX_TRIES)
            throw new ApiError("invalid_request", "too many tries · ask for a new code");
          if (!codesEqual(open.codeHash, sha256Hex(parsed.data.code)))
            throw new ApiError("invalid_request", "that code didn't work");
          await markPhoneVerified(
            c,
            invite.venueId,
            open.id,
            invite.userId,
            parsed.data.phone_e164,
          );
        },
      );
      return reply.code(200).send({ verified: true });
    },
  );

  app.post<{ Params: TokenParams; Body: unknown }>(
    "/v1/invites/:token/finish",
    { config: publicToken },
    async (request, reply) => {
      const parsed = finishBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { pin, locale, public_key? }");
      const invite = await openInvite(request.params.token);
      if (!invite.phoneVerified) throw new ApiError("forbidden", "confirm your phone number first");
      const problem = pinProblem(parsed.data.pin, invite.pinDigits);
      if (problem) throw new ApiError("invalid_request", `pin: ${problem}`);
      const verifier = await pinVerifier(
        options.pepper,
        invite.venueId,
        invite.membershipId,
        parsed.data.pin,
      );
      const needsPasskey = invite.role === "owner" || invite.role === "manager";
      const enrolCode = needsPasskey ? sixDigits() : null;
      const now = options.clock.now();
      const deviceId = await withVenue(
        options.pool,
        { venueId: invite.venueId, userId: invite.userId, requestId: request.requestId },
        async (c) => {
          await setPinVerifier(
            c,
            invite.venueId,
            invite.membershipId,
            verifier,
            parsed.data.locale,
          );
          await markInviteUsed(c, invite.venueId, invite.inviteId);
          let id: string | null = null;
          if (parsed.data.public_key) {
            const device = await createStaffPhone(c, {
              venueId: invite.venueId,
              userId: invite.userId,
              name: parsed.data.phone_name ?? "Phone",
              publicJwk: parsed.data.public_key,
            });
            id = device.id;
          }
          if (enrolCode) {
            // The same door /v1/auth/enroll opens with an emailed code: here the invite itself is the proof.
            await createChallenge(c, {
              userId: invite.userId,
              purpose: "enroll_email",
              codeHash: sha256Hex(enrolCode),
              at: now.toString(),
              expiresAt: now.add({ minutes: ENROL_CODE_MINUTES }).toString(),
            });
          }
          return id;
        },
      );
      return reply.code(200).send({
        done: true,
        venue_id: invite.venueId,
        device_id: deviceId,
        email: invite.email,
        enrol_code: enrolCode,
      });
    },
  );
}
