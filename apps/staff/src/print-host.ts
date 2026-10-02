import { signedApi, type StoredDevice } from "./device.js";
import { attachedId } from "./heartbeat.js";

/**
 * The print host (M3-14; spec 09 · Tickets): inside the desktop app on the bar
 * and front-desk computers, every 3 seconds, each USB printer the computer
 * hosts asks the API for its next ticket over the device's signed channel,
 * prints the ESC/POS bytes raw, and confirms it, or reports that it failed so
 * the bar sees "Ticket didn't print · Reprint". Outside the desktop app it
 * does nothing.
 */
export const PRINT_HOST_MS = 3_000;

interface NextJob {
  readonly job: { readonly id: string; readonly escpos: string } | null;
}

export async function printTurn(device: StoredDevice): Promise<number> {
  const shell = typeof window === "undefined" ? undefined : window.west4;
  if (!shell?.printers || !shell.print) return 0;
  let printed = 0;
  for (const printer of await shell.printers().catch(() => [])) {
    const id = await attachedId(device, "printer", printer);
    if (!id) continue;
    const next = await signedApi<NextJob>(
      device,
      "POST",
      `/v1/venues/${device.venueId}/print-host/next`,
      {
        printer_id: id,
      },
    ).catch(() => null);
    if (!next?.job) continue;
    let failure: string | null = null;
    try {
      await shell.print(printer.serial, next.job.escpos);
      printed++;
    } catch (error) {
      failure =
        error instanceof Error ? error.message.slice(0, 200) : "the printer refused the ticket";
    }
    await signedApi(device, "POST", `/v1/venues/${device.venueId}/print-host/jobs/${next.job.id}`, {
      printer_id: id,
      printed: failure === null,
      failure,
    }).catch(() => null);
  }
  return printed;
}

/** Start the loop; returns the stop. One turn at a time, so a slow printer never doubles up. */
export function startPrintHost(device: StoredDevice): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void printTurn(device).finally(() => {
      busy = false;
    });
  }, PRINT_HOST_MS);
  return () => clearInterval(timer);
}
