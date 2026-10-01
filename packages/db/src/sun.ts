import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * NTAG 424 DNA Secure Unique NFC messages (NXP AN12196), M1-25. On every read
 * the tag answers with PICCData, its UID and a read counter encrypted under
 * the SDM meta-read key (AES-128-CBC, zero IV), and a truncated AES-CMAC of
 * the read under a session key derived from the SDM file-read key and the
 * counter, so a copy of the URL can't be replayed and a cloned tag without
 * the key can't sign. The server holds the keys: the meta-read key is one per
 * venue and key version, the file-read key is diversified per tag from the
 * venue's master key (AN10922), so the keys never leave the key service.
 */
const BLOCK = 16;
const PICC_TAG_UID_AND_COUNTER = 0xc7;

function xorBlock(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i += 1) out[i] = a[i]! ^ b[i]!;
  return out;
}

function shiftLeft(input: Buffer): Buffer {
  const out = Buffer.alloc(BLOCK);
  let carry = 0;
  for (let i = BLOCK - 1; i >= 0; i -= 1) {
    const byte = input[i]!;
    out[i] = ((byte << 1) & 0xff) | carry;
    carry = byte >> 7;
  }
  return out;
}

function aesEcb(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** AES-128-CMAC (RFC 4493). */
export function aesCmac(key: Buffer, message: Buffer): Buffer {
  const zero = Buffer.alloc(BLOCK);
  const l = aesEcb(key, zero);
  const rb = Buffer.alloc(BLOCK);
  rb[BLOCK - 1] = 0x87;
  const subkey = (input: Buffer) => {
    const shifted = shiftLeft(input);
    return input[0]! & 0x80 ? xorBlock(shifted, rb) : shifted;
  };
  const k1 = subkey(l);
  const k2 = subkey(k1);
  const n = Math.ceil(message.length / BLOCK);
  const blocks = n === 0 ? 1 : n;
  const complete = n !== 0 && message.length % BLOCK === 0;
  let last: Buffer;
  if (complete) {
    last = xorBlock(message.subarray((blocks - 1) * BLOCK), k1);
  } else {
    const tail = Buffer.alloc(BLOCK);
    const rest = message.subarray((blocks - 1) * BLOCK);
    rest.copy(tail);
    tail[rest.length] = 0x80;
    last = xorBlock(tail, k2);
  }
  let x: Buffer = Buffer.alloc(BLOCK);
  for (let i = 0; i < blocks - 1; i += 1) {
    x = aesEcb(key, xorBlock(x, message.subarray(i * BLOCK, (i + 1) * BLOCK)));
  }
  return aesEcb(key, xorBlock(x, last));
}

/** The venue's badge keys for one key version, from the key service's secret: never stored. */
export function venueBadgeKeys(
  secret: Buffer,
  venueId: string,
  keyVersion: number,
): { master: Buffer; metaRead: Buffer } {
  const master = createHmac("sha256", secret)
    .update(`badge-master‖${venueId}‖${keyVersion}`)
    .digest()
    .subarray(0, BLOCK);
  const metaRead = createHmac("sha256", master).update("sdm-meta-read").digest().subarray(0, BLOCK);
  return { master, metaRead };
}

/** The tag's own SDM file-read key, diversified from the master by its UID (AN10922). */
export function tagFileReadKey(master: Buffer, uid: Buffer): Buffer {
  const input = Buffer.concat([Buffer.from([0x01]), uid, Buffer.from("W4BADGE", "ascii")]);
  return aesCmac(master, input);
}

export interface SunMessage {
  /** 32 hex characters: the encrypted PICCData. */
  readonly piccData: string;
  /** 16 hex characters: the truncated CMAC. */
  readonly cmac: string;
}

/** The URL a tag emits, or its two parameters, as the reader hands them over. */
export function parseSun(input: string | { picc_data?: string; cmac?: string }): SunMessage | null {
  let piccData: string | undefined;
  let cmac: string | undefined;
  if (typeof input === "string") {
    const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
    const params = new URLSearchParams(query);
    piccData = params.get("e") ?? params.get("picc_data") ?? undefined;
    cmac = params.get("c") ?? params.get("cmac") ?? undefined;
  } else {
    piccData = input.picc_data;
    cmac = input.cmac;
  }
  if (!piccData || !cmac) return null;
  if (!/^[0-9a-fA-F]{32}$/.test(piccData) || !/^[0-9a-fA-F]{16}$/.test(cmac)) return null;
  return { piccData: piccData.toUpperCase(), cmac: cmac.toUpperCase() };
}

export interface PiccData {
  readonly uid: Buffer;
  readonly counter: number;
}

/** Decrypt PICCData with the meta-read key; null when it isn't a UID-and-counter message. */
export function decodePiccData(metaRead: Buffer, piccDataHex: string): PiccData | null {
  const decipher = createDecipheriv("aes-128-cbc", metaRead, Buffer.alloc(BLOCK));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(piccDataHex, "hex")), decipher.final()]);
  if (plain[0] !== PICC_TAG_UID_AND_COUNTER) return null;
  const uid = Buffer.from(plain.subarray(1, 8));
  const counter = plain[8]! | (plain[9]! << 8) | (plain[10]! << 16);
  return { uid, counter };
}

