/**
 * The bar ticket (M3-13; spec 09 · Tickets): the full item names (never the
 * POS button names), choices, quantities, the room, the time, who accepted
 * it and the ID status; "REPRINT 2" and so on on a reprint, "REMAKE" on a
 * remade order. Rendered as plain text for Star CloudPRNT and as ePOS-Print
 * XML for Epson Server Direct Print, from the same lines.
 */
export interface TicketPayload {
  readonly order_id?: string;
  readonly room?: string | null;
  readonly remake?: boolean;
  readonly accepted_by?: string | null;
  readonly accepted_at?: string | null;
  readonly ids?: { checked: number; party: number } | null;
  readonly lines?: readonly {
    qty: number;
    name: string;
    options: readonly string[];
    notes?: string | null;
  }[];
  /** A test ticket from Admin → Printers & devices. */
  readonly test?: { printer: string };
}

const WIDTH = 32;

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

/** The ticket as lines of at most 32 characters, the width of an 80 mm printer's normal font. */
export function ticketLines(
  p: TicketPayload,
  opts: { timeZone: string; reprintN: number },
): string[] {
  const out: string[] = [];
  const rule = "-".repeat(WIDTH);
  if (opts.reprintN > 0) out.push(`REPRINT ${opts.reprintN}`);
  if (p.test) {
    out.push("TEST TICKET", p.test.printer, rule);
    return out;
  }
  if (p.remake) out.push("REMAKE");
  const time = p.accepted_at ? clock(p.accepted_at, opts.timeZone) : "";
  const room = (p.room ?? "").toUpperCase();
  out.push(room + " ".repeat(Math.max(1, WIDTH - room.length - time.length)) + time);
  if (p.accepted_by) out.push(`Accepted by ${p.accepted_by}`);
  if (p.ids)
    out.push(
      `ID ${p.ids.checked >= p.ids.party ? "OK" : "CHECK"} ${p.ids.checked} of ${p.ids.party}`,
    );
  out.push(rule);
  for (const l of p.lines ?? []) {
    out.push(`${l.qty} x ${l.name}`);
    for (const o of l.options) out.push(`    ${o}`);
    if (l.notes) out.push(`    "${l.notes}"`);
  }
  out.push(rule);
  return out;
}

export function ticketText(p: TicketPayload, opts: { timeZone: string; reprintN: number }): string {
  return `${ticketLines(p, opts).join("\n")}\n\n\n`;
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** ePOS-Print XML for Server Direct Print, with the job id the printer reports back. */
export function ticketEpos(
  p: TicketPayload,
  opts: { timeZone: string; reprintN: number; jobId: string },
): string {
  const body = ticketLines(p, opts)
    .map((line) => `<text>${xml(line)}&#10;</text>`)
    .join("");
  return (
    `<PrintRequestInfo Version="2.00"><ePOSPrint><Parameter><devid>local_printer</devid><timeout>10000</timeout>` +
    `<printjobid>${xml(opts.jobId)}</printjobid></Parameter><PrintData>` +
    `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">${body}<feed line="3"/><cut type="feed"/></epos-print>` +
    `</PrintData></ePOSPrint></PrintRequestInfo>`
  );
}

/**
 * Raw ESC/POS for a USB printer on a desktop-app host (M3-14): initialize,
 * the ticket's lines in plain ASCII (receipt printers' code pages), the
 * reprint or remake line in bold, feed and cut.
 */
export function ticketEscPos(
  p: TicketPayload,
  opts: { timeZone: string; reprintN: number },
): Uint8Array {
  const ESC = 0x1b;
  const GS = 0x1d;
  const bytes: number[] = [ESC, 0x40];
  const ascii = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\x20-\x7e]/g, "?");
  for (const line of ticketLines(p, opts)) {
    const bold = /^(REPRINT \d+|REMAKE|TEST TICKET)$/.test(line);
    if (bold) bytes.push(ESC, 0x45, 1);
    for (const ch of ascii(line)) bytes.push(ch.charCodeAt(0));
    bytes.push(0x0a);
    if (bold) bytes.push(ESC, 0x45, 0);
  }
  bytes.push(ESC, 0x64, 3, GS, 0x56, 0x42, 0);
  return Uint8Array.from(bytes);
}
