import { describe, expect, it } from "vitest";
import { escPosQr, roomQrEpos, roomQrEscPos, roomQrText, type RoomQrPayload } from "./room-qr.js";
import { qrGif } from "../jobs/send-email.js";

/** F-07 (D124): the room QR slip carries the printer's own QR command with the join link. */
const slip: RoomQrPayload = {
  venue: "West 4 Boho Karaoke",
  room: "Room 8",
  host: "Sam O.",
  url: "http://localhost:3001/v/west4karaoke/room/abc?code=KX4M7",
  code: "KX4M7",
  scan: ["Scan to order and see your bill", "Escanea para pedir y ver tu cuenta"],
  codeLabel: "Room code",
};

describe("the room QR slip", () => {
  it("prints the QR with ESC/POS GS ( k, storing the join link, and the code in large letters", () => {
    const bytes = Array.from(roomQrEscPos(slip, { reprintN: 0 }));
    const store = escPosQr(slip.url);
    const at = bytes.findIndex((_, i) => bytes.slice(i, i + store.length).join() === store.join());
    expect(at).toBeGreaterThan(0);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain(slip.url);
    expect(text).toContain("Room code: KX4M7");
    expect(text).toContain("Scan to order and see your bill");
    expect(text).toContain("Sam O.");
    // Store: 1D 28 6B pL pH 31 50 30, with pL pH the link's length + 3.
    const n = slip.url.length + 3;
    expect(store.slice(25, 33)).toEqual([0x1d, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30]);
  });

  it("says REPRINT on a reprint, and Epson gets a QR symbol", () => {
    expect(roomQrText(slip, { reprintN: 2 })).toContain("REPRINT 2");
    expect(roomQrEpos(slip, { reprintN: 0, jobId: "j1" })).toContain(
      '<symbol type="qrcode_model_2" level="level_m" width="6">http://localhost:3001/v/west4karaoke/room/abc?code=KX4M7</symbol>',
    );
  });

  it("emails the same link as a GIF QR code", () => {
    const gif = qrGif(slip.url);
    expect(Buffer.from(gif.slice(0, 4)).toString("latin1")).toBe("GIF8");
  });
});
