import { randomBytes } from "node:crypto";
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  aesCmac,
  aesEcb,
  BLOCK,
  truncateMac,
  xorBytes,
} from "./sun.js";

/**
 * NTAG 424 DNA over PC/SC (NXP datasheet NT4H2421Gx, AN12196), M1-30. Three
 * jobs: read the tag's UID (GetVersion), read the NDEF URL a programmed tag
 * mirrors its SUN message into, and program a factory tag at pairing:
 * authenticate with the factory key (AuthenticateEV2First), write the URL
 * template, set keys 2 and 3 (the SDM meta-read and file-read keys) with
 * ChangeKey, and switch SDM mirroring on with ChangeFileSettings, all under
 * EV2 secure messaging (CommMode.Full). Everything speaks through one
 * `transmit(apdu)` function, so a PC/SC reader and the emulator look alike.
 */
export type Transmit = (apdu: Buffer) => Promise<Buffer>;

export class TagError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const NDEF_APP = Buffer.from("D2760000850101", "hex");
export const NDEF_FILE = 0xe104;
export const NDEF_FILE_NO = 0x02;
export const KEY_SDM_META_READ = 2;
export const KEY_SDM_FILE_READ = 3;

const SW_OK = 0x9000;
const SW_NATIVE_OK = 0x9100;
const SW_MORE = 0x91af;

function split(response: Buffer): { data: Buffer; sw: number } {
  if (response.length < 2) throw new TagError("short answer from the tag");
  return {
    data: response.subarray(0, response.length - 2),
    sw: response.readUInt16BE(response.length - 2),
  };
}

async function iso(transmit: Transmit, apdu: Buffer): Promise<Buffer> {
  const { data, sw } = split(await transmit(apdu));
  if (sw !== SW_OK) throw new TagError(`tag answered ${sw.toString(16)}`, sw);
  return data;
}

function wrap(cmd: number, header: Buffer, data: Buffer = Buffer.alloc(0)): Buffer {
  const body = Buffer.concat([header, data]);
  return Buffer.concat([
    Buffer.from([0x90, cmd, 0x00, 0x00, body.length]),
    body,
    Buffer.from([0x00]),
  ]);
}

async function native(
  transmit: Transmit,
  cmd: number,
  header: Buffer,
  data?: Buffer,
): Promise<{ data: Buffer; more: boolean }> {
  const { data: out, sw } = split(await transmit(wrap(cmd, header, data)));
  if (sw === SW_MORE) return { data: out, more: true };
  if (sw !== SW_NATIVE_OK)
    throw new TagError(`tag refused command ${cmd.toString(16)}: ${sw.toString(16)}`, sw);
  return { data: out, more: false };
}

/** ISOSelectFile by name, then by id. */
export async function selectNdef(transmit: Transmit): Promise<void> {
  await iso(
    transmit,
    Buffer.concat([
      Buffer.from([0x00, 0xa4, 0x04, 0x00, NDEF_APP.length]),
      NDEF_APP,
      Buffer.from([0x00]),
    ]),
  );
  await iso(
    transmit,
    Buffer.from([0x00, 0xa4, 0x00, 0x0c, 0x02, NDEF_FILE >> 8, NDEF_FILE & 0xff]),
  );
}

/** The tag's 7-byte UID, from the third frame of GetVersion. */
export async function readUid(transmit: Transmit): Promise<Buffer> {
  let step = await native(transmit, 0x60, Buffer.alloc(0));
  if (!step.more) throw new TagError("GetVersion: one frame only");
  step = await native(transmit, 0xaf, Buffer.alloc(0));
  if (!step.more) throw new TagError("GetVersion: two frames only");
  step = await native(transmit, 0xaf, Buffer.alloc(0));
  if (step.data.length < 7) throw new TagError("GetVersion: no UID");
  return Buffer.from(step.data.subarray(0, 7));
}

/** The NDEF file's URL record, as a programmed tag mirrors its SUN message into it. */
export async function readNdefUrl(transmit: Transmit): Promise<string> {
  await selectNdef(transmit);
  const head = await iso(transmit, Buffer.from([0x00, 0xb0, 0x00, 0x00, 0x02]));
  const length = head.readUInt16BE(0);
  const chunks: Buffer[] = [];
  let offset = 2;
  while (offset < 2 + length) {
    const size = Math.min(0xf0, 2 + length - offset);
    chunks.push(await iso(transmit, Buffer.from([0x00, 0xb0, offset >> 8, offset & 0xff, size])));
    offset += size;
  }
  return parseNdefUrl(Buffer.concat(chunks));
}

