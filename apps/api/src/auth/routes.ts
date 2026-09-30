import type pg from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  accountByEmail,
  activeCredentials,
  addPasskey,
  addTotp,
  countAttempt,
  createChallenge,
  decryptSecret,
  encryptSecret,
  endSession,
  expireChallenges,
  markPasskeyUsed,
  markTotpUsed,
  newEmailCode,
  newToken,
  openChallenge,
  openSession,
  sha256Hex,
  useChallenge,
  withUser,
  withVenue,
  type AccountByEmail,
  type ChallengePurpose,
  type CredentialRow,
  type Queryable,
  type SessionAssurance,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import type { AuthConfig } from "../config.js";
import type { EmailSettings } from "../email/settings.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
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
    const opened = await asUser(account.userId, request, (c) =>
      openSession(c, {
        userId: account.userId,
        principal: "owner_manager",
        assurance,
        client: clientKind,
        startedAt: at(),
        expiresAt: now().add({ hours: SESSION_MAX_HOURS }).toString(),
      }),
    );
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
   *   - no session, an emailed code, and an account with no credential at all: the very first one.
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
      };
    }
    if (!body.email || !body.code)
      throw new ApiError("unauthorized", "sign in, or start with your email");
    const account = await accountByEmail(pool, body.email);
    if (!account) throw signInFailed();
    const challengeId = await asUser(account.userId, request, async (c) => {
      const existing = await activeCredentials(c, account.userId);
      if (existing.length > 0) throw signInFailed(); // an enrolled account adds methods only from a session
      return checkEmailCode(c, account.userId, "enroll_email", body.code!);
    });
    return {
      userId: account.userId,
      name: account.name,
      email: body.email,
      codeChallengeId: challengeId,
      signedIn: false,
    };
  }

  app.post<{ Body: unknown }>(
    "/v1/auth/enroll",
    { config: publicRoute },
    async (request, reply) => {
      const body = parse(enrollBody, request.body);

      if (body.step === "start") {
        const account = await accountByEmail(pool, body.email);
        if (account) {
          const existing = await asUser(account.userId, request, (c) =>
            activeCredentials(c, account.userId),
          );
          if (existing.length === 0)
            await sendEmailCode(request, account, body.email, "enroll_email");
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
          return created;
        });
        const result: Record<string, unknown> = {
          credential: { id, kind: "passkey", name: body.name ?? null },
        };
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
        return created;
      });
      const result: Record<string, unknown> = {
        credential: { id, kind: "totp", name: body.name ?? null },
      };
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
      return {
        ...r.rows[0]!,
        credentials: creds.map((k) => ({
          id: k.id,
          kind: k.kind,
          name: k.name,
          created_at: k.createdAt,
          last_used_at: k.lastUsedAt,
        })),
      };
    });
    return reply.code(200).send({
      user: { id: p.userId, name: me.name, email: me.email },
      session: { id: session.id, assurance: session.assurance, expires_at: session.expiresAt },
      memberships: p.memberships.map((m) => ({
        venue_id: m.venueId,
        membership_id: m.membershipId,
        role: m.role,
      })),
      credentials: me.credentials,
    });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    /** Set by authRoutes: takes the request's X-Step-Up token, once, or throws step_up_required. */
    consumeStepUp?: (request: FastifyRequest) => Promise<void>;
  }
}
