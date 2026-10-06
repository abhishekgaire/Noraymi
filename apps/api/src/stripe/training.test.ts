import { describe, expect, it, vi } from "vitest";
import { StripeClient, StripeMisuse } from "./client.js";
import {
  FAKE_SANDBOX_KEYS,
  LIVE_KEY,
  fakeSandboxSettings,
  fakeStripeSettings,
  loadStripeSandboxSettings,
  type StripeSettings,
} from "./settings.js";

/**
 * Practice payments only reach Stripe's sandbox (M7-04; Security and data
 * retention 15): the "can't reach the live key or a live reader" test's unit
 * half. Every request is intercepted, so a refusal shows as no request at all.
 */
const LIVE: StripeSettings = {
  mode: "stripe",
  apiBase: "https://api.stripe.com",
  livemode: true,
  keys: {
    payments: "rk_live_payments_example",
    refunds: "rk_live_refunds_example",
    reporting: "rk_live_reporting_example",
    billing: "rk_live_billing_example",
  },
  publishableKey: "pk_live_example",
  webhookSecrets: { readers: "whsec_a", connect: "whsec_b", platform: "whsec_c" },
};
const SANDBOX: StripeSettings = {
  ...fakeSandboxSettings("https://api.stripe.com"),
  mode: "stripe",
  keys: {
    payments: "rk_test_sandbox_payments",
    refunds: "rk_test_sandbox_refunds",
    reporting: "rk_test_sandbox_reporting",
    billing: "",
  },
};
const intercepted = () => {
  const seen: { url: string; key: string }[] = [];
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      key: String((init?.headers as Record<string, string>)["authorization"]),
    });
    return Promise.resolve(new Response(JSON.stringify({ id: "pi_x" }), { status: 200 }));
  });
  return { seen, fetchImpl: fetchImpl as unknown as typeof fetch };
};
const call = { account: "acct_sandbox", idempotencyKey: "p1:process:1" };

describe("a practice payment can't reach the live key or a live reader", () => {
  it("the live client refuses a practice call before any request leaves the process", async () => {
    const net = intercepted();
    const live = new StripeClient(LIVE, net.fetchImpl);
    await expect(
      live.call("payments", "POST", "/v1/payment_intents", { ...call, training: true }),
    ).rejects.toThrow(StripeMisuse);
    // Forced through the live client with no sandbox attached: refused the same way.
    await expect(
      live.forTraining(true).call("payments", "POST", "/v1/payment_intents", call),
    ).rejects.toThrow(/never goes to live Stripe/);
    expect(net.fetchImpl).not.toHaveBeenCalled();
  });

  it("forTraining sends practice calls to the sandbox only, with its test key, and live ones stay live", async () => {
    const liveNet = intercepted();
    const sandboxNet = intercepted();
    const live = new StripeClient(LIVE, liveNet.fetchImpl).withSandbox(
      new StripeClient(SANDBOX, sandboxNet.fetchImpl),
    );
    await live.forTraining(true).call("payments", "POST", "/v1/payment_intents", call);
    await live.forTraining(false).call("payments", "POST", "/v1/payment_intents", call);
    expect(sandboxNet.seen).toHaveLength(1);
    expect(sandboxNet.seen[0]!.key).toBe("Bearer rk_test_sandbox_payments");
    expect(liveNet.seen).toHaveLength(1);
    expect(liveNet.seen.every((r) => LIVE_KEY.test(r.key.replace("Bearer ", "")))).toBe(true);
    // No practice call ever went out with a live key.
    expect(sandboxNet.seen.some((r) => LIVE_KEY.test(r.key.replace("Bearer ", "")))).toBe(false);
  });

  it("the sandbox client refuses a live call, and never sends a live key", async () => {
    const net = intercepted();
    const sandbox = new StripeClient(SANDBOX, net.fetchImpl);
    await expect(sandbox.call("payments", "POST", "/v1/payment_intents", call)).rejects.toThrow(
      /practice payments only/,
    );
    const leaked = new StripeClient(
      { ...SANDBOX, keys: { ...SANDBOX.keys, payments: "rk_live_oops" } },
      net.fetchImpl,
    );
    await expect(
      leaked.call("payments", "POST", "/v1/payment_intents", { ...call, training: true }),
    ).rejects.toThrow(/never sends a live key/);
    expect(net.fetchImpl).not.toHaveBeenCalled();
  });

  it("only a sandbox can be attached as the training client", () => {
    expect(() =>
      new StripeClient(LIVE).withSandbox(new StripeClient(fakeStripeSettings())),
    ).toThrow(/must be the sandbox/);
  });
});

describe("the sandbox's settings (key-prefix checks)", () => {
  const keys = {
    STRIPE_SANDBOX_KEY_PAYMENTS: "rk_test_a",
    STRIPE_SANDBOX_KEY_REFUNDS: "rk_test_b",
    STRIPE_SANDBOX_KEY_REPORTING: "rk_test_c",
    STRIPE_SANDBOX_WEBHOOK_SECRET_TRAINING: "whsec_t",
  };

  it("takes test keys under their own names, and refuses a live key", () => {
    const s = loadStripeSandboxSettings("production", keys);
    expect(s).toMatchObject({ mode: "stripe", sandbox: true, livemode: false });
    expect(s.trainingWebhookSecret).toBe("whsec_t");
    expect(() =>
      loadStripeSandboxSettings("production", {
        ...keys,
        STRIPE_SANDBOX_KEY_PAYMENTS: "rk_live_real",
      }),
    ).toThrow(/live key/);
    expect(() =>
      loadStripeSandboxSettings("staging", { ...keys, STRIPE_SANDBOX_KEY_REFUNDS: "sk_live_x" }),
    ).toThrow(/live key/);
  });

  it("never borrows the live keys: without its own, the fake plays it locally and production has none", () => {
    const live = { STRIPE_KEY_PAYMENTS: "rk_live_real", STRIPE_KEY_REFUNDS: "rk_live_real" };
    expect(loadStripeSandboxSettings("local", live).keys).toEqual(FAKE_SANDBOX_KEYS);
    expect(loadStripeSandboxSettings("production", live).mode).toBe("off");
    expect(loadStripeSandboxSettings("staging", live).mode).toBe("off");
  });
});
