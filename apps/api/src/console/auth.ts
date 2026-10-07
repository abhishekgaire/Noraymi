import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  resolveSupportGrant,
  addConsoleKey,
  bumpConsoleKeyCounter,
  consoleKeys,
  consoleStaffByEmail,
  consoleStaffById,
  consoleStaffForSso,
  createConsoleChallenge,
  createSsoState,
  endConsoleSession,
  openConsoleSession,
  resolveConsoleSession,
  takeConsoleChallenge,
  takeSsoState,
  type ConsoleStaff,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import type { Config, ConsoleConfig } from "../config.js";
import { route, type Authenticator } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { Principal } from "../http/principal.js";

/**
 * Console sign-in (M1-35; spec 12 · 7): single sign-on, then a FIDO2 security
 * key, every time. Step one names the person (OpenID Connect in staging and
 * production; by email alone in local development) and leaves a ten-minute
 * cookie that opens nothing but step two. Step two is a WebAuthn ceremony on
 * a cross-platform authenticator: the first sign-in enrols the key, later
 * ones assert it, and a platform passkey (a phone or laptop) is refused. Only
 * step two opens a session. Signing in without a key therefore fails.
 */
export const CONSOLE_COOKIE = "west4_console";
const SSO_COOKIE = "west4_console_sso";
const SSO_MINUTES = 10;
const CHALLENGE_MINUTES = 5;
export const CONSOLE_SESSION_HOURS = 12;
export const CONSOLE_IDLE_MINUTES = 30;

const b64u = (b: Buffer) => b.toString("base64url");

function cookie(
  reply: FastifyReply,
  config: Config,
  name: string,
  value: string | null,
  maxAgeSeconds: number,
): void {
  const parts = [
    `${name}=${value === null ? "" : encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${config.auth.cookieSameSite}`,
    `Max-Age=${value === null ? 0 : maxAgeSeconds}`,
  ];
  if (config.auth.cookieSecure || config.auth.cookieSameSite === "None") parts.push("Secure");
  const existing = reply.getHeader("Set-Cookie");
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  reply.header("Set-Cookie", [...list, parts.join("; ")]);
}

function cookieOf(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** The SSO step's proof: staff id and expiry, signed with the server key. */
function signSso(config: Config, staffId: string, expiresAtMs: number): string {
  const body = `${staffId}.${expiresAtMs}`;
  const sig = createHmac("sha256", config.auth.secretKey).update(`console-sso:${body}`).digest();
  return `${body}.${b64u(sig)}`;
}

function readSso(config: Config, value: string | null, nowMs: number): string | null {
  if (!value) return null;
  const [staffId, exp, sig] = value.split(".");
  if (!staffId || !exp || !sig) return null;
  const expected = createHmac("sha256", config.auth.secretKey)
    .update(`console-sso:${staffId}.${exp}`)
    .digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Number(exp) < nowMs) return null;
  return staffId;
}

export function consoleAuthenticator(pool: pg.Pool, clock: Clock): Authenticator {
  return async (request) => {
    const token = cookieOf(request, CONSOLE_COOKIE);
    if (!token) return undefined;
    const resolved = await resolveConsoleSession(pool, {
      token,
      now: clock.now().toString(),
      idleMinutes: CONSOLE_IDLE_MINUTES,
    });
    if (!resolved) return undefined;
    (request as FastifyRequest & { consoleSessionId?: string }).consoleSessionId =
      resolved.sessionId;
    const asSupport = await supportPrincipal(pool, clock, request, resolved.staff.id);
    if (asSupport) return asSupport;
    return {
      kind: "console",
      staffId: resolved.staff.id,
      name: resolved.staff.name,
      email: resolved.staff.email,
    };
  };
}

/** The header a Console session sends to work under a support grant (M8-10). */
export const SUPPORT_GRANT_HEADER = "x-support-grant";

/**
 * A Console session that names an open support grant on a venue route acts as
 * the support principal there (spec 02 · Support access): our staff member,
 * the grant and the grant's venue. A grant that isn't open (waiting, declined,
 * ended, revoked, or someone else's) leaves the caller a plain Console session,
 * which no venue route declares.
 */
