/**
 * A network printer's address (W-04; D127): a fixed IPv4 address on the
 * venue's own private network (10/8, 172.16/12, 192.168/16) and a TCP port,
 * 9100 by default (raw printing). The API refuses anything else when a
 * manager adds one, and the desktop app refuses to send a ticket anywhere
 * else, so a printer row can never point a bar computer at the internet.
 */
export const RAW_PRINT_PORT = 9100;

export function isPrivateIPv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address.trim());
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255) || m.slice(1).some((p) => p.length > 1 && p.startsWith("0")))
    return false;
  const [a, b, , d] = parts as [number, number, number, number];
  if (d === 0 || d === 255) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isPrinterPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}
