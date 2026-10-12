import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { LOCAL_DEV_AUTH_KEY } from "@west4/db";
import { SITEVERIFY_URL, TURNSTILE_TEST } from "./captcha/turnstile.js";

/** Real-looking Turnstile keys: production refuses to start without a pair (M2-27). */
const TURNSTILE = {
  TURNSTILE_SITE_KEY: "0x4AAAAAAAsite-key-example",
  TURNSTILE_SECRET_KEY: "0x4AAAAAAAsecret-key-example",
};

describe("loadConfig · the staging switch", () => {
  it("a production build started with the staging switch refuses to start", () => {
    expect(() =>
      loadConfig({
        WEST4_ENV: "production",
        ALLOW_STAGING_FEATURES: "true",
        AUTH_SECRET_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        WEBAUTHN_RP_ID: "staff.example.com",
        WEBAUTHN_ORIGINS: "https://staff.example.com",
      }),
    ).toThrow(/refusing to start/);
  });

  it("staging and local may turn the switch on", () => {
    expect(
      loadConfig({
        WEST4_ENV: "staging",
        ALLOW_STAGING_FEATURES: "true",
        AUTH_SECRET_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }).allowStagingFeatures,
    ).toBe(true);
    expect(
      loadConfig({ WEST4_ENV: "local", ALLOW_STAGING_FEATURES: "true" }).allowStagingFeatures,
    ).toBe(true);
  });

  it("production without the switch starts, with the switch off", () => {
    const config = loadConfig({
      WEST4_ENV: "production",
      AUTH_SECRET_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      WEBAUTHN_RP_ID: "staff.example.com",
      WEBAUTHN_ORIGINS: "https://staff.example.com",
      ...TURNSTILE,
    });
    expect(config.env).toBe("production");
    expect(config.allowStagingFeatures).toBe(false);
  });

  it("only 'true' turns the switch on, and the default env is local", () => {
    expect(loadConfig({ ALLOW_STAGING_FEATURES: "1" }).allowStagingFeatures).toBe(false);
    expect(loadConfig({}).env).toBe("local");
    expect(() => loadConfig({ WEST4_ENV: "prod" })).toThrow(/WEST4_ENV must be one of/);
  });
});

describe("loadConfig · sign-in (M1-19)", () => {
  const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  it("local falls back to the development key and localhost passkeys", () => {
    const c = loadConfig({ WEST4_ENV: "local" });
    expect(c.auth.secretKey.toString("hex")).toBe(LOCAL_DEV_AUTH_KEY);
    expect(c.auth.rpId).toBe("localhost");
    expect(c.auth.origins).toContain("http://localhost:5173");
    expect(c.auth.cookieSecure).toBe(false);
    expect(c.auth.cookieSameSite).toBe("Lax");
  });
  it("refuses the development key, a missing key and a short key outside local", () => {
    expect(() => loadConfig({ WEST4_ENV: "staging", AUTH_SECRET_KEY: LOCAL_DEV_AUTH_KEY })).toThrow(
      /local development key/,
    );
    expect(() => loadConfig({ WEST4_ENV: "staging" })).toThrow(/AUTH_SECRET_KEY/);
    expect(() => loadConfig({ WEST4_ENV: "staging", AUTH_SECRET_KEY: "abc" })).toThrow(/64 hex/);
  });
  it("production needs the passkey domain and origins; cookies are Secure and SameSite=None", () => {
    expect(() => loadConfig({ WEST4_ENV: "production", AUTH_SECRET_KEY: KEY })).toThrow(
      /WEBAUTHN_RP_ID/,
    );
    expect(() =>
      loadConfig({
        WEST4_ENV: "production",
        AUTH_SECRET_KEY: KEY,
        WEBAUTHN_RP_ID: "staff.example.com",
      }),
    ).toThrow(/WEBAUTHN_ORIGINS/);
    const c = loadConfig({
      WEST4_ENV: "production",
      AUTH_SECRET_KEY: KEY,
      WEBAUTHN_RP_ID: "staff.example.com",
      WEBAUTHN_ORIGINS: "https://staff.example.com, https://app.example.com",
      ...TURNSTILE,
    });
    expect(c.auth.origins).toEqual(["https://staff.example.com", "https://app.example.com"]);
    expect(c.auth.cookieSecure).toBe(true);
    expect(c.auth.cookieSameSite).toBe("None");
  });
});

