import { describe, expect, it } from "vitest";
import {
  loadVendorHealthSettings,
  overThreshold,
  readStatusFeed,
  vendorVerdict,
} from "./vendor-health.js";

const settings = loadVendorHealthSettings({});
const none = { calls: 0, errors: 0 };

describe("vendor-health checks (M8-01)", () => {
  it("takes the cautious defaults: 20% of at least 5 calls in 5 minutes, no feed until set", () => {
    expect(settings).toEqual({
      statusUrls: { stripe: null, twilio: null },
      windowMinutes: 5,
      minCalls: 5,
      ratePercent: 20,
    });
    expect(
      loadVendorHealthSettings({
        TWILIO_STATUS_URL: " https://status.example/api/v2/status.json ",
        VENDOR_ERROR_RATE_PERCENT: "35",
        VENDOR_ERROR_MIN_CALLS: "nope",
      }),
    ).toMatchObject({
      statusUrls: { stripe: null, twilio: "https://status.example/api/v2/status.json" },
      minCalls: 5,
      ratePercent: 35,
    });
  });

  it("is over the threshold at 20% of at least 5 calls, in whole numbers", () => {
    expect(overThreshold({ calls: 5, errors: 1 }, settings)).toBe(true);
    expect(overThreshold({ calls: 6, errors: 1 }, settings)).toBe(false);
    expect(overThreshold({ calls: 4, errors: 4 }, settings)).toBe(false);
  });

  it("puts the feed first, then the venue's own calls, then every venue's", () => {
    expect(vendorVerdict({ feedTrouble: true, venue: none, overall: none }, settings)).toEqual({
      trouble: true,
      source: "status_feed",
    });
    expect(
      vendorVerdict(
        { feedTrouble: false, venue: { calls: 10, errors: 3 }, overall: none },
        settings,
      ),
    ).toEqual({ trouble: true, source: "venue_errors" });
    expect(
      vendorVerdict(
        { feedTrouble: null, venue: none, overall: { calls: 50, errors: 20 } },
        settings,
      ),
    ).toEqual({ trouble: true, source: "overall_errors" });
    expect(
      vendorVerdict(
        { feedTrouble: null, venue: { calls: 10, errors: 1 }, overall: none },
        settings,
      ),
    ).toEqual({ trouble: false, source: null });
  });

  it("reads a Statuspage feed: major and critical are trouble, no answer says nothing", async () => {
    const feed = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const url = "https://status.example/api/v2/status.json";
    expect(await readStatusFeed(url, feed({ status: { indicator: "major" } }))).toBe(true);
    expect(await readStatusFeed(url, feed({ status: { indicator: "critical" } }))).toBe(true);
    expect(await readStatusFeed(url, feed({ status: { indicator: "minor" } }))).toBe(false);
    expect(await readStatusFeed(url, feed({ status: { indicator: "none" } }))).toBe(false);
    expect(await readStatusFeed(url, feed({}, 503))).toBeNull();
    expect(await readStatusFeed(url, feed({ nothing: true }))).toBeNull();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await readStatusFeed(url, down)).toBeNull();
  });
});
