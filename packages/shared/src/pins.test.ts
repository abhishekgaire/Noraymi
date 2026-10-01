import { describe, expect, it } from "vitest";
import { PIN_BLOCKLIST, pinProblem } from "./pins.js";

describe("PIN rules", () => {
  it("refuses the spec's examples and every run", () => {
    expect(pinProblem("1234", 4)).toBe("sequential");
    expect(pinProblem("1111", 4)).toBe("repeated");
    expect(pinProblem("0000", 4)).toBe("repeated");
    expect(pinProblem("2580", 4)).toBe("common");
    expect(pinProblem("4321", 4)).toBe("sequential");
    expect(pinProblem("9012", 4)).toBe("sequential");
    expect(pinProblem("123456", 6)).toBe("sequential");
    expect(pinProblem("777777", 6)).toBe("repeated");
    expect(pinProblem("112233", 6)).toBe("common");
  });

  it("checks the length for the role, and digits only", () => {
    expect(pinProblem("4071", 6)).toBe("length");
    expect(pinProblem("730915", 4)).toBe("length");
    expect(pinProblem("40a1", 4)).toBe("digits");
    expect(pinProblem("", 4)).toBe("digits");
  });

  it("accepts the demo PINs", () => {
    expect(pinProblem("4071", 4)).toBeNull();
    expect(pinProblem("6358", 4)).toBeNull();
    expect(pinProblem("730915", 6)).toBeNull();
    expect(pinProblem("915204", 6)).toBeNull();
  });

  it("keeps the blocklist to digits of the two lengths", () => {
    for (const pin of PIN_BLOCKLIST) expect(pin).toMatch(/^(\d{4}|\d{6})$/);
    expect(new Set(PIN_BLOCKLIST).size).toBe(PIN_BLOCKLIST.length);
  });
});
