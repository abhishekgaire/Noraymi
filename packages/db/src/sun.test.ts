import { describe, expect, it } from "vitest";
import {
  aesCmac,
  decodePiccData,
  demoBadgeUid,
  encodeSun,
  parseSun,
  sunMac,
  tagFileReadKey,
  venueBadgeKeys,
  verifySunMac,
} from "./sun.js";

/**
 * NXP AN12196 (NTAG 424 DNA features and hints), the SDM example with
 * encrypted PICC data and all-zero keys:
 *   https://ntag.nxp.com/424?e=EF963FF7828658A599F3041510671E88&c=94EED9EE65337086
 * decrypts to UID 04DE5F1EACC040 and read counter 61 (3Dh), and the MAC checks.
 */
const ZERO = Buffer.alloc(16);
const AN12196_URL =
  "https://ntag.nxp.com/424?e=EF963FF7828658A599F3041510671E88&c=94EED9EE65337086";

describe("AES-CMAC (RFC 4493 vectors)", () => {
  const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
  it("matches the published vectors", () => {
    expect(aesCmac(key, Buffer.alloc(0)).toString("hex")).toBe("bb1d6929e95937287fa37d129b756746");
    expect(
      aesCmac(key, Buffer.from("6bc1bee22e409f96e93d7e117393172a", "hex")).toString("hex"),
    ).toBe("070a16b46b4d4144f79bdd9dd04a287c");
    expect(
      aesCmac(
        key,
        Buffer.from(
          "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411",
          "hex",
        ),
      ).toString("hex"),
    ).toBe("dfa66747de9ae63030ca32611497c827");
  });
});

describe("SUN messages (AN12196)", () => {
  it("decrypts the example's PICC data to its UID and counter", () => {
    const sun = parseSun(AN12196_URL)!;
    const picc = decodePiccData(ZERO, sun.piccData)!;
    expect(picc.uid.toString("hex").toUpperCase()).toBe("04DE5F1EACC040");
    expect(picc.counter).toBe(61);
  });

  it("checks the example's MAC with the all-zero file-read key", () => {
    const uid = Buffer.from("04DE5F1EACC040", "hex");
    expect(sunMac(ZERO, uid, 61)).toBe("94EED9EE65337086");
    expect(verifySunMac(ZERO, uid, 61, "94EED9EE65337086")).toBe(true);
    expect(verifySunMac(ZERO, uid, 62, "94EED9EE65337086")).toBe(false);
    expect(verifySunMac(Buffer.alloc(16, 1), uid, 61, "94EED9EE65337086")).toBe(false);
  });

  it("parses the URL form and the two-parameter form, and refuses anything else", () => {
    expect(parseSun(AN12196_URL)).toEqual({
      piccData: "EF963FF7828658A599F3041510671E88",
      cmac: "94EED9EE65337086",
    });
    expect(
      parseSun({ picc_data: "ef963ff7828658a599f3041510671e88", cmac: "94eed9ee65337086" }),
    ).toEqual({
      piccData: "EF963FF7828658A599F3041510671E88",
      cmac: "94EED9EE65337086",
    });
    expect(parseSun("https://x/?e=zz&c=1")).toBeNull();
    expect(parseSun({ picc_data: "EF96" })).toBeNull();
  });

  it("a fake tag round-trips through the venue's derived keys, and a different key or counter fails", () => {
    const keys = venueBadgeKeys(Buffer.alloc(32, 7), "venue-1", 1);
    const uid = demoBadgeUid("badge_maya");
    expect(uid).toHaveLength(7);
    expect(uid[0]).toBe(0x04);
    const fileRead = tagFileReadKey(keys.master, uid);
    const tap = encodeSun({ metaRead: keys.metaRead, fileRead, uid, counter: 42 });
    const picc = decodePiccData(keys.metaRead, tap.piccData)!;
    expect(picc.uid.equals(uid)).toBe(true);
    expect(picc.counter).toBe(42);
    expect(verifySunMac(fileRead, uid, 42, tap.cmac)).toBe(true);
    // Another tag's key: Maya's UID with Diego's key is a copied badge.
    const other = tagFileReadKey(keys.master, demoBadgeUid("badge_diego"));
    expect(verifySunMac(other, uid, 42, tap.cmac)).toBe(false);
    // Another venue or key version decrypts to nonsense, not a UID-and-counter message.
    const v2 = venueBadgeKeys(Buffer.alloc(32, 7), "venue-1", 2);
    expect(decodePiccData(v2.metaRead, tap.piccData)?.uid.equals(uid) ?? false).toBe(false);
  });
});
