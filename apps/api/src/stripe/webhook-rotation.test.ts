import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validStripeSignature } from "./webhooks.js";

/**
 * Rotating a webhook signing secret (M8-19; docs/runbooks/key-rotation.md): during the overlap the
 * setting holds "new,old" and events signed with either are taken; once the old one comes out,
 * only the new one signs. No event is refused at any point of the rotation.
 */
const NOW = 1_790_000_000;
const sign = (payload: string, secret: string, t = NOW) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });

describe("webhook signing secret rotation", () => {
  it("before, during and after the overlap", () => {
    // Before: only the old secret.
    expect(validStripeSignature(body, sign(body, "whsec_old"), "whsec_old", NOW)).toBe(true);
    // During: Stripe signs with both (two v1 entries), or with either alone while it switches.
    const both = `${sign(body, "whsec_new")},v1=${sign(body, "whsec_old").split("v1=")[1]}`;
    for (const header of [sign(body, "whsec_old"), sign(body, "whsec_new"), both])
      expect(validStripeSignature(body, header, "whsec_new, whsec_old", NOW)).toBe(true);
    // After: the old secret no longer signs.
    expect(validStripeSignature(body, sign(body, "whsec_new"), "whsec_new", NOW)).toBe(true);
    expect(validStripeSignature(body, sign(body, "whsec_old"), "whsec_new", NOW)).toBe(false);
  });

  it("an empty entry never matches, and a wrong secret is refused", () => {
    expect(validStripeSignature(body, sign(body, "whsec_x"), "whsec_new,", NOW)).toBe(false);
    expect(validStripeSignature(body, sign(body, ""), ",", NOW)).toBe(false);
  });
});
