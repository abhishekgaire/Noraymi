import { describe, expect, it } from "vitest";
import { TokenBucket, stripeRate } from "./rate.js";
import { fakeStripeSettings } from "./settings.js";

describe("the token bucket in front of Stripe (M8-21)", () => {
  it("lets a burst through, then spaces calls at the rate, first come first served", async () => {
    let t = 0;
    const bucket = new TokenBucket(
      10,
      3,
      () => t,
      async (ms) => void (t += ms),
    );
    const waits = await Promise.all(Array.from({ length: 6 }, () => bucket.take()));
    expect(waits.slice(0, 3)).toEqual([0, 0, 0]);
    // The 4th, 5th and 6th wait 100, 200 and 300 ms: 10 a second.
    expect(waits.slice(3)).toEqual([100, 200, 300]);
  });

  it("refills while idle, up to the burst only", async () => {
    let t = 0;
    const bucket = new TokenBucket(
      10,
      2,
      () => t,
      async (ms) => void (t += ms),
    );
    await Promise.all([bucket.take(), bucket.take()]);
    t += 10_000;
    const waits = await Promise.all([bucket.take(), bucket.take(), bucket.take()]);
    expect(waits).toEqual([0, 0, 100]);
  });

  it("stays under Stripe's limits: 80 a second live, 20 in test mode", () => {
    const fake = fakeStripeSettings("http://127.0.0.1:1");
    expect(stripeRate({ ...fake, mode: "stripe", livemode: true }).ratePerSecond).toBe(80);
    expect(stripeRate({ ...fake, mode: "stripe", livemode: false }).ratePerSecond).toBe(20);
  });
});
