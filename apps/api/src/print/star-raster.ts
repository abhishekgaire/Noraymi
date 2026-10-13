import { BOLD, FIRST_CHAR, GLYPH_HEIGHT, GLYPH_WIDTH, LAST_CHAR, REGULAR } from "./star-font.js";

/**
 * Star raster for printers that understand nothing else (W-02): the Star
 * TSP100III (TSP143III, "futurePRNT") prints only images, so a ticket for it
 * is the same 32 columns of text drawn into dots and sent with Star's raster
 * commands, from Star's "STAR Graphic Mode Command Specifications" (Rev. 2.31):
 *
 *   ESC * r R            1B 2A 72 52            initialize raster mode
 *   ESC * r A            1B 2A 72 41            enter raster mode
 *   ESC * r P 0 NUL      1B 2A 72 50 30 00      page length 0: continuous paper
 *   ESC * r E 13 NUL     1B 2A 72 45 31 33 00   end of document: feed to the cutter, partial cut
 *   b n1 n2 d1..dk       62 n1 n2 ...           one dot row of k = n1 + n2·256 bytes, then line feed
 *   ESC FF EOT           1B 0C 04               execute the end-of-document mode (the feed and cut)
 *   ESC * r B            1B 2A 72 42            quit raster mode
 *   ESC * r D 1 NUL      1B 2A 72 44 31 00      drive the drawer on external device 1 (the DK port)
 *
 * The numbers in P, E and D are ASCII digits, as the spec says ("decimal notation using ASCII
 * characters"). The page is 576 dots wide (72 mm, 72 bytes a row); 32 characters 16 dots wide
 * fill 512 of them, centred. Characters outside printable ASCII print as "?", as on ESC/POS.
 */
export const DOTS_WIDE = 576;
const BYTES_WIDE = DOTS_WIDE / 8;
export const COLUMNS = 32;
const LEFT_MARGIN_BYTES = (DOTS_WIDE - COLUMNS * GLYPH_WIDTH) / 2 / 8;
/** Blank dot rows after the last line, before the feed to the cutter. */
const TRAILING_ROWS = 24;

const ESC = 0x1b;
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
export const STAR_INIT = [ESC, ...ascii("*rR")];
export const STAR_ENTER = [ESC, ...ascii("*rA")];
export const STAR_CONTINUOUS = [ESC, ...ascii("*rP0"), 0x00];
export const STAR_EOT_PARTIAL_CUT = [ESC, ...ascii("*rE13"), 0x00];
export const STAR_EXECUTE_EOT = [ESC, 0x0c, 0x04];
export const STAR_QUIT = [ESC, ...ascii("*rB")];
export const STAR_DRAWER_1 = [ESC, ...ascii("*rD1"), 0x00];

const decode = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));
const FONTS = { regular: decode(REGULAR), bold: decode(BOLD) };
const GLYPH_BYTES = GLYPH_HEIGHT * 2;

/** Receipt printers' plain ASCII, the same as the ESC/POS tickets print. */
export function printable(s: string): string {
  return s
    .replace(/−/g, "-")
    .replace(/·/g, "-")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "?");
}

export interface RasterLine {
  readonly text: string;
  readonly bold?: boolean;
}

/** One text line as GLYPH_HEIGHT dot rows of BYTES_WIDE bytes each. */
export function rasterRows(line: RasterLine): Uint8Array[] {
  const font = line.bold ? FONTS.bold : FONTS.regular;
  const text = printable(line.text).slice(0, COLUMNS);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < GLYPH_HEIGHT; y++) {
    const row = new Uint8Array(BYTES_WIDE);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const g = code >= FIRST_CHAR && code <= LAST_CHAR ? code - FIRST_CHAR : 0x3f - FIRST_CHAR;
      const at = g * GLYPH_BYTES + y * 2;
      // Each glyph is exactly two bytes wide, so it lands on whole bytes.
      row[LEFT_MARGIN_BYTES + i * 2] = font[at]!;
      row[LEFT_MARGIN_BYTES + i * 2 + 1] = font[at + 1]!;
    }
    rows.push(row);
  }
  return rows;
}

/** `b n1 n2 data` for one dot row, trailing blank bytes left off (at least one byte is sent). */
export function rowCommand(row: Uint8Array): number[] {
  let k = row.length;
  while (k > 1 && row[k - 1] === 0) k--;
  return [0x62, k & 0xff, k >> 8, ...row.subarray(0, k)];
}

/** A whole document: the lines drawn, then the feed and partial cut. */
export function starRasterDocument(lines: readonly RasterLine[]): Uint8Array {
  const out: number[] = [...STAR_INIT, ...STAR_ENTER, ...STAR_CONTINUOUS, ...STAR_EOT_PARTIAL_CUT];
  for (const line of lines) for (const row of rasterRows(line)) out.push(...rowCommand(row));
  for (let i = 0; i < TRAILING_ROWS; i++) out.push(...rowCommand(new Uint8Array(BYTES_WIDE)));
  out.push(...STAR_EXECUTE_EOT, ...STAR_QUIT);
  return Uint8Array.from(out);
}

/** Opening the drawer on a Star raster printer's DK port: nothing is printed or cut. */
export function starRasterDrawerKick(): Uint8Array {
  return Uint8Array.from([...STAR_INIT, ...STAR_ENTER, ...STAR_DRAWER_1, ...STAR_QUIT]);
}
