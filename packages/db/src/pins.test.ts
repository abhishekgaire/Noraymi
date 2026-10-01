import { describe, expect, it } from "vitest";
import { codesEqual, pinVerifier, verifyPin } from "./pins.js";

const pepper = Buffer.from("0".repeat(64), "hex");
const venue = "11111111-1111-4111-8111-111111111111";
const maya = "22222222-2222-4222-8222-222222222222";
const diego = "33333333-3333-4333-8333-333333333333";

describe("PIN verifiers", () => {
  it("is an Argon2id hash, and the same PIN gives two people two different verifiers", async () => {
    const a = await pinVerifier(pepper, venue, maya, "4071");
    const b = await pinVerifier(pepper, venue, diego, "4071");
    expect(a).toMatch(/^\$argon2id\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("4071");
  });

  it("verifies the right PIN and refuses a wrong one, another pepper, or no verifier", async () => {
    const v = await pinVerifier(pepper, venue, maya, "4071");
    expect(await verifyPin(pepper, v, venue, maya, "4071")).toBe(true);
    expect(await verifyPin(pepper, v, venue, maya, "4072")).toBe(false);
    expect(await verifyPin(pepper, v, venue, diego, "4071")).toBe(false);
    expect(await verifyPin(Buffer.from("1".repeat(64), "hex"), v, venue, maya, "4071")).toBe(false);
    expect(await verifyPin(pepper, null, venue, maya, "4071")).toBe(false);
  });

  it("compares codes without a timing tell", () => {
    expect(codesEqual("123456", "123456")).toBe(true);
    expect(codesEqual("123456", "123457")).toBe(false);
    expect(codesEqual("12345", "123456")).toBe(false);
  });
});
