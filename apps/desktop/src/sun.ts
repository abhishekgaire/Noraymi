import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * The badge crypto the desktop shares with the API (packages/db/src/sun.ts):
 * AES-128-CMAC (RFC 4493), the NTAG 424 DNA SUN message (NXP AN12196) and
 * the venue's key derivation. The two copies are pinned to the same
 * published vectors by their tests; the desktop can't import the server
 * package, which carries the database with it.
 */
export const BLOCK = 16;
const PICC_TAG_UID_AND_COUNTER = 0xc7;

export function xorBytes(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i]! ^ (b[i] ?? 0);
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

export function aesEcb(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

export function aesCbcEncrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function aesCbcDecrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** AES-128-CMAC (RFC 4493). */
export function aesCmac(key: Buffer, message: Buffer): Buffer {
  const l = aesEcb(key, Buffer.alloc(BLOCK));
  const rb = Buffer.alloc(BLOCK);
  rb[BLOCK - 1] = 0x87;
  const subkey = (input: Buffer) => {
    const shifted = shiftLeft(input);
    return input[0]! & 0x80 ? xorBytes(shifted, rb) : shifted;
  };
  const k1 = subkey(l);
  const k2 = subkey(k1);
  const n = Math.ceil(message.length / BLOCK);
  const blocks = n === 0 ? 1 : n;
  const complete = n !== 0 && message.length % BLOCK === 0;
  let last: Buffer;
  if (complete) {
    last = xorBytes(message.subarray((blocks - 1) * BLOCK), k1);
  } else {
    const tail = Buffer.alloc(BLOCK);
    const rest = message.subarray((blocks - 1) * BLOCK);
    rest.copy(tail);
    tail[rest.length] = 0x80;
    last = xorBytes(tail, k2);
  }
  let x: Buffer = Buffer.alloc(BLOCK);
  for (let i = 0; i < blocks - 1; i += 1) {
    x = aesEcb(key, xorBytes(x, message.subarray(i * BLOCK, (i + 1) * BLOCK)));
  }
  return aesEcb(key, xorBytes(x, last));
}

/** The 8-byte MAC the tag carries: the odd bytes of a full CMAC. */
export function truncateMac(full: Buffer): Buffer {
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) out[i] = full[2 * i + 1]!;
  return out;
}

/** The venue's badge keys for one key version (the same derivation as the server's). */
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

export function tagFileReadKey(master: Buffer, uid: Buffer): Buffer {
  return aesCmac(
    master,
    Buffer.concat([Buffer.from([0x01]), uid, Buffer.from("W4BADGE", "ascii")]),
  );
}

function sessionMacKey(fileRead: Buffer, uid: Buffer, counter: number): Buffer {
  const sv2 = Buffer.alloc(BLOCK);
  Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]).copy(sv2, 0);
  uid.copy(sv2, 6);
  sv2[13] = counter & 0xff;
  sv2[14] = (counter >> 8) & 0xff;
  sv2[15] = (counter >> 16) & 0xff;
  return aesCmac(fileRead, sv2);
}

export function sunMac(fileRead: Buffer, uid: Buffer, counter: number): string {
  return truncateMac(aesCmac(sessionMacKey(fileRead, uid, counter), Buffer.alloc(0)))
    .toString("hex")
    .toUpperCase();
}

export function encodePiccData(
  metaRead: Buffer,
  uid: Buffer,
  counter: number,
  padding = randomBytes(5),
): string {
  const plain = Buffer.alloc(BLOCK);
  plain[0] = PICC_TAG_UID_AND_COUNTER;
  uid.copy(plain, 1);
  plain[8] = counter & 0xff;
  plain[9] = (counter >> 8) & 0xff;
  plain[10] = (counter >> 16) & 0xff;
  padding.copy(plain, 11, 0, 5);
  return aesCbcEncrypt(metaRead, Buffer.alloc(BLOCK), plain).toString("hex").toUpperCase();
}

export function decodePiccData(
  metaRead: Buffer,
  piccDataHex: string,
): { uid: Buffer; counter: number } | null {
  const plain = aesCbcDecrypt(metaRead, Buffer.alloc(BLOCK), Buffer.from(piccDataHex, "hex"));
  if (plain[0] !== PICC_TAG_UID_AND_COUNTER) return null;
  return {
    uid: Buffer.from(plain.subarray(1, 8)),
    counter: plain[8]! | (plain[9]! << 8) | (plain[10]! << 16),
  };
}
