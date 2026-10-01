import { randomBytes } from "node:crypto";
import {
  KEY_SDM_FILE_READ,
  KEY_SDM_META_READ,
  NDEF_APP,
  crc32Nk,
  padIso,
  sessionKeys,
  type Transmit,
} from "./ntag424.js";
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  aesCmac,
  aesEcb,
  BLOCK,
  encodePiccData,
  sunMac,
  truncateMac,
  xorBytes,
} from "./sun.js";

/**
 * A model of an NTAG 424 DNA for tests and the demo: five keys (all zero
 * from the factory), the NDEF file, SDM settings, and the read counter. It
 * answers the APDUs the desktop sends, checks EV2 secure messaging the way
 * the chip does, and once SDM is on it mirrors a fresh SUN message into every
 * NDEF read. The desktop's fake reader (WEST4_FAKE_READER) presents these.
 */
const SW = {
  ok: Buffer.from([0x90, 0x00]),
  nativeOk: Buffer.from([0x91, 0x00]),
  more: Buffer.from([0x91, 0xaf]),
  authError: Buffer.from([0x91, 0xae]),
  integrity: Buffer.from([0x91, 0x1e]),
  illegal: Buffer.from([0x91, 0x1c]),
  notFound: Buffer.from([0x6a, 0x82]),
};

const rotateLeft = (b: Buffer) => Buffer.concat([b.subarray(1), b.subarray(0, 1)]);

interface Pending {
  readonly keyNo: number;
  readonly rndB: Buffer;
}

interface Session {
  readonly keyNo: number;
  readonly ti: Buffer;
  readonly encKey: Buffer;
  readonly macKey: Buffer;
  cmdCtr: number;
}

export class Ntag424Emulator {
  readonly keys: Buffer[] = Array.from({ length: 5 }, () => Buffer.alloc(16));
  readonly keyVersions: number[] = [0, 0, 0, 0, 0];
  ndef = Buffer.alloc(256);
  sdm: { piccDataOffset: number; macOffset: number } | null = null;
  readCounter = 0;
  private versionStep = 0;
  private pending: Pending | null = null;
  private session: Session | null = null;

  constructor(readonly uid: Buffer = Buffer.concat([Buffer.from([0x04]), randomBytes(6)])) {}

  readonly transmit: Transmit = async (apdu) => this.handle(apdu);

  /** The NDEF file as a reader sees it now: with SDM on, a fresh SUN message for this read. */
  private mirrored(): Buffer {
    const file = Buffer.from(this.ndef);
    if (!this.sdm) return file;
    this.readCounter += 1;
    const picc = encodePiccData(this.keys[KEY_SDM_META_READ]!, this.uid, this.readCounter);
    const mac = sunMac(this.keys[KEY_SDM_FILE_READ]!, this.uid, this.readCounter);
    file.write(picc, this.sdm.piccDataOffset, "ascii");
    file.write(mac, this.sdm.macOffset, "ascii");
    return file;
  }

  private handle(apdu: Buffer): Buffer {
    const cla = apdu[0]!;
    const ins = apdu[1]!;
    if (cla === 0x00) return this.iso(ins, apdu);
    if (cla === 0x90) return this.native(ins, apdu);
    return SW.illegal;
  }

  private snapshot: Buffer | null = null;

  private iso(ins: number, apdu: Buffer): Buffer {
    const lc = apdu[4] ?? 0;
    const data = apdu.subarray(5, 5 + lc);
    if (ins === 0xa4) {
      if (apdu[2] === 0x04) return data.equals(NDEF_APP) ? SW.ok : SW.notFound;
      if (apdu[2] === 0x00) {
        this.snapshot = null;
        return data.readUInt16BE(0) === 0xe104 ? SW.ok : SW.notFound;
      }
      return SW.illegal;
    }
    if (ins === 0xb0) {
      const offset = apdu.readUInt16BE(2);
      const le = apdu[4] === 0 ? 256 : apdu[4]!;
      // One SUN message per read of the file: the first chunk after a select takes the snapshot.
      if (offset === 0 || !this.snapshot) this.snapshot = this.mirrored();
      return Buffer.concat([this.snapshot.subarray(offset, offset + le), SW.ok]);
    }
    if (ins === 0xd6) {
      const offset = apdu.readUInt16BE(2);
      data.copy(this.ndef, offset);
      return SW.ok;
    }
    return SW.illegal;
  }

