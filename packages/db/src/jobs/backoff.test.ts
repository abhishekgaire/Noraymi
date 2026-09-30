import { describe, expect, it } from "vitest";
import { retryDelaySeconds } from "./backoff.js";

describe("retryDelaySeconds", () => {
  it("starts about 5 seconds out and doubles, capped at 10 minutes", () => {
    const noJitter = () => 0.5;
    expect(retryDelaySeconds(1, noJitter)).toBe(5);
    expect(retryDelaySeconds(2, noJitter)).toBe(10);
    expect(retryDelaySeconds(3, noJitter)).toBe(20);
    expect(retryDelaySeconds(7, noJitter)).toBe(320);
    expect(retryDelaySeconds(8, noJitter)).toBe(600);
    expect(retryDelaySeconds(20, noJitter)).toBe(600);
  });

  it("jitters by at most a quarter either way and never passes the cap", () => {
    expect(retryDelaySeconds(1, () => 0)).toBe(4); // 5 × 0.75 = 3.75 → 4
    expect(retryDelaySeconds(1, () => 1)).toBe(6); // 5 × 1.25 = 6.25 → 6
    expect(retryDelaySeconds(8, () => 1)).toBe(600);
    for (let i = 0; i < 200; i += 1) {
      const d = retryDelaySeconds(3);
      expect(d).toBeGreaterThanOrEqual(15);
      expect(d).toBeLessThanOrEqual(25);
    }
  });
});