/** One NDEF URI record (well-known type U, prefix byte 0x04 = https://). */
export function parseNdefUrl(record: Buffer): string {
  // D1 (MB, ME, SR, TNF well-known) · type length 1 · payload length · "U" · prefix byte · the rest.
  if (record.length < 5 || (record[0]! & 0x07) !== 0x01 || record[1] !== 0x01 || record[3] !== 0x55)
    throw new TagError("not an NDEF URL");
  const payloadLength = record[2]!;
  const prefix = record[4] === 0x04 ? "https://" : record[4] === 0x03 ? "http://" : "";
  const rest = record.subarray(5, 4 + payloadLength).toString("ascii");
  return prefix + rest;
}

/** The URL template the tag gets at pairing, and where the mirrored fields sit (offsets into the file, after the 2-byte NLEN). */
export function urlTemplate(host: string): {
  file: Buffer;
  piccDataOffset: number;
  macOffset: number;
} {
  const url = `${host}/t?e=${"0".repeat(32)}&c=${"0".repeat(16)}`;
  const payload = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(url.replace(/^https:\/\//, ""), "ascii"),
  ]);
  const record = Buffer.concat([Buffer.from([0xd1, 0x01, payload.length, 0x55]), payload]);
  const file = Buffer.concat([Buffer.from([record.length >> 8, record.length & 0xff]), record]);
  const text = file.toString("latin1");
  return { file, piccDataOffset: text.indexOf("e=") + 2, macOffset: text.indexOf("c=") + 2 };
}

/** Write the NDEF file in the clear (its write access is free on a factory tag). */
export async function writeNdef(transmit: Transmit, file: Buffer): Promise<void> {
  await selectNdef(transmit);
  for (let offset = 0; offset < file.length; offset += 0xf0) {
    const chunk = file.subarray(offset, Math.min(file.length, offset + 0xf0));
    await iso(
      transmit,
      Buffer.concat([Buffer.from([0x00, 0xd6, offset >> 8, offset & 0xff, chunk.length]), chunk]),
    );
  }
}

/** An authenticated session: the keys and counter EV2 secure messaging runs on. */
export interface Ev2Session {
  readonly ti: Buffer;
  readonly encKey: Buffer;
  readonly macKey: Buffer;
  cmdCtr: number;
}

export function sessionKeys(
  key: Buffer,
  rndA: Buffer,
  rndB: Buffer,
): { encKey: Buffer; macKey: Buffer } {
  const middle = Buffer.concat([
    rndA.subarray(0, 2),
    xorBytes(rndA.subarray(2, 8), rndB.subarray(0, 6)),
    rndB.subarray(6, 16),
    rndA.subarray(8, 16),
  ]);
  const sv1 = Buffer.concat([Buffer.from([0xa5, 0x5a, 0x00, 0x01, 0x00, 0x80]), middle]);
  const sv2 = Buffer.concat([Buffer.from([0x5a, 0xa5, 0x00, 0x01, 0x00, 0x80]), middle]);
  return { encKey: aesCmac(key, sv1), macKey: aesCmac(key, sv2) };
}

const rotateLeft = (b: Buffer) => Buffer.concat([b.subarray(1), b.subarray(0, 1)]);

/** AuthenticateEV2First with one key: the tag proves the key, we prove it too, and both derive the session keys. */
export async function authenticate(
  transmit: Transmit,
  keyNo: number,
  key: Buffer,
  rndA = randomBytes(16),
): Promise<Ev2Session> {
  const first = await native(transmit, 0x71, Buffer.from([keyNo, 0x00]));
  if (!first.more || first.data.length !== 16)
    throw new TagError("AuthenticateEV2First: unexpected first answer");
  const rndB = aesCbcDecrypt(key, Buffer.alloc(BLOCK), first.data);
  const second = await native(
    transmit,
    0xaf,
    Buffer.alloc(0),
    aesCbcEncrypt(key, Buffer.alloc(BLOCK), Buffer.concat([rndA, rotateLeft(rndB)])),
  );
  if (second.data.length !== 32)
    throw new TagError("AuthenticateEV2First: unexpected second answer");
  const plain = aesCbcDecrypt(key, Buffer.alloc(BLOCK), second.data);
  const ti = Buffer.from(plain.subarray(0, 4));
  if (!plain.subarray(4, 20).equals(rotateLeft(rndA)))
    throw new TagError("AuthenticateEV2First: the tag doesn't hold this key");
  return { ti, ...sessionKeys(key, rndA, rndB), cmdCtr: 0 };
}

function counterBytes(ctr: number): Buffer {
  return Buffer.from([ctr & 0xff, (ctr >> 8) & 0xff]);
}

function ivFor(session: Ev2Session, response: boolean): Buffer {
  const label = response ? Buffer.from([0x5a, 0xa5]) : Buffer.from([0xa5, 0x5a]);
  return aesEcb(
    session.encKey,
    Buffer.concat([label, session.ti, counterBytes(session.cmdCtr), Buffer.alloc(8)]),
  );
}

export function padIso(data: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / BLOCK) * BLOCK);
  data.copy(padded);
  padded[data.length] = 0x80;
  return padded;
}

