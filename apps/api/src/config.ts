import {
  LOCAL_DEV_AUTH_KEY,
  appDatabaseUrl,
  reportsDatabaseUrl,
  generateSigningKey,
  parseAuthSecretKey,
} from "@west4/db";

export type West4Env = "local" | "staging" | "production";

export interface Config {
  readonly env: West4Env;
  /**
   * The staging-only switch (M1-02). When on, the simulated clock (M1-06) and
   * the demo PINs (M1-23) are allowed. A production build refuses to start
   * with it on.
   */
  readonly allowStagingFeatures: boolean;
  readonly port: number;
  readonly host: string;
  /** The app_rw connection: behind the venue wall, never the table owner. */
  readonly databaseUrl: string;
  /** Reports' read replica (M8-21), as app_rw; null: reports read the primary. */
  readonly reportsDatabaseUrl?: string | null;
  /** Where invite links open: the staff app's public URL (M1-23). Unset outside local until the app has a hostname. */
  readonly staffAppUrl: string | null;
  /** GUEST_APP_URL: the guest site, where a room's join link opens (M2-11). Local defaults to the Next server. */
  readonly guestAppUrl: string | null;
  /** PAY_APP_URL: the payment page's own origin (M4-15), where a bill's "Pay another way" opens. */
  readonly payAppUrl: string | null;
  /** Sign-in (M1-19): the key that seals authenticator secrets, and the passkey relying party. */
  readonly auth: AuthConfig;
  /** The Console's settings, or null where CONSOLE_URL isn't set yet (then the Console's routes don't exist). */
  readonly console: ConsoleConfig | null;
  /** RULE_PACK_SIGNING_KEY: the key service's Ed25519 private key (PEM); local makes a throwaway one. */
  readonly rulePackSigningKey: string | null;
}

/**
 * The Console (M1-35): our staff's tool on its own hostname. Security keys are
 * bound to that hostname. Single sign-on is any OpenID Connect provider
 * (CONSOLE_OIDC_ISSUER, _CLIENT_ID, _CLIENT_SECRET); with none set, local
 * development signs in by email alone before the key step, and staging and
 * production refuse to start without a provider.
 */
export interface ConsoleConfig {
  /** CONSOLE_URL: where the Console is served; the SSO callback returns here. */
  readonly url: string;
  readonly rpId: string;
  readonly origins: readonly string[];
  readonly oidc: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
  } | null;
}

export interface AuthConfig {
  /** AUTH_SECRET_KEY, 32 bytes. Local falls back to a fixed development key; anywhere else it must be set. */
  readonly secretKey: Buffer;
  /** WEBAUTHN_RP_ID: the domain passkeys are bound to (the staff app's host). Null until it's set outside local. */
  readonly rpId: string | null;
  readonly rpName: string;
  /** WEBAUTHN_ORIGINS: the origins a passkey ceremony may come from, comma-separated. */
  readonly origins: readonly string[];
  /** Session cookies: Secure everywhere but local; SameSite=None when the staff app is on another site. */
  readonly cookieSecure: boolean;
  readonly cookieSameSite: "Lax" | "None" | "Strict";
}

const ENVS: readonly West4Env[] = ["local", "staging", "production"];

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const rawEnv = source["WEST4_ENV"] ?? "local";
  if (!ENVS.includes(rawEnv as West4Env)) {
    throw new Error(`WEST4_ENV must be one of ${ENVS.join(", ")}, got ${JSON.stringify(rawEnv)}`);
  }
  const env = rawEnv as West4Env;
  const allowStagingFeatures = source["ALLOW_STAGING_FEATURES"] === "true";
  if (allowStagingFeatures && env === "production") {
    throw new Error(
      "ALLOW_STAGING_FEATURES is on but WEST4_ENV is production: refusing to start. " +
        "The simulated clock and the demo PINs never run against real money.",
    );
  }
  return {
    env,
    allowStagingFeatures,
    port: Number(source["PORT"] ?? 3000),
    host: source["HOST"] ?? "127.0.0.1",
    databaseUrl: appDatabaseUrl(source),
    reportsDatabaseUrl: reportsDatabaseUrl(source),
    staffAppUrl: staffAppUrl(env, source),
    guestAppUrl: guestAppUrl(env, source),
    payAppUrl: payAppUrl(env, source),
    auth: loadAuthConfig(env, source),
    console: loadConsoleConfig(env, source),
    rulePackSigningKey:
      source["RULE_PACK_SIGNING_KEY"] ||
      (env === "local" ? generateSigningKey().privateKeyPem : null),
  };
}

