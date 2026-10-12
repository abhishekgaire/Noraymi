import { randomUUID } from "node:crypto";

/**
 * The server-checked CAPTCHA (M2-27, D109; Security 8): Cloudflare Turnstile.
 * The guest page (and the staff invite page) shows Cloudflare's widget, which
 * hands back a one-time token; the API checks that token with Cloudflare's
 * siteverify before any waitlist join, phone code, booking hold or enquiry is
 * made, and never inside a database transaction.
 *
 * Keys come only from the environment: TURNSTILE_SITE_KEY (public, shown to
 * the widget through GET /v1/public/captcha) and TURNSTILE_SECRET_KEY (never
 * logged, never sent anywhere but siteverify). Local, staging and the tests
 * fall back to Cloudflare's published test keys, which need no account;
 * production refuses to start without real keys, or with test ones.
 */

/** Cloudflare's published test keys (developers.cloudflare.com/turnstile/troubleshooting/testing). */
export const TURNSTILE_TEST = {
  /** A visible widget that always passes. */
  passSiteKey: "1x00000000000000000000AA",
  /** A visible widget that always blocks. */
  blockSiteKey: "2x00000000000000000000AB",
  /** Accepts the test widgets' dummy token. */
  passSecret: "1x0000000000000000000000000000000AA",
  /** Refuses every token. */
  failSecret: "2x0000000000000000000000000000000AA",
  /** Answers every token as already spent. */
  spentSecret: "3x0000000000000000000000000000000AA",
  /** What a test site key's widget hands back; only a test secret accepts it. */
  token: "XXXX.DUMMY.TOKEN.XXXX",
} as const;

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const TEST_SECRETS: readonly string[] = [
  TURNSTILE_TEST.passSecret,
  TURNSTILE_TEST.failSecret,
  TURNSTILE_TEST.spentSecret,
];
const TEST_SITE_KEY = /^[123]x0{20}[A-Z]{2}$/;

export interface CaptchaConfig {
  readonly siteKey: string;
  /** Never logged: it reaches only siteverify's request body. */
  readonly secretKey: string;
  /** Cloudflare's siteverify, or TURNSTILE_VERIFY_URL: a stand-in the integration tests start. */
  readonly verifyUrl: string;
}

export function loadCaptchaConfig(
  env: "local" | "staging" | "production",
  source: Record<string, string | undefined>,
): CaptchaConfig {
  const siteKey = source["TURNSTILE_SITE_KEY"]?.trim() || null;
  const secretKey = source["TURNSTILE_SECRET_KEY"]?.trim() || null;
  const verifyUrl = source["TURNSTILE_VERIFY_URL"]?.trim() || SITEVERIFY_URL;
  if ((siteKey === null) !== (secretKey === null))
    throw new Error("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set together, or neither");
  if (env === "production") {
    if (!siteKey || !secretKey)
      throw new Error(
        "TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are not set: the public forms need the CAPTCHA in production",
      );
    if (TEST_SECRETS.includes(secretKey) || TEST_SITE_KEY.test(siteKey))
      throw new Error("Cloudflare's Turnstile test keys never run in production");
    if (verifyUrl !== SITEVERIFY_URL)
      throw new Error("TURNSTILE_VERIFY_URL is for tests: production checks with Cloudflare");
  }
  return {
    siteKey: siteKey ?? TURNSTILE_TEST.passSiteKey,
    secretKey: secretKey ?? TURNSTILE_TEST.passSecret,
    verifyUrl,
  };
}

export type CaptchaResult =
  | { readonly ok: true }
  /** unavailable: siteverify couldn't be reached or answered oddly; the guest may simply try again. */
  | { readonly ok: false; readonly unavailable: boolean; readonly codes: readonly string[] };

export type CaptchaVerifier = (token: string, remoteIp: string | null) => Promise<CaptchaResult>;

const TIMEOUT_MS = 5_000;

/**
 * Checks one token. With one of Cloudflare's test secrets and no stand-in, the
 * answer is the one Cloudflare documents for that secret (the pass secret takes
 * only the dummy token), so the demo and the tests never call out; anything
 * else goes to siteverify with an idempotency key.
 */
export function turnstileVerifier(
  config: CaptchaConfig,
  fetchImpl: typeof fetch = fetch,
): CaptchaVerifier {
  const local = config.verifyUrl === SITEVERIFY_URL && TEST_SECRETS.includes(config.secretKey);
  return async (token, remoteIp) => {
    if (!token) return { ok: false, unavailable: false, codes: ["missing-input-response"] };
    if (token.length > 2048)
      return { ok: false, unavailable: false, codes: ["invalid-input-response"] };
    if (local) {
      if (config.secretKey === TURNSTILE_TEST.spentSecret)
        return { ok: false, unavailable: false, codes: ["timeout-or-duplicate"] };
      if (config.secretKey === TURNSTILE_TEST.passSecret && token === TURNSTILE_TEST.token)
        return { ok: true };
      return { ok: false, unavailable: false, codes: ["invalid-input-response"] };
    }
    let response: Response;
    try {
      response = await fetchImpl(config.verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: config.secretKey,
          response: token,
          ...(remoteIp ? { remoteip: remoteIp } : {}),
          idempotency_key: randomUUID(),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, unavailable: true, codes: ["unreachable"] };
    }
    if (!response.ok) return { ok: false, unavailable: true, codes: [`http-${response.status}`] };
    const body = (await response.json().catch(() => null)) as {
      success?: unknown;
      "error-codes"?: unknown;
    } | null;
    if (!body || typeof body.success !== "boolean")
      return { ok: false, unavailable: true, codes: ["bad-response"] };
    if (body.success) return { ok: true };
    const codes = Array.isArray(body["error-codes"])
      ? body["error-codes"].filter((c): c is string => typeof c === "string")
      : [];
    // Our own key or request being wrong isn't the guest's fault: say so as unavailable.
    const ours = codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret");
    return { ok: false, unavailable: ours || codes.includes("internal-error"), codes };
  };
}
