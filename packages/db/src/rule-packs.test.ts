import { describe, expect, it } from "vitest";
import { newYorkCounty } from "@west4/shared";
import {
  generateSigningKey,
  keyIdOf,
  publicKeyOf,
  signRulePack,
  verifyRulePack,
} from "./rule-packs.js";

describe("rule-pack signatures", () => {
  it("sign and verify round-trip on the canonical JSON, whatever the key order", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const signature = signRulePack(newYorkCounty, privateKeyPem);
    expect(verifyRulePack(newYorkCounty, signature, publicKeyPem)).toBe(true);
    const reordered = JSON.parse(
      JSON.stringify({ ...newYorkCounty, id: newYorkCounty.id }),
    ) as typeof newYorkCounty;
    expect(verifyRulePack(reordered, signature, publicKeyPem)).toBe(true);
    expect(publicKeyOf(privateKeyPem)).toBe(publicKeyPem);
  });

  it("a changed value, a wrong key or garbage never verifies", async () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const signature = signRulePack(newYorkCounty, privateKeyPem);
    const tampered = { ...newYorkCounty, salesTax: { ...newYorkCounty.salesTax, rate: 0.05 } };
    expect(verifyRulePack(tampered, signature, publicKeyPem)).toBe(false);
    expect(verifyRulePack(newYorkCounty, signature, generateSigningKey().publicKeyPem)).toBe(false);
    expect(verifyRulePack(newYorkCounty, "not-a-signature", publicKeyPem)).toBe(false);
    expect(verifyRulePack(newYorkCounty, signature, "not a pem")).toBe(false);
    expect(await keyIdOf(publicKeyPem)).toMatch(/^[0-9a-f]{16}$/);
  });
});
