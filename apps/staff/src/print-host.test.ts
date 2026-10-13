import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { path: string; body: unknown }[] = [];
let relayJob = true;
vi.mock("./device.js", () => ({
  signedApi: vi.fn(async (_device: unknown, _method: string, path: string, body: unknown) => {
    calls.push({ path, body });
    if (path.endsWith("/devices/attached")) return { device_id: "printer-1" };
    if (path.endsWith("/print-host/relay/next"))
      return {
        printers: [{ printer_id: "lan-1", address: "192.168.1.50", port: 9100 }],
        job: relayJob
          ? {
              id: "job-9",
              printer_id: "lan-1",
              address: "192.168.1.50",
              port: 9100,
              escpos: btoa("K"),
            }
          : null,
      };
    if (path.endsWith("/print-host/next"))
      return calls.filter((c) => c.path.endsWith("/print-host/next")).length === 1
        ? { job: { id: "job-1", escpos: btoa("\x1b@4 x Bud Light") } }
        : { job: null };
    return {};
  }),
  deviceRevoked: vi.fn(),
}));

const { printTurn, relayTurn, relayed } = await import("./print-host.js");
const device = { deviceId: "bar", venueId: "v1" } as never;

describe("the print host", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("prints the next ticket on the USB printer and confirms it", async () => {
    const printed: string[] = [];
    (globalThis as unknown as { window: unknown }).window = {
      west4: {
        printers: async () => [{ name: "Star TSP143IIIU", serial: "VIRTUAL-USB-1" }],
        print: async (_serial: string, base64: string) => void printed.push(atob(base64)),
      },
    };
    expect(await printTurn(device)).toBe(1);
    expect(printed).toEqual(["\x1b@4 x Bud Light"]);
    expect(calls.at(-1)).toEqual({
      path: "/v1/venues/v1/print-host/jobs/job-1",
      body: { printer_id: "printer-1", printed: true, failure: null },
    });
  });

  it("reports an unplugged printer's ticket as failed", async () => {
    (globalThis as unknown as { window: unknown }).window = {
      west4: {
        printers: async () => [{ name: "Star TSP143IIIU", serial: "VIRTUAL-USB-1" }],
        print: async () => {
          throw new Error("printer unplugged");
        },
      },
    };
    expect(await printTurn(device)).toBe(0);
    expect(calls.at(-1)).toEqual({
      path: "/v1/venues/v1/print-host/jobs/job-1",
      body: { printer_id: "printer-1", printed: false, failure: "printer unplugged" },
    });
  });

  it("relays a network printer's job to its LAN address and confirms it (W-04)", async () => {
    const sent: { address: string; port: number; bytes: string }[] = [];
    (globalThis as unknown as { window: unknown }).window = {
      west4: {
        printNetwork: async (address: string, port: number, base64: string) =>
          void sent.push({ address, port, bytes: atob(base64) }),
      },
    };
    relayJob = true;
    expect(await relayTurn(device)).toBe(1);
    expect(sent).toEqual([{ address: "192.168.1.50", port: 9100, bytes: "K" }]);
    expect(calls.at(-1)).toEqual({
      path: "/v1/venues/v1/print-host/jobs/job-9",
      body: { printer_id: "lan-1", printed: true, failure: null },
    });
    expect(relayed.get("lan-1")).toEqual({ address: "192.168.1.50", port: 9100 });
  });

  it("a network printer that doesn't answer: the job is reported failed", async () => {
    (globalThis as unknown as { window: unknown }).window = {
      west4: {
        printNetwork: async () => {
          throw new Error("The printer at 192.168.1.50 didn't answer");
        },
      },
    };
    relayJob = true;
    expect(await relayTurn(device)).toBe(0);
    expect(calls.at(-1)).toEqual({
      path: "/v1/venues/v1/print-host/jobs/job-9",
      body: {
        printer_id: "lan-1",
        printed: false,
        failure: "The printer at 192.168.1.50 didn't answer",
      },
    });
  });

  it("outside the desktop app, or with nothing to print, it does nothing", async () => {
    (globalThis as unknown as { window: unknown }).window = { west4: {} };
    expect(await relayTurn(device)).toBe(0);
    (globalThis as unknown as { window: unknown }).window = {
      west4: { printNetwork: async () => undefined },
    };
    relayJob = false;
    const before = calls.length;
    expect(await relayTurn(device)).toBe(0);
    expect(calls.length).toBe(before + 1);
  });
});
