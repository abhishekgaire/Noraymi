import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  newTotpSecret,
  otpauthUrl,
  stepAt,
  totpAt,
  verifyTotp,
} from "./totp.js";

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890"; the last 6 of its 8 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS: [seconds: number, code8: string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP", () => {
  it("base32 round-trips", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET).toString()).toBe("12345678901234567890");
    expect(base32Decode("gezd gnbv-gy3t").toString()).toBe("1234567");
  });

  it("reproduces the RFC 6238 test vectors", () => {
    for (const [seconds, code8] of RFC_VECTORS) {
      expect(totpAt(RFC_SECRET, stepAt(seconds * 1000), 8)).toBe(code8);
      expect(totpAt(RFC_SECRET, stepAt(seconds * 1000))).toBe(code8.slice(2));
    }
  });

  it("accepts the current step and one either side, and refuses two steps off", () => {
    const at = 1111111111 * 1000;
    const step = stepAt(at);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), at)).toEqual({ ok: true, step });
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), at)).toEqual({
      ok: true,
      step: step - 1,
    });
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), at)).toEqual({
      ok: true,
      step: step + 1,
    });
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 2), at)).toEqual({ ok: false });
    expect(verifyTotp(RFC_SECRET, "000000", at).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, "12345", at).ok).toBe(false);
  });

  it("never accepts a code twice: a step at or before the last accepted one is refused", () => {
    const at = 1111111111 * 1000;
    const step = stepAt(at);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, at, { lastAcceptedStep: step })).toEqual({ ok: false });
    expect(verifyTotp(RFC_SECRET, code, at, { lastAcceptedStep: step - 1 })).toEqual({
      ok: true,
      step,
    });
  });

  it("makes 160-bit secrets and an otpauth URL the apps read", () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(
      otpauthUrl({ issuer: "West 4", account: "andy@example.com", secretBase32: secret }),
    ).toBe(
      `otpauth://totp/West%204:andy%40example.com?secret=${secret}&issuer=West+4&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
