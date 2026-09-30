/**
 * Device request signing (spec 02 · Shared device; M1-15). A paired device
 * signs every request with the non-extractable WebCrypto key it made at
 * pairing (ECDSA P-256, SHA-256), over the method, the path, the body's
 * hash, a timestamp and a nonce. This file is shared by the API, the
 * desktop app and the staff app, so both sides build the same string.
 */
export const DEVICE_HEADERS = {
  id: "x-device-id",
  timestamp: "x-device-timestamp",
  nonce: "x-device-nonce",
  signature: "x-device-signature",
} as const;

/** How far a device's clock may be from ours before a request is refused, and how long nonces are kept. */
export const DEVICE_SIGNATURE_WINDOW_MS = 5 * 60_000;

export const DEVICE_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
export const DEVICE_SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

/** The exact bytes that get signed. */
export function deviceSigningString(args: {
  method: string;
  path: string;
  bodySha256Hex: string;
  timestampMs: number;
  nonce: string;
}): string {
  return [
    args.method.toUpperCase(),
    args.path,
    args.bodySha256Hex,
    String(args.timestampMs),
    args.nonce,
  ].join("\n");
}

/** The SHA-256 of a body as lowercase hex, "" for no body. Works in browsers and Node (WebCrypto). */
export async function sha256Hex(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Make the device's key pair: the private key never leaves the device (non-extractable). */
export async function makeDeviceKey(): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(DEVICE_KEY_ALGORITHM, false, ["sign", "verify"]);
  return {
    privateKey: pair.privateKey,
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

/** The headers for one request. */
export async function signDeviceRequest(args: {
  deviceId: string;
  privateKey: CryptoKey;
  method: string;
  path: string;
  body?: string | Uint8Array;
  timestampMs?: number;
  nonce?: string;
}): Promise<Record<string, string>> {
  const timestampMs = args.timestampMs ?? Date.now();
  const nonce = args.nonce ?? crypto.randomUUID();
  const bodySha256Hex = await sha256Hex(args.body ?? "");
  const data = new TextEncoder().encode(
    deviceSigningString({
      method: args.method,
      path: args.path,
      bodySha256Hex,
      timestampMs,
      nonce,
    }),
  );
  const signature = await crypto.subtle.sign(DEVICE_SIGN_ALGORITHM, args.privateKey, data);
  return {
    [DEVICE_HEADERS.id]: args.deviceId,
    [DEVICE_HEADERS.timestamp]: String(timestampMs),
    [DEVICE_HEADERS.nonce]: nonce,
    [DEVICE_HEADERS.signature]: btoa(String.fromCharCode(...new Uint8Array(signature))),
  };
}

/** Check a signature against a public JWK. */
export async function verifyDeviceSignature(args: {
  publicJwk: JsonWebKey;
  signatureBase64: string;
  signingString: string;
}): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", args.publicJwk, DEVICE_KEY_ALGORITHM, true, [
      "verify",
    ]);
    const sig = Uint8Array.from(atob(args.signatureBase64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      DEVICE_SIGN_ALGORITHM,
      key,
      sig,
      new TextEncoder().encode(args.signingString),
    );
  } catch {
    return false;
  }
}
