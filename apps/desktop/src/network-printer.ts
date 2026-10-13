import { Socket } from "node:net";
import { isPrinterPort, isPrivateIPv4 } from "@west4/shared";

/**
 * A network printer on the venue's LAN, printed by this computer (W-04; spec
 * 09 · Tickets): the ticket's raw bytes (ESC/POS, or Star raster for a
 * TSP100III LAN) written to the printer's port 9100, the way every POS prints
 * to a LAN receipt printer. Only a private IPv4 address is ever reached. A
 * printer that doesn't answer within 3 seconds, or drops the connection, is a
 * failure the bar sees ("Kitchen ticket didn't print · Reprint").
 */
export const CONNECT_MS = 3_000;
const WRITE_MS = 10_000;

export class NetworkPrinterError extends Error {}

export interface SendOptions {
  readonly connectMs?: number;
  /** Which addresses may be reached: private IPv4 only (tests on this computer widen it). */
  readonly allow?: (address: string) => boolean;
}

function check(address: string, port: number, allow = isPrivateIPv4): void {
  if (!allow(address)) throw new NetworkPrinterError("refused: not a private address");
  if (!isPrinterPort(port)) throw new NetworkPrinterError("refused: not a port");
}

/** Writes the bytes and closes; resolves once the printer has taken them all. */
export function sendRaw(
  address: string,
  port: number,
  bytes: Uint8Array,
  options: SendOptions = {},
): Promise<void> {
  try {
    check(address, port, options.allow);
  } catch (error) {
    return Promise.reject(error as Error);
  }
  const connectMs = options.connectMs ?? CONNECT_MS;
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let connected = false;
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        done(
          new NetworkPrinterError(
            connected
              ? `The printer at ${address} stopped answering`
              : `The printer at ${address} didn't answer`,
          ),
        ),
      connectMs + WRITE_MS,
    );
    socket.setTimeout(connectMs, () => {
      if (!connected) done(new NetworkPrinterError(`The printer at ${address} didn't answer`));
    });
    socket.once("error", () =>
      done(
        new NetworkPrinterError(
          connected
            ? `The printer at ${address} stopped answering`
            : `The printer at ${address} didn't answer`,
        ),
      ),
    );
    socket.connect(port, address, () => {
      connected = true;
      socket.setTimeout(0);
      socket.end(Buffer.from(bytes), () => done());
    });
  });
}

/** Whether something listens on the printer's port: the relay's word that the printer is up. */
export function probe(address: string, port: number, options: SendOptions = {}): Promise<boolean> {
  const connectMs = options.connectMs ?? 2_000;
  try {
    check(address, port, options.allow);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(connectMs, () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, address, () => finish(true));
  });
}
