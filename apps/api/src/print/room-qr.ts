/**
 * The room's join QR slip (F-07; D124; spec 09 · Room QR slip): the venue, the room, the host, a
 * QR code of the join link with the room's code, the code in large letters, and "Scan to order and
 * see your bill" in the venue's languages. The QR is the printer's own command (ESC/POS `GS ( k`
 * on a USB printer, `<symbol>` in Epson's ePOS-Print XML), never an image. Star's CloudPRNT gets the
 * plain text with the link spelled out (cautious default: no QR markup until tested on a Star).
 */
export interface RoomQrPayload {
  readonly venue: string;
  readonly room: string;
  readonly host: string | null;
  /** The join link with the room's code, `/v/{slug}/room/{roomId}?code=…`. */
  readonly url: string;
  readonly code: string;
  /** "Scan to order and see your bill", one line per venue language. */
  readonly scan: readonly string[];
  /** "Room code", in the venue's first language. */
  readonly codeLabel: string;
  readonly training?: boolean;
}

const ascii = (s: string) =>
  s
    .replace(/·/g, "-")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "?");

/** The slip's text lines around the QR, for a plain-text printer and for tests. */
export function roomQrLines(
  p: RoomQrPayload,
  opts: { reprintN: number },
): {
  readonly head: readonly string[];
  readonly tail: readonly string[];
} {
  const head = [
    p.venue,
    p.room,
    ...(p.host ? [p.host] : []),
    ...(opts.reprintN > 0 ? [`REPRINT ${opts.reprintN}`] : []),
    ...(p.training ? ["TRAINING - NOT REAL"] : []),
  ];
  const tail = [...p.scan, `${p.codeLabel}: ${p.code}`];
  return { head, tail };
}

export function roomQrText(p: RoomQrPayload, opts: { reprintN: number }): string {
  const { head, tail } = roomQrLines(p, opts);
  return `${[...head, "", p.url, "", ...tail].join("\n")}\n\n\n`;
}

/** The QR as ESC/POS: model 2, module size 6, error correction M, store the link, print it. */
export function escPosQr(data: string): number[] {
  const GS = 0x1d;
  const bytes = Array.from(new TextEncoder().encode(data));
  const len = bytes.length + 3;
  return [
    ...[GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00],
    ...[GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06],
    ...[GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31],
    ...[GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...bytes],
    ...[GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30],
  ];
}

export function roomQrEscPos(p: RoomQrPayload, opts: { reprintN: number }): Uint8Array {
  const ESC = 0x1b;
  const GS = 0x1d;
  const { head, tail } = roomQrLines(p, opts);
  const text = (s: string) => [...ascii(s)].map((ch) => ch.charCodeAt(0));
  const bytes: number[] = [ESC, 0x40, ESC, 0x61, 1];
  head.forEach((line, i) => {
    if (i === 1) bytes.push(ESC, 0x45, 1, GS, 0x21, 0x11);
    bytes.push(...text(line), 0x0a);
    if (i === 1) bytes.push(GS, 0x21, 0x00, ESC, 0x45, 0);
  });
  bytes.push(0x0a, ...escPosQr(p.url), 0x0a);
  for (const line of tail.slice(0, -1)) bytes.push(...text(line), 0x0a);
  // The code in large letters, for a guest who types it.
  bytes.push(GS, 0x21, 0x11, ...text(tail[tail.length - 1]!), 0x0a, GS, 0x21, 0x00);
  bytes.push(ESC, 0x61, 0, ESC, 0x64, 3, GS, 0x56, 0x42, 0);
  return Uint8Array.from(bytes);
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function roomQrEpos(p: RoomQrPayload, opts: { reprintN: number; jobId: string }): string {
  const { head, tail } = roomQrLines(p, opts);
  const lines = (ls: readonly string[]) => ls.map((l) => `<text>${xml(l)}&#10;</text>`).join("");
  return (
    `<PrintRequestInfo Version="2.00"><ePOSPrint><Parameter><devid>local_printer</devid><timeout>10000</timeout>` +
    `<printjobid>${xml(opts.jobId)}</printjobid></Parameter><PrintData>` +
    `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print"><text align="center"/>${lines(head)}` +
    `<feed line="1"/><symbol type="qrcode_model_2" level="level_m" width="6">${xml(p.url)}</symbol><feed line="1"/>` +
    `${lines(tail.slice(0, -1))}<text dw="true" dh="true"/>${lines(tail.slice(-1))}<text dw="false" dh="false"/>` +
    `<feed line="3"/><cut type="feed"/></epos-print></PrintData></ePOSPrint></PrintRequestInfo>`
  );
}
