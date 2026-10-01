import { describe, expect, it } from "vitest";
import { isBelowMinimum } from "./version.js";

describe("min_client_version", () => {
  it("compares builds number by number", () => {
    expect(isBelowMinimum("0.1.0", "0.0.0")).toBe(false);
    expect(isBelowMinimum("0.1.0", "0.1.0")).toBe(false);
    expect(isBelowMinimum("0.1.0", "0.2.0")).toBe(true);
    expect(isBelowMinimum("1.9.0", "1.10.0")).toBe(true);
    expect(isBelowMinimum("2.0.0", "1.99.99")).toBe(false);
    expect(isBelowMinimum("1.0", "1.0.1")).toBe(true);
  });
});
