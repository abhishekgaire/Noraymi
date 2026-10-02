import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  StripeClient,
  StripeError,
  StripeMisuse,
  STRIPE_API_VERSION,
  formEncode,
} from "./client.js";
import { FakeStripe } from "./fake/index.js";
import { fakeStripeSettings, loadStripeSettings } from "./settings.js";

let fake: FakeStripe;
let stripe: StripeClient;

beforeAll(async () => {
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
});
afterAll(() => fake.stop());

describe("the Stripe client's keys", () => {
  const venue = { account: "acct_west4", idempotencyKey: "k1" };

  it("refuses the billing key with Stripe-Account, and a venue call without one", () => {
    expect(() =>
      StripeClient.check("billing", "GET", "/v1/invoices", { account: "acct_west4" }),
    ).toThrow(/billing key is never sent with Stripe-Account/);
    expect(() =>
      StripeClient.check("billing", "GET", "/v1/invoices", { account: null }),
    ).not.toThrow();
    expect(() =>
      StripeClient.check("payments", "POST", "/v1/payment_intents", {
        account: null,
        idempotencyKey: "k",
      }),
    ).toThrow(/must name the venue's Stripe account/);
  });

  it("lets reporting only read and refunds only refund, and every write needs an idempotency key", () => {
    expect(() => StripeClient.check("reporting", "POST", "/v1/payment_intents", venue)).toThrow(
      /only reads/,
    );
    expect(() =>
      StripeClient.check("reporting", "GET", "/v1/payouts", { account: "acct_west4" }),
    ).not.toThrow();
    expect(() => StripeClient.check("refunds", "POST", "/v1/payment_intents", venue)).toThrow(
      /only makes refunds/,
    );
    expect(() => StripeClient.check("refunds", "POST", "/v1/refunds", venue)).not.toThrow();
    expect(() =>
      StripeClient.check("payments", "POST", "/v1/payment_intents", { account: "acct_west4" }),
    ).toThrow(/idempotency key/);
  });

  it("encodes nested params and arrays the way Stripe reads them", () => {
    expect(
      formEncode({
        tipping: { usd: { percentages: [18, 20, 22], smart_tip_threshold: 1000 } },
        a: undefined,
      }),
    ).toEqual([
      ["tipping[usd][percentages][0]", "18"],
      ["tipping[usd][percentages][1]", "20"],
      ["tipping[usd][percentages][2]", "22"],
      ["tipping[usd][smart_tip_threshold]", "1000"],
    ]);
  });

  it("is a fake locally with no keys, and production without keys refuses to start", () => {
    expect(loadStripeSettings("local", {}).mode).toBe("fake");
    expect(loadStripeSettings("staging", {}).mode).toBe("off");
    expect(() => loadStripeSettings("production", {})).toThrow(/STRIPE_KEY_PAYMENTS/);
    const live = loadStripeSettings("production", {
      STRIPE_KEY_PAYMENTS: "rk_live_1",
      STRIPE_KEY_REFUNDS: "rk_live_2",
      STRIPE_KEY_REPORTING: "rk_live_3",
      STRIPE_KEY_BILLING: "rk_live_4",
      STRIPE_PUBLISHABLE_KEY: "pk_live_1",
      STRIPE_WEBHOOK_SECRET_READERS: "whsec_1",
      STRIPE_WEBHOOK_SECRET_CONNECT: "whsec_2",
      STRIPE_WEBHOOK_SECRET_PLATFORM: "whsec_3",
    });
    expect(live).toMatchObject({
      mode: "stripe",
      livemode: true,
      apiBase: "https://api.stripe.com",
    });
  });
});

describe("restricted keys, as Stripe enforces them (the fake)", () => {
  /** Sends a request with a given key straight to the fake, skipping the client's own checks. */
  const raw = (key: string, method: string, path: string, account?: string) =>
    fetch(`${fake.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `raw-${Math.random()}`,
        ...(account ? { "stripe-account": account } : {}),
      },
      ...(method === "POST" ? { body: "amount=100&currency=usd" } : {}),
    });

  it("the refunds key can't create a PaymentIntent, the reporting key can't write, billing never acts on a venue", async () => {
    const keys = stripe.settings.keys;
    expect((await raw(keys.refunds, "POST", "/v1/payment_intents", "acct_x")).status).toBe(403);
    expect((await raw(keys.reporting, "POST", "/v1/payment_intents", "acct_x")).status).toBe(403);
    expect((await raw(keys.billing, "GET", "/v1/payouts", "acct_x")).status).toBe(403);
    expect((await raw("sk_test_unknown", "GET", "/v1/payouts", "acct_x")).status).toBe(401);
  });

  it("sends the pinned API version and the account on every call", async () => {
    await stripe.call("reporting", "GET", "/v1/payouts", { account: "acct_west4" });
    const last = fake.requests.at(-1)!;
    expect(last).toMatchObject({
      path: "/v1/payouts",
      account: "acct_west4",
      service: "reporting",
    });
    expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/);
  });

  it("answers a reused idempotency key with other parameters as an error, and the same ones with the first answer", async () => {
    const make = (name: string) =>
      stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
        account: null,
        platform: true,
        idempotencyKey: "same-key",
        params: { display_name: name },
      });
    const first = await make("A");
    expect((await make("A")).id).toBe(first.id);
    await expect(make("B")).rejects.toBeInstanceOf(StripeError);
  });

  it("refuses Stripe calls with no keys and no fake", async () => {
    const off = new StripeClient({ ...fakeStripeSettings(), mode: "off" });
    await expect(
      off.call("reporting", "GET", "/v1/payouts", { account: "acct_x" }),
    ).rejects.toBeInstanceOf(StripeMisuse);
  });
});
