import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time codes (RFC 6238 over RFC 4226): what an authenticator
 * app such as Google Authenticator or 1Password shows. SHA-1, 6 digits, a
 * 30-second step, and one step of drift either way for slow clocks.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32, the size authenticator apps expect. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one 30-second step (HOTP with the step as the counter). */
export function totpAt(secretBase32: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function stepAt(epochMs: number): number {
  return Math.floor(epochMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Checks a code against the step now and one either side. A step at or
 * before lastAcceptedStep is refused, so a code is never accepted twice.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  epochMs: number,
  options: { window?: number; lastAcceptedStep?: number | null } = {},
): { ok: true; step: number } | { ok: false } {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const now = stepAt(epochMs);
  const window = options.window ?? 1;
  const given = Buffer.from(code);
  for (let step = now - window; step <= now + window; step++) {
    if (options.lastAcceptedStep != null && step <= options.lastAcceptedStep) continue;
    const expected = Buffer.from(totpAt(secretBase32, step));
    if (expected.length === given.length && timingSafeEqual(expected, given))
      return { ok: true, step };
  }
  return { ok: false };
}

/** What the QR code carries; the app reads the issuer and the account name from it. */
export function otpauthUrl(input: {
  issuer: string;
  account: string;
  secretBase32: string;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