  private native(ins: number, apdu: Buffer): Buffer {
    const lc = apdu[4] ?? 0;
    const data = apdu.subarray(5, 5 + lc);
    switch (ins) {
      case 0x60: {
        this.versionStep = 1;
        return Buffer.concat([Buffer.from("0404023000110500", "hex"), SW.more]);
      }
      case 0xaf: {
        if (this.versionStep === 1) {
          this.versionStep = 2;
          return Buffer.concat([Buffer.from("0404020100130500", "hex"), SW.more]);
        }
        if (this.versionStep === 2) {
          this.versionStep = 0;
          return Buffer.concat([this.uid, Buffer.from("0000000000000000", "hex"), SW.nativeOk]);
        }
        if (this.pending) return this.finishAuth(data);
        return SW.illegal;
      }
      case 0x71: {
        const keyNo = data[0]!;
        if (keyNo > 4) return SW.illegal;
        const rndB = randomBytes(16);
        this.pending = { keyNo, rndB };
        this.session = null;
        return Buffer.concat([
          aesCbcEncrypt(this.keys[keyNo]!, Buffer.alloc(BLOCK), rndB),
          SW.more,
        ]);
      }
      case 0xc4:
        return this.full(ins, data, 1, (session, header, plain) =>
          this.changeKey(session, header[0]!, plain),
        );
      case 0x5f:
        return this.full(ins, data, 1, (_session, header, plain) =>
          this.changeFileSettings(header[0]!, plain),
        );
      default:
        return SW.illegal;
    }
  }

  private finishAuth(data: Buffer): Buffer {
    const { keyNo, rndB } = this.pending!;
    this.pending = null;
    const key = this.keys[keyNo]!;
    const plain = aesCbcDecrypt(key, Buffer.alloc(BLOCK), data);
    const rndA = plain.subarray(0, 16);
    if (!plain.subarray(16, 32).equals(rotateLeft(rndB))) return SW.authError;
    const ti = randomBytes(4);
    const keys = sessionKeys(key, rndA, rndB);
    this.session = { keyNo, ti, ...keys, cmdCtr: 0 };
    const answer = Buffer.concat([ti, rotateLeft(rndA), Buffer.alloc(6), Buffer.alloc(6)]);
    return Buffer.concat([aesCbcEncrypt(key, Buffer.alloc(BLOCK), answer), SW.nativeOk]);
  }

  /** CommMode.Full on the tag's side: MAC checked, data decrypted, the answer MACed. */
  private full(
    cmd: number,
    body: Buffer,
    headerLength: number,
    run: (session: Session, header: Buffer, plain: Buffer) => Buffer | null,
  ): Buffer {
    const session = this.session;
    if (!session) return SW.authError;
    const header = body.subarray(0, headerLength);
    const encData = body.subarray(headerLength, body.length - 8);
    const mac = body.subarray(body.length - 8);
    const ctr = Buffer.from([session.cmdCtr & 0xff, (session.cmdCtr >> 8) & 0xff]);
    const expected = truncateMac(
      aesCmac(
        session.macKey,
        Buffer.concat([Buffer.from([cmd]), ctr, session.ti, header, encData]),
      ),
    );
    if (!mac.equals(expected)) {
      this.session = null;
      return SW.integrity;
    }
    const iv = aesEcb(
      session.encKey,
      Buffer.concat([Buffer.from([0xa5, 0x5a]), session.ti, ctr, Buffer.alloc(8)]),
    );
    const plain =
      encData.length === 0 ? Buffer.alloc(0) : aesCbcDecrypt(session.encKey, iv, encData);
    const problem = run(session, header, plain);
    session.cmdCtr += 1;
    if (problem) return problem;
    const ctr2 = Buffer.from([session.cmdCtr & 0xff, (session.cmdCtr >> 8) & 0xff]);
    const respMac = truncateMac(
      aesCmac(session.macKey, Buffer.concat([Buffer.from([0x00]), ctr2, session.ti])),
    );
    return Buffer.concat([respMac, SW.nativeOk]);
  }

  private changeKey(session: Session, keyNo: number, plain: Buffer): Buffer | null {
    if (keyNo === session.keyNo) {
      this.keys[keyNo] = Buffer.from(plain.subarray(0, 16));
      this.keyVersions[keyNo] = plain[16]!;
      return null;
    }
    const newKey = xorBytes(plain.subarray(0, 16), this.keys[keyNo]!);
    const version = plain[16]!;
    const crc = plain.subarray(17, 21);
    if (!crc.equals(crc32Nk(newKey))) return SW.integrity;
    if (
      !plain.subarray(21).equals(padIso(Buffer.alloc(0)).subarray(0, plain.length - 21)) &&
      plain[21] !== 0x80
    )
      return SW.integrity;
    this.keys[keyNo] = newKey;
    this.keyVersions[keyNo] = version;
    return null;
  }

  private changeFileSettings(fileNo: number, plain: Buffer): Buffer | null {
    if (fileNo !== 0x02) return SW.illegal;
    const fileOption = plain[0]!;
    if (!(fileOption & 0x40)) {
      this.sdm = null;
      return null;
    }
    const sdmOptions = plain[3]!;
    if ((sdmOptions & 0xc1) !== 0xc1) return SW.illegal;
    const access = plain[4]!;
    if (access >> 4 !== KEY_SDM_META_READ || (access & 0x0f) !== KEY_SDM_FILE_READ)
      return SW.illegal;
    const off = (i: number) => plain[i]! | (plain[i + 1]! << 8) | (plain[i + 2]! << 16);
    this.sdm = { piccDataOffset: off(6), macOffset: off(12) };
    return null;
  }
}