export function loadAuthConfig(
  env: West4Env,
  source: Record<string, string | undefined>,
): AuthConfig {
  const rawKey = source["AUTH_SECRET_KEY"] ?? (env === "local" ? LOCAL_DEV_AUTH_KEY : undefined);
  if (env !== "local" && rawKey === LOCAL_DEV_AUTH_KEY)
    throw new Error(
      "AUTH_SECRET_KEY is the local development key: refusing to start outside local",
    );
  const secretKey = parseAuthSecretKey(rawKey);
  const rpId = source["WEBAUTHN_RP_ID"] ?? (env === "local" ? "localhost" : null);
  if (env === "production" && !rpId) throw new Error("WEBAUTHN_RP_ID is not set");
  const rawOrigins =
    source["WEBAUTHN_ORIGINS"] ??
    (env === "local" ? "http://localhost:5173,http://localhost:5174,http://localhost:3000" : "");
  const origins = rawOrigins
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (rpId && origins.length === 0) throw new Error("WEBAUTHN_ORIGINS is not set");
  const sameSite = source["SESSION_COOKIE_SAME_SITE"] ?? (env === "local" ? "Lax" : "None");
  if (sameSite !== "Lax" && sameSite !== "None" && sameSite !== "Strict")
    throw new Error("SESSION_COOKIE_SAME_SITE must be Lax, None or Strict");
  return {
    secretKey,
    rpId,
    rpName: source["WEBAUTHN_RP_NAME"] ?? "West 4 staff app",
    origins,
    cookieSecure: env !== "local",
    cookieSameSite: sameSite,
  };
}

function staffAppUrl(env: West4Env, source: Record<string, string | undefined>): string | null {
  const raw = source["STAFF_APP_URL"] ?? (env === "local" ? "http://localhost:5173" : undefined);
  if (!raw) return null;
  if (!/^https?:\/\//.test(raw)) throw new Error("STAFF_APP_URL must be an http(s) URL");
  return raw.replace(/\/+$/, "");
}

export function loadConsoleConfig(
  env: West4Env,
  source: Record<string, string | undefined>,
): ConsoleConfig | null {
  const raw = source["CONSOLE_URL"] ?? (env === "local" ? "http://localhost:5174" : undefined);
  if (!raw) return null;
  if (!/^https?:\/\//.test(raw)) throw new Error("CONSOLE_URL must be an http(s) URL");
  const url = raw.replace(/\/+$/, "");
  const issuer = source["CONSOLE_OIDC_ISSUER"];
  const clientId = source["CONSOLE_OIDC_CLIENT_ID"];
  const clientSecret = source["CONSOLE_OIDC_CLIENT_SECRET"];
  const oidc =
    issuer && clientId && clientSecret
      ? { issuer: issuer.replace(/\/+$/, ""), clientId, clientSecret }
      : null;
  // Production needs a provider. Staging may run without one until it's chosen: the API starts,
  // and the Console's sign-in says single sign-on isn't configured (no local stub outside local).
  if (!oidc && env === "production")
    throw new Error(
      "CONSOLE_OIDC_ISSUER, CONSOLE_OIDC_CLIENT_ID and CONSOLE_OIDC_CLIENT_SECRET are not set: the Console needs single sign-on in production",
    );
  return { url, rpId: source["CONSOLE_RP_ID"] ?? new URL(url).hostname, origins: [url], oidc };
}

function payAppUrl(env: West4Env, source: Record<string, string | undefined>): string | null {
  const raw = source["PAY_APP_URL"] ?? (env === "local" ? "http://pay.localhost:3001" : undefined);
  if (!raw) return null;
  if (!/^https?:\/\//.test(raw)) throw new Error("PAY_APP_URL must be an http(s) URL");
  return raw.replace(/\/+$/, "");
}

function guestAppUrl(env: West4Env, source: Record<string, string | undefined>): string | null {
  const raw = source["GUEST_APP_URL"] ?? (env === "local" ? "http://localhost:3001" : undefined);
  if (!raw) return null;
  if (!/^https?:\/\//.test(raw)) throw new Error("GUEST_APP_URL must be an http(s) URL");
  return raw.replace(/\/+$/, "");
}
