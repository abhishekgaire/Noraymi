import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isPrivateIPv4 } from "@west4/shared";
import { probe, sendRaw } from "./network-printer.js";

/** A stand-in LAN printer on this computer: what it was sent, per connection. */
async function fakePrinter(): Promise<{ server: Server; port: number; got: Buffer[] }> {
  const got: Buffer[] = [];
  const server = createServer((socket) => {
    const parts: Buffer[] = [];
    socket.on("data", (d) => parts.push(d));
    socket.on("end", () => got.push(Buffer.concat(parts)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, got };
}

// Tests reach 127.0.0.1; the app itself reaches only private LAN addresses.
const here = { allow: (a: string) => a === "127.0.0.1" };

describe("a network printer on the venue's LAN (W-04)", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  it("writes the ticket's bytes raw to the printer's port", async () => {
    const p = await fakePrinter();
    server = p.server;
    const ticket = Uint8Array.from([0x1b, 0x40, 0x41, 0x0a, 0x1d, 0x56, 0x42, 0x00]);
    await sendRaw("127.0.0.1", p.port, ticket, here);
    await expect.poll(() => p.got.length).toBe(1);
    expect([...p.got[0]!]).toEqual([...ticket]);
    expect(await probe("127.0.0.1", p.port, here)).toBe(true);
  });

  it("fails when nothing answers on the port, so the bar sees the ticket didn't print", async () => {
    const p = await fakePrinter();
    const closed = p.port;
    await new Promise<void>((r) => p.server.close(() => r()));
    await expect(sendRaw("127.0.0.1", closed, Uint8Array.from([0x41]), here)).rejects.toThrow(
      "The printer at 127.0.0.1 didn't answer",
    );
    expect(await probe("127.0.0.1", closed, here)).toBe(false);
  });

  it("never reaches beyond the venue's private network", async () => {
    await expect(sendRaw("8.8.8.8", 9100, Uint8Array.from([0x41]))).rejects.toThrow(
      "refused: not a private address",
    );
    await expect(sendRaw("192.168.1.50", 0, Uint8Array.from([0x41]))).rejects.toThrow(
      "refused: not a port",
    );
    expect(await probe("example.com", 9100)).toBe(false);
  });

  it("private IPv4 only: 10/8, 172.16/12, 192.168/16", () => {
    for (const ok of ["192.168.1.50", "10.0.0.20", "172.16.4.9", "172.31.255.254"])
      expect(isPrivateIPv4(ok), ok).toBe(true);
    for (const no of [
      "8.8.8.8",
      "172.32.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "192.168.1.255",
      "192.168.1.0",
      "192.168.001.5",
      "300.1.1.1",
      "printer.local",
      "",
    ])
      expect(isPrivateIPv4(no), no).toBe(false);
  });
});