describe("loadConfig · the staff app's address (M1-23)", () => {
  it("defaults to the Vite server locally, takes STAFF_APP_URL anywhere, and is unset elsewhere until given", () => {
    expect(loadConfig({ WEST4_ENV: "local" }).staffAppUrl).toBe("http://localhost:5173");
    expect(
      loadConfig({ WEST4_ENV: "local", STAFF_APP_URL: "https://staff.example.test/" }).staffAppUrl,
    ).toBe("https://staff.example.test");
    expect(() => loadConfig({ WEST4_ENV: "local", STAFF_APP_URL: "staff.example.test" })).toThrow(
      /STAFF_APP_URL/,
    );
  });
});

describe("loadConfig · the Console (M1-35)", () => {
  const KEY = "a".repeat(64);
  it("local defaults to the Vite server and signs in by email before the key; elsewhere it's off until CONSOLE_URL is set", () => {
    const local = loadConfig({ WEST4_ENV: "local" }).console;
    expect(local).toMatchObject({ url: "http://localhost:5174", rpId: "localhost", oidc: null });
    expect(local?.origins).toEqual(["http://localhost:5174"]);
    expect(
      loadConfig({
        WEST4_ENV: "staging",
        AUTH_SECRET_KEY: KEY,
        WEBAUTHN_RP_ID: "staff.example.com",
        WEBAUTHN_ORIGINS: "https://staff.example.com",
      }).console,
    ).toBeNull();
  });

  it("takes the provider from CONSOLE_OIDC_*, binds keys to the Console's host, and production refuses a Console without a provider", () => {
    const base = {
      WEST4_ENV: "staging",
      AUTH_SECRET_KEY: KEY,
      WEBAUTHN_RP_ID: "staff.example.com",
      WEBAUTHN_ORIGINS: "https://staff.example.com",
      CONSOLE_URL: "https://console.example.com/",
    };
    const staging = loadConfig(base).console;
    expect(staging).toMatchObject({
      url: "https://console.example.com",
      rpId: "console.example.com",
      origins: ["https://console.example.com"],
      oidc: null,
    });
    const withProvider = loadConfig({
      ...base,
      CONSOLE_OIDC_ISSUER: "https://accounts.example.com/",
      CONSOLE_OIDC_CLIENT_ID: "console",
      CONSOLE_OIDC_CLIENT_SECRET: "s3cret",
    }).console;
    expect(withProvider?.oidc).toEqual({
      issuer: "https://accounts.example.com",
      clientId: "console",
      clientSecret: "s3cret",
    });
    expect(() => loadConfig({ ...base, WEST4_ENV: "production" })).toThrow(/CONSOLE_OIDC_ISSUER/);
    expect(() => loadConfig({ ...base, CONSOLE_URL: "console.example.com" })).toThrow(
      /CONSOLE_URL/,
    );
  });
});

describe("loadConfig · the public forms' CAPTCHA (M2-27)", () => {
  const PROD = {
    WEST4_ENV: "production",
    AUTH_SECRET_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    WEBAUTHN_RP_ID: "staff.example.com",
    WEBAUTHN_ORIGINS: "https://staff.example.com",
  };
  it("local and staging run on Cloudflare's always-pass test keys until real ones are set", () => {
    expect(loadConfig({}).captcha).toEqual({
      siteKey: TURNSTILE_TEST.passSiteKey,
      secretKey: TURNSTILE_TEST.passSecret,
      verifyUrl: SITEVERIFY_URL,
    });
    expect(
      loadConfig({ WEST4_ENV: "staging", AUTH_SECRET_KEY: PROD.AUTH_SECRET_KEY, ...TURNSTILE })
        .captcha.siteKey,
    ).toBe(TURNSTILE.TURNSTILE_SITE_KEY);
  });
  it("production needs real keys, never test ones, and checks only with Cloudflare", () => {
    expect(() => loadConfig(PROD)).toThrow(
      /TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are not set/,
    );
    expect(() =>
      loadConfig({
        ...PROD,
        TURNSTILE_SITE_KEY: TURNSTILE_TEST.passSiteKey,
        TURNSTILE_SECRET_KEY: TURNSTILE_TEST.passSecret,
      }),
    ).toThrow(/test keys never run in production/);
    expect(() => loadConfig({ ...PROD, ...TURNSTILE, TURNSTILE_VERIFY_URL: "http://x" })).toThrow(
      /TURNSTILE_VERIFY_URL is for tests/,
    );
    expect(loadConfig({ ...PROD, ...TURNSTILE }).captcha.secretKey).toBe(
      TURNSTILE.TURNSTILE_SECRET_KEY,
    );
  });
  it("one key without the other is a mistake anywhere", () => {
    expect(() => loadConfig({ TURNSTILE_SITE_KEY: "0x4AAAAAAAsite" })).toThrow(/set together/);
  });
});
