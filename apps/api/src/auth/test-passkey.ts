import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/**
 * A software passkey for tests: an ES256 key that answers WebAuthn
 * registration and sign-in ceremonies the way a phone would, with user
 * verification set. Playwright's virtual authenticator does the same job in
 * the browser (e2e/api.spec.ts); this one runs inside Vitest.
 */

// ---- A tiny CBOR encoder: only what an attestation object needs. ----------
function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(length, 1);
  return b;
}
type Cbor = number | string | Uint8Array | CborMap | CborRecord;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the interface breaks the alias's own recursion
interface CborMap extends Map<number | string, Cbor> {}
interface CborRecord {
  [key: string]: Cbor;
}
export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array)
    return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([
    cborHead(5, entries.length),
    ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]),
  ]);
}

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

export class SoftwarePasskey {
  readonly credentialId = randomBytes(16);
  counter = 0;
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;

  /** "internal" is a phone's or laptop's passkey; "usb" a FIDO2 security key (the Console needs one). */
  constructor(
    readonly rpId: string,
    readonly transport: "internal" | "usb" = "internal",
  ) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x!, "base64url");
    this.y = Buffer.from(jwk.y!, "base64url");
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private authData(flags: number, extra: Buffer = Buffer.alloc(0)): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([
      createHash("sha256").update(this.rpId).digest(),
      Buffer.from([flags]),
      counter,
      extra,
    ]);
  }

  /** navigator.credentials.create(): an attestation of format "none". */
  register(options: { challenge: string }, origin: string): Record<string, unknown> {
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, this.x],
        [-3, this.y],
      ]),
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, cose]);
    const authData = this.authData(0x45, attested); // UP | UV | AT
    const attestationObject = cbor({ fmt: "none", attStmt: {}, authData });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      authenticatorAttachment: this.transport === "internal" ? "platform" : "cross-platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(attestationObject),
        transports: [this.transport],
      },
    };
  }

  /** navigator.credentials.get(): a signed assertion, counter moved forward. */
  assert(options: { challenge: string }, origin: string, uv = true): Record<string, unknown> {
    this.counter += 1;
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const authData = this.authData(uv ? 0x05 : 0x01); // UP | UV
    const signature = createSign("sha256")
      .update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]))
      .sign(this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: null,
      },
    };
  }
}
