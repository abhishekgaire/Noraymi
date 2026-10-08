import { describe, expect, it } from "vitest";
import { percentile, shareWithin, summarize } from "./stats.js";

describe("the load test's numbers (M8-21)", () => {
  it("takes percentiles by nearest rank: the p95 of 20 orders is the 19th fastest", () => {
    const xs = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(summarize(xs)).toEqual({ count: 20, p50: 1000, p95: 1900, p99: 2000, max: 2000 });
    expect(percentile([], 95)).toBeNull();
    expect(summarize([]).p95).toBeNull();
  });

  it("counts an alarm at 3,000 ms as late, as the alert does", () => {
    expect(shareWithin([2999, 3000, 1000, 500], 3000)).toBe(0.75);
    expect(shareWithin([], 3000)).toBe(1);
  });
});
