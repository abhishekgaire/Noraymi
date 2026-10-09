import type { West4Env } from "../config.js";

/**
 * Google Business Profile (M5-15): our OAuth client, from the environment
 * only. With no client set, locally (or wherever GOOGLE_API_BASE names one)
 * every call goes to the fake Google (`pnpm --filter @west4/api google:fake`),
 * which speaks the same HTTP; elsewhere Google is off, and Admin shows it as
 * not set up. Only Google's published APIs are called.
 */
export interface GoogleSettings {
  /** google: Google itself; fake: our stand-in; off: no client, nothing connects. */
  readonly mode: "google" | "fake" | "off";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly endpoints: GoogleEndpoints;
}

export interface GoogleEndpoints {
  readonly authorize: string;
  readonly token: string;
  /** Account Management API (the accounts the signed-in Google user manages). */
  readonly accounts: string;
  /** Business Information API (locations and their hours). */
  readonly info: string;
}

export const FAKE_GOOGLE_PORT = 12112;
export const SCOPE = "https://www.googleapis.com/auth/business.manage";

const GOOGLE: GoogleEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  accounts: "https://mybusinessaccountmanagement.googleapis.com/v1",
  info: "https://mybusinessbusinessinformation.googleapis.com/v1",
};

export function fakeGoogleSettings(base = `http://127.0.0.1:${FAKE_GOOGLE_PORT}`): GoogleSettings {
  return {
    mode: "fake",
    clientId: "fake-client",
    clientSecret: "fake-secret",
    endpoints: {
      authorize: `${base}/o/oauth2/v2/auth`,
      token: `${base}/token`,
      accounts: `${base}/v1`,
      info: `${base}/v1`,
    },
  };
}

const PLACEHOLDER = /replace_me/;

export function loadGoogleSettings(
  env: West4Env,
  source: Record<string, string | undefined> = process.env,
): GoogleSettings {
  const clientId = source["GOOGLE_CLIENT_ID"] ?? "";
  const clientSecret = source["GOOGLE_CLIENT_SECRET"] ?? "";
  const base = source["GOOGLE_API_BASE"] ?? "";
  if (!clientId || !clientSecret || PLACEHOLDER.test(clientId + clientSecret)) {
    if (env === "production") return { ...fakeGoogleSettings(), mode: "off" };
    if (env === "local") return fakeGoogleSettings(base || undefined);
    return base ? fakeGoogleSettings(base) : { ...fakeGoogleSettings(), mode: "off" };
  }
  return { mode: "google", clientId, clientSecret, endpoints: GOOGLE };
}