/** One command in CommMode.Full: encrypted data, a MAC over the command, and the answer checked and decrypted. */
export async function fullCommand(
  transmit: Transmit,
  session: Ev2Session,
  cmd: number,
  header: Buffer,
  data: Buffer,
): Promise<Buffer> {
  const encData =
    data.length === 0
      ? Buffer.alloc(0)
      : aesCbcEncrypt(session.encKey, ivFor(session, false), padIso(data));
  const macInput = Buffer.concat([
    Buffer.from([cmd]),
    counterBytes(session.cmdCtr),
    session.ti,
    header,
    encData,
  ]);
  const mac = truncateMac(aesCmac(session.macKey, macInput));
  const { data: out, sw } = split(await transmit(wrap(cmd, header, Buffer.concat([encData, mac]))));
  session.cmdCtr += 1;
  if (sw !== SW_NATIVE_OK)
    throw new TagError(`tag refused command ${cmd.toString(16)}: ${sw.toString(16)}`, sw);
  if (out.length < 8) throw new TagError("answer without a MAC");
  const respData = out.subarray(0, out.length - 8);
  const respMac = out.subarray(out.length - 8);
  const expected = truncateMac(
    aesCmac(
      session.macKey,
      Buffer.concat([Buffer.from([sw & 0xff]), counterBytes(session.cmdCtr), session.ti, respData]),
    ),
  );
  if (!respMac.equals(expected)) throw new TagError("the tag's answer failed its MAC");
  return respData.length === 0
    ? respData
    : aesCbcDecrypt(session.encKey, ivFor(session, true), respData);
}

/** CRC32 as DESFire wants it over a new key: the usual polynomial, no final inversion. */
export function crc32Nk(data: Buffer): Buffer {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const out = Buffer.alloc(4);
  out.writeUInt32LE(crc >>> 0, 0);
  return out;
}

/** ChangeKey for a key other than the one we authenticated with. */
export async function changeKey(
  transmit: Transmit,
  session: Ev2Session,
  keyNo: number,
  oldKey: Buffer,
  newKey: Buffer,
  keyVersion: number,
): Promise<void> {
  const data = Buffer.concat([
    xorBytes(newKey, oldKey),
    Buffer.from([keyVersion]),
    crc32Nk(newKey),
  ]);
  await fullCommand(transmit, session, 0xc4, Buffer.from([keyNo]), data);
}

export interface SdmSettings {
  readonly piccDataOffset: number;
  readonly macOffset: number;
}

const offset3 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);

/** ChangeFileSettings on the NDEF file: SDM on, UID and read counter mirrored, PICC data encrypted with key 2, the MAC with key 3. */
export async function enableSdm(
  transmit: Transmit,
  session: Ev2Session,
  settings: SdmSettings,
): Promise<void> {
  const data = Buffer.concat([
    Buffer.from([0x40]), // FileOption: SDM enabled, CommMode plain
    Buffer.from([0xe0, 0xee]), // AccessRights: ReadWrite free, Change key 0 | Read free, Write free
    Buffer.from([0xc1]), // SDMOptions: UID mirror, read counter, ASCII
    Buffer.from([(KEY_SDM_META_READ << 4) | KEY_SDM_FILE_READ, 0xff]), // SDMAccessRights: MetaRead key 2, FileRead key 3 | RFU, CtrRet none
    offset3(settings.piccDataOffset),
    offset3(settings.macOffset), // SDMMACInputOffset: empty input, the MAC starts where its input would
    offset3(settings.macOffset),
  ]);
  await fullCommand(transmit, session, 0x5f, Buffer.from([NDEF_FILE_NO]), data);
}

export interface ProgramPlan {
  readonly host: string;
  readonly metaReadKey: Buffer;
  readonly fileReadKey: Buffer;
  readonly keyVersion: number;
  /** The factory application master key (all zero on a new tag). */
  readonly masterKey?: Buffer;
}

/** Pair a factory tag: the template URL, the two SDM keys, SDM on. Returns the first SUN message the tag now mirrors. */
export async function programTag(
  transmit: Transmit,
  plan: ProgramPlan,
): Promise<{ uid: Buffer; url: string }> {
  const uid = await readUid(transmit);
  const template = urlTemplate(plan.host);
  await writeNdef(transmit, template.file);
  const session = await authenticate(transmit, 0, plan.masterKey ?? Buffer.alloc(16));
  const zero = Buffer.alloc(16);
  await changeKey(transmit, session, KEY_SDM_META_READ, zero, plan.metaReadKey, plan.keyVersion);
  await changeKey(transmit, session, KEY_SDM_FILE_READ, zero, plan.fileReadKey, plan.keyVersion);
  await enableSdm(transmit, session, {
    piccDataOffset: template.piccDataOffset,
    macOffset: template.macOffset,
  });
  return { uid, url: await readNdefUrl(transmit) };
}
