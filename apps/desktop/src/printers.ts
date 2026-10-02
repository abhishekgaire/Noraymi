import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * USB printers on a desktop-app host (M3-14; spec 09 · Tickets). The bar and
 * front-desk computers print their station's tickets as raw ESC/POS on the
 * USB printer beside them. On macOS and Linux the printer is a CUPS queue on
 * a usb:// device, written to raw; WEST4_FAKE_PRINTER=1 runs a virtual printer
 * instead (development and tests), which keeps what it printed in a folder
 * and can be unplugged. Windows printing comes with the install (M9).
 */
export interface UsbPrinter {
  readonly name: string;
  readonly serial: string;
}

export interface PrinterPort {
  list(): Promise<UsbPrinter[]>;
  /** Prints raw bytes; throws when the printer is gone or refuses them. */
  print(serial: string, bytes: Uint8Array): Promise<void>;
}

const run = (file: string, args: string[], input?: Uint8Array) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    if (input) {
      child.stdin?.end(Buffer.from(input));
    }
  });

/** CUPS queues whose device is a USB printer: `lpstat -v` lines like "device for Star_TSP143: usb://Star/TSP143?serial=123". */
export function parseLpstat(out: string): UsbPrinter[] {
  const printers: UsbPrinter[] = [];
  for (const line of out.split("\n")) {
    const m = /^device for ([^:]+): (usb:\/\/\S+)/.exec(line.trim());
    if (!m) continue;
    const queue = m[1]!;
    const serial = /[?&]serial=([^&\s]+)/.exec(m[2]!)?.[1] ?? queue;
    printers.push({ name: queue.replace(/_/g, " "), serial: `${queue}|${serial}` });
  }
  return printers;
}

export class CupsPrinters implements PrinterPort {
  async list(): Promise<UsbPrinter[]> {
    try {
      return parseLpstat(await run("lpstat", ["-v"]));
    } catch {
      return [];
    }
  }

  async print(serial: string, bytes: Uint8Array): Promise<void> {
    const queue = serial.split("|")[0]!;
    if (!(await this.list()).some((p) => p.serial === serial)) throw new Error("printer unplugged");
    await run("lp", ["-d", queue, "-o", "raw"], bytes);
  }
}

/** A virtual USB printer: what it prints is written to a folder; unplugged, it refuses. */
export class VirtualPrinter implements PrinterPort {
  plugged = true;
  readonly printed: Uint8Array[] = [];

  constructor(
    private readonly folder: string | null = null,
    readonly printer: UsbPrinter = { name: "Virtual bar printer", serial: "VIRTUAL-USB-1" },
  ) {}

  async list(): Promise<UsbPrinter[]> {
    return this.plugged ? [this.printer] : [];
  }

  async print(serial: string, bytes: Uint8Array): Promise<void> {
    if (!this.plugged || serial !== this.printer.serial) throw new Error("printer unplugged");
    this.printed.push(bytes);
    if (this.folder) {
      await mkdir(this.folder, { recursive: true });
      await writeFile(path.join(this.folder, `ticket-${this.printed.length}.bin`), bytes);
    }
  }
}
