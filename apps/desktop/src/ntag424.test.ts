import { describe, expect, it } from "vitest";
import { Ntag424Emulator } from "./ntag424-emulator.js";
import {
  authenticate,
  parseNdefUrl,
  programTag,
  readNdefUrl,
  readUid,
  urlTemplate,
} from "./ntag424.js";
import { EmulatedReader, ReaderHub } from "./reader.js";
import { aesCmac, decodePiccData, sunMac, tagFileReadKey, venueBadgeKeys } from "./sun.js";

/**
 * The tag protocol against the emulator: a factory tag is paired in one tap
 * (URL template, keys 2 and 3, SDM on), then every read mirrors a SUN message
 * the venue's keys decode and verify, with the counter going up. The crypto
 * copies are pinned to the published vectors the server's copy uses.
 */
const secret = Buffer.alloc(32, 9);
const venue = "venue-a";

describe("badge crypto (the desktop's copy)", () => {
  it("matches RFC 4493 and AN12196", () => {
    const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
    expect(aesCmac(key, Buffer.alloc(0)).toString("hex")).toBe("bb1d6929e95937287fa37d129b756746");
    const zero = Buffer.alloc(16);
    const picc = decodePiccData(zero, "EF963FF7828658A599F3041510671E88")!;
    expect(picc.uid.toString("hex").toUpperCase()).toBe("04DE5F1EACC040");
    expect(picc.counter).toBe(61);
    expect(sunMac(zero, picc.uid, 61)).toBe("94EED9EE65337086");
  });
});

describe("NTAG 424 DNA pairing and reads", () => {
  const keys = venueBadgeKeys(secret, venue, 1);

  it("reads the UID, authenticates with the factory key, and refuses the wrong one", async () => {
    const tag = new Ntag424Emulator(Buffer.from("04DE5F1EACC040", "hex"));
    expect((await readUid(tag.transmit)).toString("hex").toUpperCase()).toBe("04DE5F1EACC040");
    const session = await authenticate(tag.transmit, 0, Buffer.alloc(16));
    expect(session.ti).toHaveLength(4);
    await expect(authenticate(tag.transmit, 0, Buffer.alloc(16, 1))).rejects.toThrow(
      /doesn't hold this key|91ae/,
    );
  });

  it("programs a factory tag in one tap, and its reads then carry a SUN message the venue's keys verify", async () => {
    const tag = new Ntag424Emulator();
    const fileRead = tagFileReadKey(keys.master, tag.uid);
    const paired = await programTag(tag.transmit, {
      host: "https://staff.west4.example",
      metaReadKey: keys.metaRead,
      fileReadKey: fileRead,
      keyVersion: 1,
    });
    expect(paired.uid.equals(tag.uid)).toBe(true);
    expect(tag.keys[2]!.equals(keys.metaRead)).toBe(true);
    expect(tag.keys[3]!.equals(fileRead)).toBe(true);
    expect(tag.keyVersions).toEqual([0, 0, 1, 1, 0]);
    expect(tag.sdm).not.toBeNull();
    const url = new URL(paired.url);
    expect(url.origin).toBe("https://staff.west4.example");
    const e = url.searchParams.get("e")!;
    const c = url.searchParams.get("c")!;
    const picc = decodePiccData(keys.metaRead, e)!;
    expect(picc.uid.equals(tag.uid)).toBe(true);
    expect(picc.counter).toBe(1);
    expect(sunMac(fileRead, tag.uid, 1)).toBe(c);
    // The next tap: counter 2, a different message.
    const again = new URL(await readNdefUrl(tag.transmit));
    expect(again.searchParams.get("e")).not.toBe(e);
    expect(decodePiccData(keys.metaRead, again.searchParams.get("e")!)!.counter).toBe(2);
    expect(sunMac(fileRead, tag.uid, 2)).toBe(again.searchParams.get("c"));
  });

  it("lays the template out so the mirrored fields land on the placeholders", () => {
    const template = urlTemplate("https://s.example");
    const text = template.file.toString("latin1");
    expect(text.slice(template.piccDataOffset, template.piccDataOffset + 32)).toBe("0".repeat(32));
    expect(text.slice(template.macOffset, template.macOffset + 16)).toBe("0".repeat(16));
    expect(parseNdefUrl(template.file.subarray(2))).toBe(
      `https://s.example/t?e=${"0".repeat(32)}&c=${"0".repeat(16)}`,
    );
  });

  it("the reader hub holds the next tag for a pairing, programs it, and reads taps otherwise", async () => {
    const hub = new ReaderHub();
    const reader = new EmulatedReader(hub);
    expect(hub.list().map((r) => r.name)).toEqual(["Emulated NFC reader"]);
    const taps: string[] = [];
    hub.on("tap", (url) => taps.push(url));
    const uid = "04AABBCCDDEEFF";
    const started = hub.startPairing();
    const presented = reader.present(uid);
    expect((await started).uid).toBe(uid);
    const paired = await hub.finishPairing({
      host: "https://staff.west4.example",
      metaReadKey: keys.metaRead,
      fileReadKey: tagFileReadKey(keys.master, Buffer.from(uid, "hex")),
      keyVersion: 1,
    });
    await presented;
    expect(paired.uid).toBe(uid);
    expect(taps).toEqual([]);
    await reader.present(uid);
    expect(taps).toHaveLength(1);
    expect(decodePiccData(keys.metaRead, new URL(taps[0]!).searchParams.get("e")!)!.counter).toBe(
      2,
    );
    await expect(
      hub.finishPairing({
        host: "x",
        metaReadKey: keys.metaRead,
        fileReadKey: keys.metaRead,
        keyVersion: 1,
      }),
    ).rejects.toThrow(/start the pairing/);
  });
});