export async function supportPrincipal(
  pool: pg.Pool,
  clock: Clock,
  request: FastifyRequest,
  staffId: string,
): Promise<Principal | undefined> {
  const grantId = request.headers[SUPPORT_GRANT_HEADER];
  if (typeof grantId !== "string" || !request.url.startsWith("/v1/venues/")) return undefined;
  const venueId = await resolveSupportGrant(pool, {
    grantId,
    staffId,
    at: clock.now().toString(),
  });
  return venueId ? { kind: "support", staffId, grantId, venueId } : undefined;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export function consoleAuthRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; config: Config; console: ConsoleConfig },
): void {
  const { pool, clock, config } = options;
  const console_ = options.console;
  const pub = route({ principals: ["public"], module: "core", idempotency: "none" });
  const signedIn = route({ principals: ["console"], module: "core", idempotency: "none" });
  let discovery: Discovery | null = null;

  const discover = async (): Promise<Discovery> => {
    if (discovery) return discovery;
    if (!console_.oidc) throw new ApiError("internal", "single sign-on isn't configured");
    const r = await fetch(`${console_.oidc.issuer}/.well-known/openid-configuration`);
    if (!r.ok) throw new ApiError("internal", "the sign-on provider didn't answer");
    discovery = (await r.json()) as Discovery;
    return discovery;
  };

  const nowMs = () => clock.now().epochMilliseconds;
  const ssoCookie = (reply: FastifyReply, staffId: string) =>
    cookie(
      reply,
      config,
      SSO_COOKIE,
      signSso(config, staffId, nowMs() + SSO_MINUTES * 60_000),
      SSO_MINUTES * 60,
    );

  /** What the sign-in page needs to know: which first step this server runs. */
  app.get("/v1/console/auth/config", { config: pub }, async () => ({
    sso: console_.oidc ? "oidc" : "local",
  }));

  // Step one, staging and production: OpenID Connect, authorization code with PKCE.
  app.get("/v1/console/auth/sso/start", { config: pub }, async (_request, reply) => {
    const d = await discover();
    const state = b64u(randomBytes(24));
    const verifier = b64u(randomBytes(32));
    const challenge = b64u(createHash("sha256").update(verifier).digest());
    await createSsoState(pool, {
      state,
      verifier,
      expiresAt: new Date(nowMs() + SSO_MINUTES * 60_000).toISOString(),
    });
    const url = new URL(d.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", console_.oidc!.clientId);
    url.searchParams.set("redirect_uri", `${console_.url}/v1/console/auth/sso/callback`);
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return reply.redirect(url.toString(), 302);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/v1/console/auth/sso/callback",
    { config: pub },
    async (request, reply) => {
      const back = (problem: string | null) =>
        reply.redirect(`${console_.url}/${problem ? `?error=${problem}` : "#key"}`, 302);
      const { code, state } = request.query;
      if (!code || !state) return back("sso_denied");
      const verifier = await takeSsoState(pool, { state, now: new Date(nowMs()).toISOString() });
      if (!verifier) return back("sso_state");
      const d = await discover();
      const tokenAnswer = await fetch(d.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${console_.url}/v1/console/auth/sso/callback`,
          client_id: console_.oidc!.clientId,
          client_secret: console_.oidc!.clientSecret,
          code_verifier: verifier,
        }),
      });
      if (!tokenAnswer.ok) return back("sso_token");
      const tokens = (await tokenAnswer.json()) as { access_token?: string };
      if (!tokens.access_token) return back("sso_token");
      const info = await fetch(d.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      if (!info.ok) return back("sso_userinfo");
      const claims = (await info.json()) as { sub?: string; email?: string };
      if (!claims.sub) return back("sso_userinfo");
      const staff = await consoleStaffForSso(pool, {
        subject: claims.sub,
        email: claims.email ?? null,
      });
      if (!staff) return back("not_ours");
      ssoCookie(reply, staff.id);
      return back(null);
    },
  );

  // Step one, local development only: the email of an active account stands in for the provider.
  if (config.env === "local" && !console_.oidc) {
    app.post<{ Body: { email?: string } }>(
      "/v1/console/auth/local",
      { config: pub },
      async (request, reply) => {
        const email = request.body?.email?.trim();
        if (!email) throw new ApiError("invalid_request", "send { email }");
        const staff = await consoleStaffByEmail(pool, email);
        if (!staff) throw new ApiError("forbidden", "that email isn't one of our staff accounts");
        ssoCookie(reply, staff.id);
        return { staff: { id: staff.id, name: staff.name, email: staff.email } };
      },
    );
  }

  const staffFromSso = async (request: FastifyRequest): Promise<ConsoleStaff> => {
    const staffId = readSso(config, cookieOf(request, SSO_COOKIE), nowMs());
    const staff = staffId ? await consoleStaffById(pool, staffId) : null;
    if (!staff || !staff.active)
      throw new ApiError("unauthorized", "sign in with single sign-on first");
    return staff;
  };

  const isHardwareKey = (attachment: unknown, transports: readonly string[] | null): boolean =>
    attachment !== "platform" &&
    !(transports ?? []).some((t) => t === "internal" || t === "hybrid");

  // Step two: the security key. Enrol on the first sign-in, assert after that.
  app.post<{ Body: { step?: string; credential?: unknown; name?: string } }>(
    "/v1/console/auth/key",
    { config: pub },
    async (request, reply) => {
      const staff = await staffFromSso(request);
      const keys = await consoleKeys(pool, staff.id);
      const now = new Date(nowMs());
      const expiresAt = new Date(now.getTime() + CHALLENGE_MINUTES * 60_000).toISOString();
      const step = request.body?.step;
      if (step === "start") {
        if (keys.length === 0) {
          const opts = await generateRegistrationOptions({
            rpName: "Console",
            rpID: console_.rpId,
            userName: staff.email,
            userDisplayName: staff.name,
            attestationType: "none",
            authenticatorSelection: {
              authenticatorAttachment: "cross-platform",
              userVerification: "required",
              residentKey: "discouraged",
            },
          });
          await createConsoleChallenge(pool, {
            staffId: staff.id,
            purpose: "register",
            challenge: opts.challenge,
            expiresAt,
          });
          return { mode: "register", options: opts };
        }
        const opts = await generateAuthenticationOptions({
          rpID: console_.rpId,
          userVerification: "required",
          allowCredentials: keys.map((k) => ({
            id: k.credentialId,
            ...(k.transports ? { transports: k.transports as never } : {}),
          })),
        });
        await createConsoleChallenge(pool, {
          staffId: staff.id,
          purpose: "login",
          challenge: opts.challenge,
          expiresAt,
        });
        return { mode: "login", options: opts };
      }
      if (step !== "finish" || !request.body?.credential)
        throw new ApiError(
          "invalid_request",
          "send { step: 'start' } or { step: 'finish', credential }",
        );
      const credential = request.body.credential as Record<string, unknown>;
      const response = (credential["response"] ?? {}) as Record<string, unknown>;
      if (keys.length === 0 || "attestationObject" in response) {
        const challenge = await takeConsoleChallenge(pool, {
          staffId: staff.id,
          purpose: "register",
          now: now.toISOString(),
        });
        if (!challenge) throw new ApiError("invalid_request", "start the key step again");
        const verified = await verifyRegistrationResponse({
          response: credential as unknown as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: [...console_.origins],
          expectedRPID: console_.rpId,
          requireUserVerification: true,
        }).catch(() => null);
        if (!verified?.verified || !verified.registrationInfo)
          throw new ApiError("forbidden", "that key didn't verify");
        const info = verified.registrationInfo.credential;
        if (!isHardwareKey(credential["authenticatorAttachment"], info.transports ?? null))
          throw new ApiError(
            "forbidden",
            "the Console needs a FIDO2 security key, not a phone or laptop passkey",
          );
        await addConsoleKey(pool, {
          staffId: staff.id,
          credentialId: info.id,
          publicKey: Buffer.from(info.publicKey).toString("base64url"),
          signCount: info.counter,
          transports: info.transports ?? null,
          name: request.body.name?.trim() || null,
        });
      } else {
        const challenge = await takeConsoleChallenge(pool, {
          staffId: staff.id,
          purpose: "login",
          now: now.toISOString(),
        });
        if (!challenge) throw new ApiError("invalid_request", "start the key step again");
        const key = keys.find((k) => k.credentialId === credential["id"]);
        if (!key) throw new ApiError("forbidden", "that key isn't enrolled");
        const verified = await verifyAuthenticationResponse({
          response: credential as unknown as AuthenticationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: [...console_.origins],
          expectedRPID: console_.rpId,
          requireUserVerification: true,
          credential: {
            id: key.credentialId,
            publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64url")),
            counter: key.signCount,
            ...(key.transports ? { transports: key.transports as never } : {}),
          },
        }).catch(() => null);
        if (!verified?.verified) throw new ApiError("forbidden", "that key didn't verify");
        await bumpConsoleKeyCounter(pool, key.id, verified.authenticationInfo.newCounter);
      }
      const opened = await openConsoleSession(pool, {
        staffId: staff.id,
        startedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CONSOLE_SESSION_HOURS * 3_600_000).toISOString(),
      });
      cookie(reply, config, SSO_COOKIE, null, 0);
      cookie(reply, config, CONSOLE_COOKIE, opened.token, CONSOLE_SESSION_HOURS * 3600);
      return reply
        .code(201)
        .send({ staff: { id: staff.id, name: staff.name, email: staff.email } });
    },
  );

  app.get("/v1/console/auth/me", { config: signedIn }, async (request) => {
    const p = request.principal;
    if (p.kind !== "console") throw new ApiError("forbidden", "you can't call this");
    return { staff: { id: p.staffId, name: p.name, email: p.email } };
  });

  app.post("/v1/console/auth/logout", { config: signedIn }, async (request, reply) => {
    const id = (request as FastifyRequest & { consoleSessionId?: string }).consoleSessionId;
    if (id) await endConsoleSession(pool, id, new Date(nowMs()).toISOString());
    cookie(reply, config, CONSOLE_COOKIE, null, 0);
    return reply.code(204).send();
  });
}
