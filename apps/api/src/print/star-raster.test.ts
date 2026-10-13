import { describe, expect, it } from "vitest";
import { hostJobBytes, suggestCommandSet } from "./host-bytes.js";
import {
  COLUMNS,
  rasterRows,
  rowCommand,
  starRasterDocument,
  starRasterDrawerKick,
} from "./star-raster.js";
import { GLYPH_HEIGHT } from "./star-font.js";
import { drawerKickEscPos, receiptEscPos, ticketEscPos } from "./ticket.js";

const hex = (bytes: Uint8Array | number[]) => Buffer.from(Uint8Array.from(bytes)).toString("hex");

/** The byte sequences from Star's "STAR Graphic Mode Command Specifications", Rev. 2.31. */
const SPEC = {
  initialize: "1b2a7252", // ESC * r R
  enter: "1b2a7241", // ESC * r A
  continuous: "1b2a72503000", // ESC * r P "0" NUL
  eotPartialCut: "1b2a7245313300", // ESC * r E "13" NUL: feed and partial cut
  executeEot: "1b0c04", // ESC FF EOT
  quit: "1b2a7242", // ESC * r B
  drawer1: "1b2a72443100", // ESC * r D "1" NUL
};

/** Splits a document's body into its `b n1 n2 data` rows, checking each count. */
function rows(body: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < body.length) {
    expect(body[i]).toBe(0x62);
    const k = body[i + 1]! + body[i + 2]! * 256;
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThanOrEqual(72);
    out.push(body.subarray(i + 3, i + 3 + k));
    i += 3 + k;
  }
  expect(i).toBe(body.length);
  return out;
}

describe("Star raster for the TSP100III (W-02)", () => {
  const head = SPEC.initialize + SPEC.enter + SPEC.continuous + SPEC.eotPartialCut;
  const tail = SPEC.executeEot + SPEC.quit;

  it("a document opens raster mode on continuous paper and ends with the feed, the partial cut and quit", () => {
    const doc = hex(starRasterDocument([{ text: "KITCHEN", bold: true }, { text: "1 x Fries" }]));
    expect(doc.startsWith(head)).toBe(true);
    expect(doc.endsWith(tail)).toBe(true);
  });

  it("each text line is 32 dot rows of `b n1 n2 data`, at most 72 bytes (576 dots) wide", () => {
    const doc = starRasterDocument([{ text: "Room 9" }, { text: "" }]);
    const body = doc.subarray(head.length / 2, doc.length - tail.length / 2);
    const all = rows(body);
    expect(all.length).toBe(2 * GLYPH_HEIGHT + 24);
    // Something is drawn on the first line; the blank line and the trailing feed are a byte of 0.
    expect(all.slice(0, GLYPH_HEIGHT).some((r) => r.some((b) => b !== 0))).toBe(true);
    expect(all.slice(GLYPH_HEIGHT).every((r) => r.length === 1 && r[0] === 0)).toBe(true);
  });

  it("a row command counts its bytes in n1 + n2·256 and leaves trailing blank bytes off", () => {
    const row = new Uint8Array(72);
    row[5] = 0xff;
    expect(rowCommand(row)).toEqual([0x62, 6, 0, 0, 0, 0, 0, 0, 0xff]);
    expect(rowCommand(new Uint8Array(72))).toEqual([0x62, 1, 0, 0]);
  });

  it("32 columns fit centred: nothing drawn in the 4-byte margins, bold is darker than regular", () => {
    const full = "W".repeat(COLUMNS + 5);
    const drawn = rasterRows({ text: full });
    for (const r of drawn) {
      expect([...r.subarray(0, 4), ...r.subarray(68)].every((b) => b === 0)).toBe(true);
    }
    const dots = (rs: Uint8Array[]) =>
      rs.reduce((n, r) => n + r.reduce((m, b) => m + b.toString(2).replace(/0/g, "").length, 0), 0);
    expect(dots(rasterRows({ text: "TEST", bold: true }))).toBeGreaterThan(
      dots(rasterRows({ text: "TEST" })),
    );
  });

  it("characters outside printable ASCII print as they do on ESC/POS: accents dropped, the rest ?", () => {
    expect(hex(rasterRows({ text: "Jalapeño" }).flatMap((r) => [...r]))).toBe(
      hex(rasterRows({ text: "Jalapeno" }).flatMap((r) => [...r])),
    );
    expect(hex(rasterRows({ text: "☃" }).flatMap((r) => [...r]))).toBe(
      hex(rasterRows({ text: "?" }).flatMap((r) => [...r])),
    );
  });

  it("the drawer kick drives external device 1 inside raster mode and prints nothing", () => {
    expect(hex(starRasterDrawerKick())).toBe(
      SPEC.initialize + SPEC.enter + SPEC.drawer1 + SPEC.quit,
    );
  });

  it("a Star printer's jobs come as raster; an ESC/POS printer's are unchanged", () => {
    const ticket = { kind: "ticket", payload: { test: { printer: "Kitchen" } }, reprint_n: 0 };
    const tz = "America/New_York";
    expect(hex(hostJobBytes(ticket, "escpos", tz))).toBe(
      hex(ticketEscPos(ticket.payload, { timeZone: tz, reprintN: 0 })),
    );
    expect(hex(hostJobBytes(ticket, "star_raster", tz)).startsWith(head)).toBe(true);
    const receipt = { kind: "receipt", payload: { lines: ["Total  $618.60"] }, reprint_n: 1 };
    expect(hex(hostJobBytes(receipt, "escpos", tz))).toBe(
      hex(receiptEscPos(receipt.payload, { reprintN: 1 })),
    );
    expect(hex(hostJobBytes(receipt, "star_raster", tz)).endsWith(tail)).toBe(true);
    const drawer = { kind: "drawer", payload: {}, reprint_n: 0 };
    expect(hex(hostJobBytes(drawer, "escpos", tz))).toBe(hex(drawerKickEscPos()));
    expect(hex(hostJobBytes(drawer, "star_raster", tz))).toBe(hex(starRasterDrawerKick()));
  });

  it("a TSP100 or TSP143 is suggested Star raster from its name; the Epson and the Rongta ESC/POS", () => {
    expect(suggestCommandSet("Star TSP143IIIU")).toBe("star_raster");
    expect(suggestCommandSet("TSP100III futurePRNT")).toBe("star_raster");
    expect(suggestCommandSet("Star_TSP143IIILAN")).toBe("star_raster");
    expect(suggestCommandSet("EPSON TM-T88V Receipt")).toBe("escpos");
    expect(suggestCommandSet("Kitchen RP326")).toBe("escpos");
  });
});
