import type pg from "pg";
import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveSession, type SessionAssurance } from "@west4/db";
import type { Clock } from "@west4/shared";
import type { AuthConfig } from "../config.js";
import type { Authenticator } from "../http/conventions.js";
import type { Principal, StaffRole } from "../http/principal.js";

/** Sessions last 12 hours and lock after 30 idle minutes (spec 02). */
export const SESSION_MAX_HOURS = 12;
export const SESSION_IDLE_MINUTES = 30;
export const SESSION_COOKIE = "west4_session";

export interface RequestSession {
  readonly id: string;
  readonly assurance: SessionAssurance;
  readonly expiresAt: string;
  /** Where the token came from, so sign-out can clear the right one. */
  readonly transport: "cookie" | "bearer";
  /** A PIN or badge session's membership and the device it was opened on (M1-24); null for a passkey session. */
  readonly membershipId: string | null;
  readonly deviceId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in session behind this request, if any. */
    session: RequestSession | undefined;
    /** A session token was sent but the session is locked or over: the 403 becomes a 401 that says so. */
    sessionProblem: "locked" | "expired" | undefined;
  }
}

/** The token from the cookie (web) or the Authorization header (desktop app). */
export function sessionTokenOf(
  request: FastifyRequest,
): { token: string; transport: "cookie" | "bearer" } | null {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return { token, transport: "bearer" };
  }
  const cookie = request.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === SESSION_COOKIE) {
        const token = decodeURIComponent(part.slice(eq + 1).trim());
        if (token) return { token, transport: "cookie" };
      }
    }
  }
  return null;
}

export function setSessionCookie(
  reply: FastifyReply,
  config: AuthConfig,
  token: string | null,
): void {
  const parts = [
    `${SESSION_COOKIE}=${token === null ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${config.cookieSameSite}`,
    `Max-Age=${token === null ? 0 : SESSION_MAX_HOURS * 3600}`,
  ];
  if (config.cookieSecure || config.cookieSameSite === "None") parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

/**
 * The session authenticator (M1-19): a request with a session cookie or a
 * bearer token becomes the person behind it, with every active membership
 * they hold. The session's idle and total limits are checked on the venue's
 * clock, so tests and staging can move time.
 */
export function sessionAuthenticator(pool: pg.Pool, clock: Clock): Authenticator {
  return async (request: FastifyRequest): Promise<Principal | undefined> => {
    const found = sessionTokenOf(request);
    if (!found) return undefined;
    const resolved = await resolveSession(pool, {
      token: found.token,
      now: clock.now().toString(),
      idleMinutes: SESSION_IDLE_MINUTES,
      maxHours: SESSION_MAX_HOURS,
    });
    if (!resolved) return undefined; // an unknown token is simply anonymous
    if (resolved.state !== "ok") {
      request.sessionProblem = resolved.state === "locked" ? "locked" : "expired";
      return undefined;
    }
    request.session = {
      id: resolved.sessionId,
      assurance: resolved.assurance,
      expiresAt: resolved.expiresAt,
      transport: found.transport,
      membershipId: resolved.membershipId,
      deviceId: resolved.deviceId,
    };
    return {
      kind: "user",
      userId: resolved.userId,
      session: resolved.assurance,
      memberships: resolved.memberships.map((m) => ({
        venueId: m.venueId,
        membershipId: m.membershipId,
        role: m.role as StaffRole,
      })),
    };
  };
}
