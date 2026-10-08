import type pg from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  accountByEmail,
  activeCredentials,
  addPasskey,
  addTotp,
  cancelOwnerRecovery,
  completeOwnerRecovery,
  countAttempt,
  countRecoveryCodes,
  createChallenge,
  decryptSecret,
  encryptSecret,
  endAllSessions,
  endSession,
  expireChallenges,
  isCoOwner,
  isOwnerAnywhere,
  markPasskeyUsed,
  membershipsOf,
  permissionOverrides,
  readSetting,
  setOwnLocale,
  statesOf,
  venueModules,
  markTotpUsed,
  newEmailCode,
  newToken,
  openChallenge,
  openOwnerRecovery,
  openSession,
  earlierSignInCountries,
  ownerRecoveryById,
  ownerRecoveryContacts,
  replaceRecoveryCodes,
  revokeCredential,
  sha256Hex,
  startOwnerRecovery,
  useChallenge,
  useRecoveryCode,
  withUser,
  withVenue,
  type AccountByEmail,
  type ChallengePurpose,
  type CredentialRow,
  type OwnerRecoveryRow,
  type Queryable,
  type RecoveryContact,
  type SessionAssurance,
  trainingOf,
} from "@west4/db";
import { Temporal, actions, moduleIds, permissionFor, stateOf, type Clock } from "@west4/shared";
import { businessDate } from "@west4/rules";
import { z } from "zod";
import type { AuthConfig } from "../config.js";
import type { EmailSettings } from "../email/settings.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { raisePage } from "../ops/paging.js";
import { enqueueEmail } from "../jobs/send-email.js";
import { SESSION_MAX_HOURS, setSessionCookie, type RequestSession } from "./session-auth.js";
import { newTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";
import { Passkeys } from "./webauthn.js";

/**
 * Sign-in for owners and managers (M1-19; spec 02 · Who can call what, spec 08 ·
 * Sign-in). The email names the account; the proof is a passkey or an
 * authenticator-app code. There are no passwords. The authenticator path
 * first sends a one-time code to the email, so it stays two steps (the
 * ticket's cautious reading, flagged for the founder).
 *
 *   POST /v1/auth/login    start (passkey options, or the emailed code) and finish (a session)
 *   POST /v1/auth/enroll   the first passkey or authenticator, after an emailed code; later ones inside a passkey session
 *   POST /v1/auth/step-up  a fresh passkey check that unlocks one guarded write (X-Step-Up)
 *   POST /v1/auth/logout   ends the session
 *   GET  /v1/auth/me       who am I, and how did I sign in
 *
 * Owner recovery (M1-20; spec 02 · Offboarding, spec 12 · 3). An owner who
 * loses every sign-in method gets back in with one of their ten single-use
 * recovery codes, or through a second owner. Either way the recovery is ready
 * 48 hours later, every owner and manager is told at once by email, and any
 * owner can cancel it before then. Once ready, the owner enrols a new passkey
 * or authenticator through POST /v1/auth/enroll as if the account were new;
 * that enrollment revokes every earlier sign-in method and session.
 *
 *   POST /v1/auth/recover               start with a recovery code (no session)
 *   POST /v1/auth/recover/second-owner  start for a co-owner, in a passkey session with a step-up
 *   POST /v1/auth/recover/cancel        an owner cancels a pending recovery
 *   POST /v1/auth/recovery-codes        a fresh set of ten codes, in a passkey session with a step-up
 */

export interface AuthRoutesOptions {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly config: AuthConfig;
  readonly email: Pick<EmailSettings, "allowList">;
}

const EMAIL_CODE_MINUTES = 10;
const CHALLENGE_MINUTES = 5;
const STEP_UP_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const RECOVERY_DELAY_HOURS = 48;
const AUTH_RATE_LIMIT = { max: 30, windowMs: 60_000 };

const email = z.string().trim().email().max(254);
const client = z.enum(["web", "desktop"]);
const credential = z.record(z.string(), z.unknown());
const sixDigits = z.string().regex(/^\d{6}$/, "six digits");
const name = z.string().trim().min(1).max(80).optional();

const loginBody = z.union([
  z
    .object({ step: z.literal("start"), method: z.enum(["passkey", "authenticator"]), email })
    .strict(),
  z
    .object({ step: z.literal("finish"), method: z.literal("passkey"), email, credential, client })
    .strict(),
  z
    .object({
      step: z.literal("finish"),
      method: z.literal("authenticator"),
      email,
      email_code: sixDigits,
      totp_code: sixDigits,
      client,
    })
    .strict(),
]);

const localeBody = z
  .object({ membership_id: z.string().uuid(), locale: z.enum(["en", "es"]) })
  .strict();

const enrollBody = z.discriminatedUnion("step", [
  z.object({ step: z.literal("start"), email }).strict(),
  z
    .object({
      step: z.literal("passkey_options"),
      email: email.optional(),
      code: sixDigits.optional(),
    })
    .strict(),
  z
    .object({
      step: z.literal("passkey_finish"),
      email: email.optional(),
      code: sixDigits.optional(),
      credential,
      name,
      client: client.optional(),
    })
    .strict(),
  z
    .object({
      step: z.literal("authenticator_start"),
      email: email.optional(),
      code: sixDigits.optional(),
    })
    .strict(),
  z
    .object({
      step: z.literal("authenticator_finish"),
      email: email.optional(),
      code: sixDigits.optional(),
      totp_code: sixDigits,
      name,
      client: client.optional(),
    })
    .strict(),
]);

const recoverBody = z.object({ email, code: z.string().trim().min(10).max(16) }).strict();
const secondOwnerBody = z.object({ email }).strict();
const cancelRecoveryBody = z.object({ recovery_id: z.string().uuid() }).strict();

const stepUpBody = z.discriminatedUnion("step", [
  z.object({ step: z.literal("start") }).strict(),
  z.object({ step: z.literal("finish"), credential }).strict(),
]);

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      "invalid_request",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  return parsed.data;
}