/** The session MAC key for one read: KSesSDMFileReadMAC = CMAC(KSDMFileRead, SV2). */
function sessionMacKey(fileRead: Buffer, uid: Buffer, counter: number): Buffer {
  const sv2 = Buffer.alloc(BLOCK);
  Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]).copy(sv2, 0);
  uid.copy(sv2, 6);
  sv2[13] = counter & 0xff;
  sv2[14] = (counter >> 8) & 0xff;
  sv2[15] = (counter >> 16) & 0xff;
  return aesCmac(fileRead, sv2);
}

/** The truncated MAC the tag writes: the odd bytes of CMAC(KSes, SDMMACInput), the input empty here. */
export function sunMac(fileRead: Buffer, uid: Buffer, counter: number): string {
  const full = aesCmac(sessionMacKey(fileRead, uid, counter), Buffer.alloc(0));
  const truncated = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) truncated[i] = full[2 * i + 1]!;
  return truncated.toString("hex").toUpperCase();
}

export function verifySunMac(
  fileRead: Buffer,
  uid: Buffer,
  counter: number,
  cmacHex: string,
): boolean {
  const expected = Buffer.from(sunMac(fileRead, uid, counter), "hex");
  const given = Buffer.from(cmacHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** What a tag does on a read: the fake reader for tests and the demo (M1-30 drives the real one). */
export function encodeSun(args: {
  metaRead: Buffer;
  fileRead: Buffer;
  uid: Buffer;
  counter: number;
  padding?: Buffer;
}): SunMessage {
  const plain = Buffer.alloc(BLOCK);
  plain[0] = PICC_TAG_UID_AND_COUNTER;
  args.uid.copy(plain, 1);
  plain[8] = args.counter & 0xff;
  plain[9] = (args.counter >> 8) & 0xff;
  plain[10] = (args.counter >> 16) & 0xff;
  (args.padding ?? randomBytes(5)).copy(plain, 11, 0, 5);
  const cipher = createCipheriv("aes-128-cbc", args.metaRead, Buffer.alloc(BLOCK));
  cipher.setAutoPadding(false);
  const piccData = Buffer.concat([cipher.update(plain), cipher.final()])
    .toString("hex")
    .toUpperCase();
  return { piccData, cmac: sunMac(args.fileRead, args.uid, args.counter) };
}

/** Test badges in the demo seed: a fixed UID per badge id, so the fake reader can tap them. DEMO ONLY. */
export function demoBadgeUid(badgeId: string): Buffer {
  const digest = createHmac("sha256", "west4-demo-badge").update(badgeId).digest();
  return Buffer.concat([Buffer.from([0x04]), digest.subarray(0, 6)]);
}
