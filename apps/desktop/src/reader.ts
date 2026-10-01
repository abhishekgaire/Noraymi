import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Ntag424Emulator } from "./ntag424-emulator.js";
import { programTag, readNdefUrl, readUid, type ProgramPlan, type Transmit } from "./ntag424.js";

/**
 * The USB NFC readers at the bar and the front desk (M1-30): PC/SC through
 * nfc-pcsc, or the emulator when WEST4_FAKE_READER is set. A tap reads the
 * tag's NDEF URL and raises "tap"; while a pairing is waiting, the next tag
 * presented is programmed instead and the pairing gets its first SUN message.
 */
export interface ReaderInfo {
  readonly name: string;
  /** PC/SC gives no serial; the reader's name, which carries its index, stands in. */
  readonly serial: string;
}

export interface ReaderEvents {
  tap: [url: string, reader: ReaderInfo];
  readers: [list: ReaderInfo[]];
  error: [message: string];
}

type Held = {
  transmit: Transmit;
  uid: Buffer;
  reader: ReaderInfo;
  /** Resolves when the pairing finishes or is cancelled, so the reader's card handler can let the tag go. */
  release: () => void;
};

export class ReaderHub extends EventEmitter<ReaderEvents> {
  private readonly readers = new Map<string, ReaderInfo>();
  private awaiting: { resolve: (r: { uid: string }) => void; reject: (e: Error) => void } | null =
    null;
  private held: Held | null = null;

  list(): ReaderInfo[] {
    return [...this.readers.values()];
  }

  /**
   * Pairing, step one: the next tag presented is held and its UID returned,
   * so the venue can work out that tag's keys. Step two programs it.
   */
  startPairing(): Promise<{ uid: string }> {
    this.cancelPairing();
    return new Promise((resolve, reject) => {
      this.awaiting = { resolve, reject };
    });
  }

  async finishPairing(plan: ProgramPlan): Promise<{ uid: string; url: string }> {
    const held = this.held;
    if (!held) throw new Error("no tag is held: start the pairing first");
    try {
      const paired = await programTag(held.transmit, plan);
      return { uid: paired.uid.toString("hex").toUpperCase(), url: paired.url };
    } finally {
      this.held = null;
      held.release();
    }
  }

  cancelPairing(): void {
    this.awaiting?.reject(new Error("pairing cancelled"));
    this.awaiting = null;
    const held = this.held;
    this.held = null;
    held?.release();
  }

  readerPresent(info: ReaderInfo): void {
    this.readers.set(info.name, info);
    this.emit("readers", this.list());
  }

  readerGone(name: string): void {
    this.readers.delete(name);
    this.emit("readers", this.list());
  }

  /** A tag on a reader: held for a pairing that waits, else its URL is read and raised as a tap. */
  async card(reader: ReaderInfo, transmit: Transmit): Promise<void> {
    const awaiting = this.awaiting;
    if (awaiting) {
      this.awaiting = null;
      try {
        const uid = await readUid(transmit);
        await new Promise<void>((release) => {
          this.held = { transmit, uid, reader, release };
          awaiting.resolve({ uid: uid.toString("hex").toUpperCase() });
          // The tag stays on the reader until the pairing finishes, is cancelled, or a minute passes.
          setTimeout(() => {
            if (this.held?.release === release) this.cancelPairing();
          }, 60_000).unref();
        });
      } catch (error) {
        awaiting.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    try {
      this.emit("tap", await readNdefUrl(transmit), reader);
    } catch (error) {
      this.emit("error", error instanceof Error ? error.message : String(error));
    }
  }
}

const require = createRequire(import.meta.url);

/** nfc-pcsc, loaded only when a real reader is wanted: the binding is optional and built per platform. */
export function startPcsc(hub: ReaderHub): { stop(): void } | null {
  let NFC: new () => EventEmitter;
  try {
    ({ NFC } = require("nfc-pcsc") as { NFC: new () => EventEmitter });
  } catch (error) {
    hub.emit(
      "error",
      `no PC/SC reader support: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  const nfc = new NFC();
  nfc.on(
    "reader",
    (
      reader: EventEmitter & {
        name: string;
        autoProcessing: boolean;
        transmit(data: Buffer, max: number): Promise<Buffer>;
      },
    ) => {
      reader.autoProcessing = false;
      const info = { name: reader.name, serial: reader.name };
      hub.readerPresent(info);
      reader.on("card", () => {
        void hub.card(info, (apdu) => reader.transmit(apdu, 258));
      });
      reader.on("error", (error: Error) => hub.emit("error", `${reader.name}: ${error.message}`));
      reader.on("end", () => hub.readerGone(reader.name));
    },
  );
  nfc.on("error", (error: Error) => hub.emit("error", error.message));
  return { stop: () => (nfc as unknown as { close?: () => void }).close?.() };
}

/** The fake reader: emulated tags presented on demand, for development and tests. */
export class EmulatedReader {
  readonly info: ReaderInfo = { name: "Emulated NFC reader", serial: "emulated-1" };
  readonly tags = new Map<string, Ntag424Emulator>();

  constructor(private readonly hub: ReaderHub) {
    hub.readerPresent(this.info);
  }

  /** A tag by UID (hex), made from the factory on first sight. */
  tag(uidHex: string): Ntag424Emulator {
    let tag = this.tags.get(uidHex);
    if (!tag) {
      tag = new Ntag424Emulator(Buffer.from(uidHex, "hex"));
      this.tags.set(uidHex, tag);
    }
    return tag;
  }

  async present(uidHex: string): Promise<void> {
    await this.hub.card(this.info, this.tag(uidHex).transmit);
  }
}