/**
 * The viewer's country as CloudFront adds it (the AllViewerAndCloudFrontHeaders origin request
 * policy, infra/staging/cloudfront.tf). The load balancer only takes requests carrying CloudFront's
 * origin header, so a client can't send its own. Absent locally and in tests.
 */
export const VIEWER_COUNTRY_HEADER = "cloudfront-viewer-country";
export function viewerCountry(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && /^[A-Z]{2}$/.test(v) ? v : null;
}

const signInFailed = () => new ApiError("unauthorized", "we couldn't sign you in");

export function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const { pool, clock, config } = options;
  const passkeys = new Passkeys(config);
  const now = () => clock.now();
  const at = () => now().toString();
  const inMinutes = (m: number) => now().add({ minutes: m }).toString();
  const asUser = <T>(userId: string, request: FastifyRequest, work: (c: Queryable) => Promise<T>) =>
    withUser(pool, { userId, requestId: request.requestId }, work);

  const publicRoute = route({
    principals: ["public"],
    module: "core",
    idempotency: "none",
    tokenRoute: true,
    rateLimit: AUTH_RATE_LIMIT,
  });

  // ---- shared pieces --------------------------------------------------------

  /** A 6-digit code to the account's email, replacing any earlier one for the purpose. Nothing is said when the email is unknown. */
  async function sendEmailCode(
    request: FastifyRequest,
    account: AccountByEmail,
    to: string,
    purpose: "login_email" | "enroll_email",
  ): Promise<void> {
    const code = newEmailCode();
    await withVenue(
      pool,
      { venueId: account.venueId, userId: account.userId, requestId: request.requestId },
      async (c) => {
        await expireChallenges(c, { userId: account.userId, purpose, at: at() });
        await createChallenge(c, {
          userId: account.userId,
          purpose,
          codeHash: sha256Hex(code),
          at: at(),
          expiresAt: inMinutes(EMAIL_CODE_MINUTES),
        });
        await enqueueEmail(c, options.email, {
          venueId: account.venueId,
          to,
          locale: account.locale,
          template: "sign_in_code",
          data: {
            venueName: account.venueName,
            name: account.name,
            code,
            expiresMinutes: EMAIL_CODE_MINUTES,
          },
          runAt: now(),
        });
      },
    );
  }

  /** Checks an emailed code, counting the attempt; the row is used up by the caller once the whole step succeeds. */
  async function checkEmailCode(
    c: Queryable,
    userId: string,
    purpose: "login_email" | "enroll_email",
    code: string,
  ): Promise<string> {
    const challenge = await openChallenge(c, { userId, purpose, now: at() });
    if (!challenge) throw signInFailed();
    const attempts = await countAttempt(c, challenge.id);
    if (attempts > MAX_ATTEMPTS) throw signInFailed();
    if (challenge.codeHash !== sha256Hex(code)) throw signInFailed();
    return challenge.id;
  }

  async function checkPasskey(
    c: Queryable,
    userId: string,
    purpose: ChallengePurpose,
    response: unknown,
  ): Promise<CredentialRow> {
    const challengeValue = Passkeys.challengeOf(response);
    const credentialId = Passkeys.credentialIdOf(response);
    if (!challengeValue || !credentialId) throw signInFailed();
    const challenge = await openChallenge(c, {
      userId,
      purpose,
      now: at(),
      challenge: challengeValue,
    });
    if (!challenge) throw signInFailed();
    await useChallenge(c, challenge.id, at());
    const found = (await activeCredentials(c, userId)).find(
      (k) => k.kind === "passkey" && k.credentialId === credentialId,
    );
    if (!found) throw signInFailed();
    const { newCounter } = await passkeys.verifyAuthentication({
      response,
      expectedChallenge: challenge.challenge!,
      credential: found,
    });
    await markPasskeyUsed(c, { id: found.id, signCount: newCounter, at: at() });
    return found;
  }

  async function checkTotp(c: Queryable, userId: string, code: string): Promise<CredentialRow> {
    const totps = (await activeCredentials(c, userId)).filter((k) => k.kind === "totp");
    const nowMs = now().epochMilliseconds;
    for (const k of totps) {
      const secret = decryptSecret(config.secretKey, k.secretEnc!);
      const result = verifyTotp(secret, code, nowMs, { lastAcceptedStep: k.totpLastStep });
      if (result.ok) {
        await markTotpUsed(c, { id: k.id, step: result.step, at: at() });
        return k;
      }
    }
    throw signInFailed();
  }

  async function startSession(
    request: FastifyRequest,
    reply: FastifyReply,
    account: { userId: string; name: string },
    assurance: SessionAssurance,
    clientKind: "web" | "desktop",
  ): Promise<Record<string, unknown>> {
    const country = viewerCountry(request.headers[VIEWER_COUNTRY_HEADER]);
    const opened = await asUser(account.userId, request, async (c) => {
      const session = await openSession(c, {
        userId: account.userId,
        principal: "owner_manager",
        assurance,
        client: clientKind,
        startedAt: at(),
        expiresAt: now().add({ hours: SESSION_MAX_HOURS }).toString(),
        country,
      });
      // A sign-in from a country this person hasn't signed in from before pages us (M8-19).
      if (country) {
        const before = await earlierSignInCountries(c, account.userId, session.id);
        if (before.length > 0 && !before.includes(country))
          await raisePage(
            c,
            {
              rule: "signin-new-country",
              key: `signin-new-country:${session.id}`,
              summary: `Sign-in from ${country} for user ${account.userId} (before: ${before.join(", ")})`,
            },
            now(),
          );
      }
      return session;
    });
    const body: Record<string, unknown> = {
      session: {
        id: opened.id,
        assurance,
        expires_at: now().add({ hours: SESSION_MAX_HOURS }).toString(),
      },
      user: { id: account.userId, name: account.name },
    };
    if (clientKind === "web") setSessionCookie(reply, config, opened.token);
    else body["token"] = opened.token;
    return body;
  }

  // ---- POST /v1/auth/login --------------------------------------------------

  app.post<{ Body: unknown }>("/v1/auth/login", { config: publicRoute }, async (request, reply) => {
    const body = parse(loginBody, request.body);
    const account = await accountByEmail(pool, body.email);

    if (body.step === "start") {
      if (body.method === "passkey") {
        if (!account) {
          // The same shape as a real answer, so the address can't be probed. Nothing is stored; finish will fail.
          return reply.code(200).send({
            method: "passkey",
            options: await passkeys.authenticationOptions({ allow: [] }),
          });
        }
        const opts = await asUser(account.userId, request, async (c) => {
          const options = await passkeys.authenticationOptions({
            allow: await activeCredentials(c, account.userId),
          });
          await createChallenge(c, {
            userId: account.userId,
            purpose: "login_passkey",
            challenge: options.challenge,
            at: at(),
            expiresAt: inMinutes(CHALLENGE_MINUTES),
          });
          return options;
        });
        return reply.code(200).send({ method: "passkey", options: opts });
      }
      // authenticator: the emailed code first, then the app's code
      if (account) await sendEmailCode(request, account, body.email, "login_email");
      return reply
        .code(200)
        .send({ method: "authenticator", code_sent: true, expires_minutes: EMAIL_CODE_MINUTES });
    }

    if (!account || !account.mfaRequired) throw signInFailed();
    if (body.method === "passkey") {
      await asUser(account.userId, request, (c) =>
        checkPasskey(c, account.userId, "login_passkey", body.credential),
      );
      return reply
        .code(200)
        .send(await startSession(request, reply, account, "passkey", body.client));
    }
    await asUser(account.userId, request, async (c) => {
      const challengeId = await checkEmailCode(c, account.userId, "login_email", body.email_code);
      await checkTotp(c, account.userId, body.totp_code);
      await useChallenge(c, challengeId, at());
    });
    return reply
      .code(200)
      .send(await startSession(request, reply, account, "authenticator", body.client));
  });

  // ---- POST /v1/auth/enroll -------------------------------------------------

  /**
   * Who is enrolling, and may they? Three doors:
   *   - a passkey session with a fresh step-up: add anything;
   *   - an authenticator session on an account with no passkey yet: add the first passkey (bootstrap);
   *   - no session, an emailed code, and an account with no credential at all: the very first one;
   *   - no session, an emailed code, and an owner recovery that's ready (M1-20): the fresh start.
   */
  async function enrollee(
    request: FastifyRequest,
    body: { email?: string | undefined; code?: string | undefined },
    adding: "passkey" | "totp",
  ): Promise<{
    userId: string;
    name: string;
    email: string;
    codeChallengeId: string | null;
    signedIn: boolean;
    /** True when this is the account's first credential or a recovery's fresh start: the old methods go, and an owner gets recovery codes. */
    freshStart: boolean;
    recovery: OwnerRecoveryRow | null;
  }> {
    const p = request.principal;
    if (p.kind === "user" && request.session) {
      const session = request.session;
      const me = await asUser(p.userId, request, async (c) => {
        const existing = await activeCredentials(c, p.userId);
        if (session.assurance === "passkey") {
          await consumeStepUp(c, request, session);
        } else if (session.assurance === "authenticator" && adding === "passkey") {
          if (existing.some((k) => k.kind === "passkey"))
            throw new ApiError("step_up_required", "adding another passkey needs your passkey");
        } else {
          throw new ApiError("forbidden", "adding a sign-in method needs your passkey");
        }
        const r = await c.query<{ name: string; email: string | null }>(
          "select name, email from users where id = $1",
          [p.userId],
        );
        return r.rows[0]!;
      });
      return {
        userId: p.userId,
        name: me.name,
        email: me.email ?? "",
        codeChallengeId: null,
        signedIn: true,
        freshStart: false,
        recovery: null,
      };
    }
    if (!body.email || !body.code)
      throw new ApiError("unauthorized", "sign in, or start with your email");
    const account = await accountByEmail(pool, body.email);
    if (!account) throw signInFailed();
    const door = await asUser(account.userId, request, async (c) => {
      const recovery = await readyRecovery(c, account.userId);
      const existing = await activeCredentials(c, account.userId);
      if (existing.length > 0 && !recovery) throw signInFailed(); // an enrolled account adds methods only from a session
      return {
        challengeId: await checkEmailCode(c, account.userId, "enroll_email", body.code!),
        recovery,
      };
    });
    return {
      userId: account.userId,
      name: account.name,
      email: body.email,
      codeChallengeId: door.challengeId,
      signedIn: false,
      freshStart: true,
      recovery: door.recovery,
    };
  }

  /** The account's open recovery once its 48 hours are up; null before then or when there is none. */
  async function readyRecovery(c: Queryable, userId: string): Promise<OwnerRecoveryRow | null> {
    const open = await openOwnerRecovery(c, userId);
    if (!open) return null;
    const ready =
      Temporal.Instant.compare(Temporal.Instant.from(pgInstant(open.readyAt)), now()) <= 0;
    return ready ? open : null;
  }

  /**
   * After a fresh start's first credential: a recovery completes, every other
   * sign-in method and session of the account is revoked, and an owner gets a
   * new set of recovery codes to keep (returned once, never stored).
   */
  async function finishFreshStart(
    c: Queryable,
    who: { userId: string; freshStart: boolean; recovery: OwnerRecoveryRow | null },
    keepCredentialId: string,
  ): Promise<string[] | null> {
    if (!who.freshStart) return null;
    if (who.recovery) {
      for (const k of await activeCredentials(c, who.userId))
        if (k.id !== keepCredentialId) await revokeCredential(c, k.id, at());
      await endAllSessions(c, { userId: who.userId, at: at(), reason: "revoked" });
      await completeOwnerRecovery(c, { id: who.recovery.id, at: at() });
    }
    if (!(await isOwnerAnywhere(c))) return null;
    return replaceRecoveryCodes(c, { userId: who.userId, at: at() });
  }

  app.post<{ Body: unknown }>(
    "/v1/auth/enroll",
    { config: publicRoute },
    async (request, reply) => {
      const body = parse(enrollBody, request.body);

      if (body.step === "start") {
        const account = await accountByEmail(pool, body.email);
        if (account) {
          const mayEnrol = await asUser(
            account.userId,
            request,
            async (c) =>
              (await activeCredentials(c, account.userId)).length === 0 ||
              (await readyRecovery(c, account.userId)) !== null,
          );
          if (mayEnrol) await sendEmailCode(request, account, body.email, "enroll_email");
        }
        return reply.code(200).send({ code_sent: true, expires_minutes: EMAIL_CODE_MINUTES });
      }

      if (body.step === "passkey_options") {
        const who = await enrollee(request, body, "passkey");
        const opts = await asUser(who.userId, request, async (c) => {
          const options = await passkeys.registrationOptions({
            userId: who.userId,
            userName: who.email || who.name,
            displayName: who.name,
            existing: await activeCredentials(c, who.userId),
          });
          await createChallenge(c, {
            userId: who.userId,
            purpose: "enroll_passkey",
            challenge: options.challenge,
            at: at(),
            expiresAt: inMinutes(CHALLENGE_MINUTES),
          });
          return options;
        });
        return reply.code(200).send({ options: opts });
      }

      if (body.step === "passkey_finish") {
        const who = await enrollee(request, body, "passkey");
        const challengeValue = Passkeys.challengeOf(body.credential);
        if (!challengeValue) throw signInFailed();
        const id = await asUser(who.userId, request, async (c) => {
          const challenge = await openChallenge(c, {
            userId: who.userId,
            purpose: "enroll_passkey",
            now: at(),
            challenge: challengeValue,
          });
          if (!challenge) throw signInFailed();
          await useChallenge(c, challenge.id, at());
          const verified = await passkeys.verifyRegistration({
            response: body.credential,
            expectedChallenge: challenge.challenge!,
          });
          const created = await addPasskey(c, {
            userId: who.userId,
            name: body.name ?? null,
            ...verified,
            at: at(),
          });
          if (who.codeChallengeId) await useChallenge(c, who.codeChallengeId, at());
          return { id: created, recoveryCodes: await finishFreshStart(c, who, created) };
        });
        const result: Record<string, unknown> = {
          credential: { id: id.id, kind: "passkey", name: body.name ?? null },
        };
        if (id.recoveryCodes) result["recovery_codes"] = id.recoveryCodes;
        if (!who.signedIn)
          Object.assign(
            result,
            await startSession(request, reply, who, "passkey", body.client ?? "web"),
          );
        return reply.code(201).send(result);
      }

      if (body.step === "authenticator_start") {
        const who = await enrollee(request, body, "totp");
        const secret = newTotpSecret();
        await asUser(who.userId, request, async (c) => {
          await expireChallenges(c, { userId: who.userId, purpose: "enroll_totp", at: at() });
          await createChallenge(c, {
            userId: who.userId,
            purpose: "enroll_totp",
            secretEnc: encryptSecret(config.secretKey, secret),
            at: at(),
            expiresAt: inMinutes(EMAIL_CODE_MINUTES),
          });
        });
        return reply.code(200).send({
          secret,
          otpauth_url: otpauthUrl({
            issuer: config.rpName,
            account: who.email || who.name,
            secretBase32: secret,
          }),
        });
      }

      // authenticator_finish: the app's first code proves the secret was scanned
      const who = await enrollee(request, body, "totp");
      const id = await asUser(who.userId, request, async (c) => {
        const pending = await openChallenge(c, {
          userId: who.userId,
          purpose: "enroll_totp",
          now: at(),
        });
        if (!pending?.secretEnc) throw signInFailed();
        if ((await countAttempt(c, pending.id)) > MAX_ATTEMPTS) throw signInFailed();
        const secret = decryptSecret(config.secretKey, pending.secretEnc);
        const result = verifyTotp(secret, body.totp_code, now().epochMilliseconds);
        if (!result.ok) throw signInFailed();
        await useChallenge(c, pending.id, at());
        const created = await addTotp(c, {
          userId: who.userId,
          name: body.name ?? null,
          secretEnc: pending.secretEnc,
          at: at(),
        });
        await markTotpUsed(c, { id: created, step: result.step, at: at() });
        if (who.codeChallengeId) await useChallenge(c, who.codeChallengeId, at());
        return { id: created, recoveryCodes: await finishFreshStart(c, who, created) };
      });
      const result: Record<string, unknown> = {
        credential: { id: id.id, kind: "totp", name: body.name ?? null },
      };
      if (id.recoveryCodes) result["recovery_codes"] = id.recoveryCodes;
      if (!who.signedIn)
        Object.assign(
          result,
          await startSession(request, reply, who, "authenticator", body.client ?? "web"),
        );
      return reply.code(201).send(result);
    },
  );

  // ---- POST /v1/auth/step-up ------------------------------------------------

  /** Takes the X-Step-Up token off the request, once. Without a live one the write is refused. */
  async function consumeStepUp(
    c: Queryable,
    request: FastifyRequest,
    session: RequestSession,
  ): Promise<void> {
    const raw = request.headers["x-step-up"];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token) throw new ApiError("step_up_required", "confirm with your passkey");
    const found = await openChallenge(c, {
      userId: request.principal.kind === "user" ? request.principal.userId : "",
      purpose: "step_up_token",
      now: at(),
      challenge: sha256Hex(token),
    });
    if (!found || found.sessionId !== session.id)
      throw new ApiError("step_up_required", "confirm with your passkey");
    await useChallenge(c, found.id, at());
  }

  app.post<{ Body: unknown }>(
    "/v1/auth/step-up",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        assurance: "passkey",
        idempotency: "none",
        tokenRoute: true,
        rateLimit: AUTH_RATE_LIMIT,
      }),
    },
    async (request, reply) => {
      const body = parse(stepUpBody, request.body);
      const p = request.principal;
      const session = request.session;
      if (p.kind !== "user" || !session) throw new ApiError("forbidden", "you can't call this");
      if (body.step === "start") {
        const opts = await asUser(p.userId, request, async (c) => {
          const options = await passkeys.authenticationOptions({
            allow: await activeCredentials(c, p.userId),
          });
          await createChallenge(c, {
            userId: p.userId,
            purpose: "step_up",
            challenge: options.challenge,
            sessionId: session.id,
            at: at(),
            expiresAt: inMinutes(CHALLENGE_MINUTES),
          });
          return options;
        });
        return reply.code(200).send({ options: opts });
      }
      const token = newToken();
      const expiresAt = inMinutes(STEP_UP_MINUTES);
      await asUser(p.userId, request, async (c) => {
        await checkPasskey(c, p.userId, "step_up", body.credential);
        await createChallenge(c, {
          userId: p.userId,
          purpose: "step_up_token",
          challenge: sha256Hex(token),
          sessionId: session.id,
          at: at(),
          expiresAt,
        });
      });
      return reply.code(200).send({ step_up_token: token, expires_at: expiresAt });
    },
  );

  /** The gate the conventions plugin calls on a stepUp route (M1-19). */
  app.decorate("consumeStepUp", async (request: FastifyRequest) => {
    const p = request.principal;
    const session = request.session;
    if (p.kind !== "user" || !session)
      throw new ApiError("step_up_required", "confirm with your passkey");
    await asUser(p.userId, request, (c) => consumeStepUp(c, request, session));
  });

  // ---- POST /v1/auth/logout, GET /v1/auth/me --------------------------------

  const signedIn = route({
    principals: ["staff"],
    module: "core",
    idempotency: "none",
    tokenRoute: true,
  });

  app.post("/v1/auth/logout", { config: signedIn }, async (request, reply) => {
    const p = request.principal;
    const session = request.session;
    if (p.kind === "user" && session) {
      await asUser(p.userId, request, (c) =>
        endSession(c, { id: session.id, at: at(), reason: "signed_out" }),
      );
      if (session.transport === "cookie") setSessionCookie(reply, config, null);
    }
    return reply.code(200).send({ ok: true });
  });

  /**
   * Everything the staff app shell needs in one call (M1-21): the person, the
   * session, and for each venue they work at its name, clock, their language
   * (memberships.locale), which modules are on and which actions their role
   * may take there. server_time is the venue's clock, so screens never read
   * the device's.
   */
  app.get("/v1/auth/me", { config: signedIn }, async (request, reply) => {
    const p = request.principal;
    const session = request.session;
    if (p.kind !== "user" || !session) throw new ApiError("forbidden", "you can't call this");
    const me = await asUser(p.userId, request, async (c) => {
      const r = await c.query<{ name: string; email: string | null }>(
        "select name, email from users where id = $1",
        [p.userId],
      );
      const creds = await activeCredentials(c, p.userId);
      const owner = await isOwnerAnywhere(c);
      return {
        ...r.rows[0]!,
        homes: await membershipsOf(c, p.userId),
        recoveryCodesLeft: owner ? await countRecoveryCodes(c, p.userId) : null,
        credentials: creds.map((k) => ({
          id: k.id,
          kind: k.kind,
          name: k.name,
          created_at: k.createdAt,
          last_used_at: k.lastUsedAt,
        })),
      };
    });
    const memberships = [];
    for (const m of p.memberships) {
      const home = me.homes.find((h) => h.membershipId === m.membershipId);
      if (!home) continue;
      const venue = await withVenue(
        pool,
        { venueId: m.venueId, userId: p.userId, requestId: request.requestId },
        async (c) => ({
          overrides: await permissionOverrides(c, m.venueId),
          states: statesOf(await venueModules(c, m.venueId)),
          // Training mode (M7-03): the person's, or the device this session runs on.
          training: await trainingOf(c, m.venueId, {
            membershipId: m.membershipId,
            deviceIds: [session.deviceId, request.signedDevice?.deviceId],
          }),
        }),
      );
      memberships.push({
        venue_id: m.venueId,
        membership_id: m.membershipId,
        role: m.role,
        locale: home.locale,
        venue: {
          id: home.venueId,
          name: home.venueName,
          time_zone: home.timeZone,
          day_cutover: home.dayCutover,
        },
        modules: Object.fromEntries(moduleIds.map((id) => [id, stateOf(venue.states, id)])),
        permissions: actions.filter((a) => permissionFor(venue.overrides, m.role, a).allowed),
        training: venue.training,
      });
    }
    return reply.code(200).send({
      user: { id: p.userId, name: me.name, email: me.email },
      session: { id: session.id, assurance: session.assurance, expires_at: session.expiresAt },
      memberships,
      credentials: me.credentials,
      recovery_codes_left: me.recoveryCodesLeft,
      server_time: now().toString(),
    });
  });

  /**
   * The person's own language (spec 02 · Languages, spec 10 · rule 11): saved
   * on their membership, from the languages the venue offers. Anyone signed in
   * may change their own; Admin → Team changes other people's (M1-23).
   */
  app.patch<{ Body: unknown }>("/v1/auth/me", { config: signedIn }, async (request, reply) => {
    const p = request.principal;
    if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
    const body = parse(localeBody, request.body);
    const m = p.memberships.find((x) => x.membershipId === body.membership_id);
    if (!m) throw new ApiError("not_found", "that membership isn't yours");
    await withVenue(
      pool,
      { venueId: m.venueId, userId: p.userId, requestId: request.requestId },
      async (c) => {
        const venue = (
          await c.query<{ time_zone: string; day_cutover: string }>(
            "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
            [m.venueId],
          )
        ).rows[0]!;
        const today = businessDate(now(), venue.time_zone, venue.day_cutover).businessDate;
        const offered = (await readSetting(c, m.venueId, "languages", today))?.value.staff ?? [
          "en",
          "es",
        ];
        if (!offered.includes(body.locale))
          throw new ApiError(
            "invalid_request",
            `this venue's staff languages are ${offered.join(", ")}`,
          );
        if (!(await setOwnLocale(c, m.membershipId, p.userId, body.locale)))
          throw new ApiError("not_found", "that membership isn't yours");
      },
    );
    return reply.code(200).send({ membership_id: m.membershipId, locale: body.locale });
  });

  // ---- Owner recovery (M1-20) ------------------------------------------------

  const ownerPasskeyStepUp = route({
    principals: ["owner_manager"],
    module: "core",
    assurance: "passkey",
    stepUp: true,
    idempotency: "none",
    tokenRoute: true,
    rateLimit: AUTH_RATE_LIMIT,
  });
  const ownerPasskey = route({
    principals: ["owner_manager"],
    module: "core",
    assurance: "passkey",
    idempotency: "none",
    tokenRoute: true,
    rateLimit: AUTH_RATE_LIMIT,
  });

  const recoveryBody = (r: OwnerRecoveryRow) => ({
    id: r.id,
    method: r.method,
    requested_at: pgInstant(r.requestedAt),
    ready_at: pgInstant(r.readyAt),
    delay_hours: RECOVERY_DELAY_HOURS,
  });

  /**
   * Tells every owner and manager at every venue the person owns, at once. One
   * transaction per recipient, so one refused address (the staging allow-list)
   * doesn't silence the others; the owner's own address is told too.
   */
  async function noticeRecovery(
    request: FastifyRequest,
    ownerId: string,
    ownerName: string,
    recovery: OwnerRecoveryRow,
    contacts: readonly RecoveryContact[],
    requesterName: string | null,
  ): Promise<number> {
    const readyAt = Temporal.Instant.from(pgInstant(recovery.readyAt));
    let sent = 0;
    for (const to of contacts) {
      if (!to.email) continue;
      try {
        await withVenue(
          pool,
          { venueId: to.venueId, userId: ownerId, requestId: request.requestId },
          (c) =>
            enqueueEmail(c, options.email, {
              venueId: to.venueId,
              to: to.email!,
              locale: to.locale,
              template: "owner_recovery_notice",
              data: {
                venueName: to.venueName,
                name: to.name,
                ownerName,
                method: recovery.method,
                ...(requesterName ? { requesterName } : {}),
                readyAt: new Intl.DateTimeFormat(to.locale, {
                  timeZone: to.timeZone,
                  dateStyle: "full",
                  timeStyle: "short",
                }).format(new Date(readyAt.epochMilliseconds)),
              },
              runAt: now(),
              dedupeKey: `owner-recovery:${recovery.id}:${to.userId}:${to.venueId}`,
            }),
        );
        sent += 1;
      } catch (error) {
        request.log.warn({ err: error, venueId: to.venueId }, "owner recovery notice not queued");
      }
    }
    return sent;
  }

  /** Starts (or returns the already open) recovery for an owner, then sends the notices. */
  async function beginRecovery(
    request: FastifyRequest,
    owner: { userId: string; name: string },
    method: "recovery_code" | "second_owner",
    requester: { userId: string; name: string } | null,
  ): Promise<{ recovery: OwnerRecoveryRow; notices: number }> {
    const { recovery, contacts } = await asUser(owner.userId, request, async (c) => {
      const contacts = await ownerRecoveryContacts(c, owner.userId);
      if (contacts.length === 0) throw new ApiError("forbidden", "recovery is for owners");
      const open = await openOwnerRecovery(c, owner.userId);
      if (open) return { recovery: open, contacts: [] as RecoveryContact[] };
      const started = await startOwnerRecovery(c, {
        userId: owner.userId,
        method,
        requestedBy: requester?.userId ?? null,
        at: at(),
        readyAt: now().add({ hours: RECOVERY_DELAY_HOURS }).toString(),
      });
      return { recovery: started, contacts };
    });
    const notices = await noticeRecovery(
      request,
      owner.userId,
      owner.name,
      recovery,
      contacts,
      requester?.name ?? null,
    );
    return { recovery, notices };
  }

  app.post<{ Body: unknown }>(
    "/v1/auth/recover",
    { config: publicRoute },
    async (request, reply) => {
      const body = parse(recoverBody, request.body);
      const codeFailed = () => new ApiError("unauthorized", "that recovery code didn't work");
      const account = await accountByEmail(pool, body.email);
      if (!account) throw codeFailed();
      // The code is spent before anything else: it works once, whatever happens next.
      const spent = await asUser(account.userId, request, (c) =>
        useRecoveryCode(c, { userId: account.userId, code: body.code, at: at() }),
      );
      if (!spent) throw codeFailed();
      const { recovery } = await beginRecovery(request, account, "recovery_code", null);
      return reply.code(202).send({ recovery: recoveryBody(recovery) });
    },
  );

  app.post<{ Body: unknown }>(
    "/v1/auth/recover/second-owner",
    { config: ownerPasskeyStepUp },
    async (request, reply) => {
      const body = parse(secondOwnerBody, request.body);
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const target = await accountByEmail(pool, body.email);
      const me = await asUser(p.userId, request, async (c) => {
        if (!target || target.userId === p.userId || !(await isCoOwner(c, target.userId)))
          return null;
        const r = await c.query<{ name: string }>("select name from users where id = $1", [
          p.userId,
        ]);
        return { userId: p.userId, name: r.rows[0]!.name };
      });
      if (!target || !me)
        throw new ApiError("forbidden", "only a second owner of the same venue can start this");
      const { recovery } = await beginRecovery(request, target, "second_owner", me);
      return reply.code(202).send({ recovery: recoveryBody(recovery) });
    },
  );

  app.post<{ Body: unknown }>(
    "/v1/auth/recover/cancel",
    { config: ownerPasskey },
    async (request, reply) => {
      const body = parse(cancelRecoveryBody, request.body);
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      // The owner it concerns and their co-owners may cancel; anyone else sees nothing (the policy hides it too).
      const cancelled = await asUser(p.userId, request, async (c) => {
        const found = await ownerRecoveryById(c, body.recovery_id);
        if (!found || (found.userId !== p.userId && !(await isCoOwner(c, found.userId))))
          throw new ApiError("not_found", "no such recovery");
        if (found.completedAt || found.cancelledAt)
          throw new ApiError("version_conflict", "that recovery is already over");
        await cancelOwnerRecovery(c, { id: found.id, by: p.userId, at: at() });
        return found;
      });
      return reply.code(200).send({ recovery: { ...recoveryBody(cancelled), cancelled: true } });
    },
  );

  app.post("/v1/auth/recovery-codes", { config: ownerPasskeyStepUp }, async (request, reply) => {
    const p = request.principal;
    if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
    const codes = await asUser(p.userId, request, async (c) => {
      if (!(await isOwnerAnywhere(c)))
        throw new ApiError("forbidden", "recovery codes are for owners");
      return replaceRecoveryCodes(c, { userId: p.userId, at: at() });
    });
    return reply.code(201).send({ recovery_codes: codes });
  });
}

/** Postgres writes "2026-09-26 02:41:00+00"; the API answers "2026-09-26T02:41:00Z". */
function pgInstant(text: string): string {
  return Temporal.Instant.from(text).toString();
}

declare module "fastify" {
  interface FastifyInstance {
    /** Set by authRoutes: takes the request's X-Step-Up token, once, or throws step_up_required. */
    consumeStepUp?: (request: FastifyRequest) => Promise<void>;
  }
}
