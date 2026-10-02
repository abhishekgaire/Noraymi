import type { West4Env } from "../config.js";

/**
 * Stripe's keys and where the API sends its calls (M4-01; Stripe setup 7).
 * One restricted key per service: payments and Terminal, refunds, read-only
 * reporting, and billing (our own account only). Locally, with no keys set,
 * every call goes to the fake Stripe (`pnpm --filter @west4/api stripe:fake`),
 * which speaks the same HTTP; staging without keys does the same when
 * STRIPE_API_BASE names one, and refuses Stripe calls otherwise. Production
 * must have real keys.
 */
export type StripeService = "payments" | "refunds" | "reporting" | "billing";
export const STRIPE_SERVICES: readonly StripeService[] = [
  "payments",
  "refunds",
  "reporting",
  "billing",
];
export type StripeEndpoint = "readers" | "connect" | "platform";

export interface StripeSettings {
  /** stripe: Stripe itself; fake: our stand-in; off: no Stripe here, every call refused. */
  readonly mode: "stripe" | "fake" | "off";
  readonly apiBase: string;
  /** Production is live; everywhere else is test mode, and webhooks must match. */
  readonly livemode: boolean;
  readonly keys: Readonly<Record<StripeService, string>>;
  readonly publishableKey: string;
  /** Each webhook endpoint's own signing secret. */
  readonly webhookSecrets: Readonly<Record<StripeEndpoint, string>>;
}

export const FAKE_STRIPE_PORT = 12111;
/** The fake's keys and secrets: they only ever open the fake. */
export const FAKE_STRIPE_KEYS: Readonly<Record<StripeService, string>> = {
  payments: "rk_test_fake_payments",
  refunds: "rk_test_fake_refunds",
  reporting: "rk_test_fake_reporting",
  billing: "rk_test_fake_billing",
};
export const FAKE_WEBHOOK_SECRETS: Readonly<Record<StripeEndpoint, string>> = {
  readers: "whsec_fake_readers",
  connect: "whsec_fake_connect",
  platform: "whsec_fake_platform",
};

const PLACEHOLDER = /replace_me/;
const KEY_VARS: Readonly<Record<StripeService, string>> = {
  payments: "STRIPE_KEY_PAYMENTS",
  refunds: "STRIPE_KEY_REFUNDS",
  reporting: "STRIPE_KEY_REPORTING",
  billing: "STRIPE_KEY_BILLING",
};
const SECRET_VARS: Readonly<Record<StripeEndpoint, string>> = {
  readers: "STRIPE_WEBHOOK_SECRET_READERS",
  connect: "STRIPE_WEBHOOK_SECRET_CONNECT",
  platform: "STRIPE_WEBHOOK_SECRET_PLATFORM",
};

export function fakeStripeSettings(
  apiBase = `http://127.0.0.1:${FAKE_STRIPE_PORT}`,
): StripeSettings {
  return {
    mode: "fake",
    apiBase,
    livemode: false,
    keys: FAKE_STRIPE_KEYS,
    publishableKey: "pk_test_fake",
    webhookSecrets: FAKE_WEBHOOK_SECRETS,
  };
}

export function loadStripeSettings(
  env: West4Env,
  source: Record<string, string | undefined> = process.env,
): StripeSettings {
  const keys = Object.fromEntries(
    STRIPE_SERVICES.map((s) => [s, source[KEY_VARS[s]] ?? ""]),
  ) as Record<StripeService, string>;
  const secrets = Object.fromEntries(
    (Object.keys(SECRET_VARS) as StripeEndpoint[]).map((e) => [e, source[SECRET_VARS[e]] ?? ""]),
  ) as Record<StripeEndpoint, string>;
  const publishableKey = source["STRIPE_PUBLISHABLE_KEY"] ?? "";
  const unset =
    Object.values(keys).some((k) => !k || PLACEHOLDER.test(k)) ||
    Object.values(secrets).some((k) => !k || PLACEHOLDER.test(k)) ||
    !publishableKey ||
    PLACEHOLDER.test(publishableKey);
  if (unset) {
    if (env === "production")
      throw new Error(
        `${[...Object.values(KEY_VARS), ...Object.values(SECRET_VARS)].join(", ")} and STRIPE_PUBLISHABLE_KEY must be set`,
      );
    const base = source["STRIPE_API_BASE"];
    if (env === "local") return fakeStripeSettings(base || undefined);
    return base ? fakeStripeSettings(base) : { ...fakeStripeSettings(), mode: "off", apiBase: "" };
  }
  return {
    mode: "stripe",
    apiBase: source["STRIPE_API_BASE"] || "https://api.stripe.com",
    livemode: env === "production",
    keys,
    publishableKey,
    webhookSecrets: secrets,
  };
}
