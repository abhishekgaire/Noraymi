import { createHmac, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/**
 * PIN verifiers (spec 02 · PINs, M1-23). A PIN is stored as Argon2id over
 * HMAC(pepper, venue_id ‖ membership_id ‖ PIN). The pepper is the key the key
 * service holds (AUTH_SECRET_KEY), so a copy of the database alone can't be
 * guessed offline, and the venue and membership in the message mean the same
 * PIN gives every person a different verifier.
 */
const ARGON2ID = { memoryCost: 19 * 1024, timeCost: 2, parallelism: 1, algorithm: 2 } as const;

function pinMessage(pepper: Buffer, venueId: string, membershipId: string, pin: string): string {
  return createHmac("sha256", pepper).update(`${venueId}‖${membershipId}‖${pin}`).digest("hex");
}

export async function pinVerifier(
  pepper: Buffer,
  venueId: string,
  membershipId: string,
  pin: string,
): Promise<string> {
  return hash(pinMessage(pepper, venueId, membershipId, pin), ARGON2ID);
}

export async function verifyPin(
  pepper: Buffer,
  verifier: string | null,
  venueId: string,
  membershipId: string,
  pin: string,
): Promise<boolean> {
  if (!verifier) return false;
  return verify(verifier, pinMessage(pepper, venueId, membershipId, pin));
}

/** Same-length comparison for the codes that aren't PINs (phone codes), without a timing tell. */
export function codesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
