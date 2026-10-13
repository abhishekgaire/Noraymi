import { starRasterDocument, starRasterDrawerKick } from "./star-raster.js";
import {
  drawerKickEscPos,
  isBoldLine,
  receiptEscPos,
  receiptPrintLines,
  ticketEscPos,
  ticketLines,
  type ReceiptPayload,
  type TicketPayload,
} from "./ticket.js";

/**
 * What a desktop-hosted printer is sent (W-02): the job in the printer's own
 * command set. ESC/POS for most receipt printers (the Epson TM-T88V, the
 * Rongta RP326); Star raster for the Star TSP100III, which understands
 * nothing else. Cloud printers (CloudPRNT, Server Direct Print) keep their own
 * formats in routes/print.ts.
 */
export type CommandSet = "escpos" | "star_raster";
export const COMMAND_SETS: readonly CommandSet[] = ["escpos", "star_raster"];

/** The Star TSP100 family (TSP143III and the rest) prints Star raster only; anything else is taken for ESC/POS. */
export function suggestCommandSet(printerName: string): CommandSet {
  return /TSP\s?-?1(00|43)|futurePRNT/i.test(printerName) ? "star_raster" : "escpos";
}

/** The ticket for a Star raster printer: the same lines and bold lines, drawn as dots. */
export function ticketStarRaster(
  p: TicketPayload,
  opts: { timeZone: string; reprintN: number },
): Uint8Array {
  return starRasterDocument(ticketLines(p, opts).map((text) => ({ text, bold: isBoldLine(text) })));
}

/** The receipt for a Star raster printer: its 32-wide lines, drawn as dots. */
export function receiptStarRaster(p: ReceiptPayload, opts: { reprintN: number }): Uint8Array {
  return starRasterDocument(receiptPrintLines(p, opts).map((text) => ({ text })));
}

/** Laid out like a receipt: receipts, the X and Z reports and the break-glass card. */
const RECEIPT_KINDS = new Set(["receipt", "x_report", "z_report", "break_glass"]);

export function hostJobBytes(
  job: { kind: string; payload: unknown; reprint_n: number },
  commandSet: CommandSet,
  timeZone: string,
): Uint8Array {
  const star = commandSet === "star_raster";
  if (job.kind === "drawer") return star ? starRasterDrawerKick() : drawerKickEscPos();
  if (RECEIPT_KINDS.has(job.kind)) {
    const p = job.payload as ReceiptPayload;
    return star
      ? receiptStarRaster(p, { reprintN: job.reprint_n })
      : receiptEscPos(p, { reprintN: job.reprint_n });
  }
  const t = job.payload as TicketPayload;
  return star
    ? ticketStarRaster(t, { timeZone, reprintN: job.reprint_n })
    : ticketEscPos(t, { timeZone, reprintN: job.reprint_n });
}
