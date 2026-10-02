import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { path: string; body: unknown }[] = [];
vi.mock("./device.js", () => ({
  signedApi: vi.fn(async (_device: unknown, _method: string, path: string, body: unknown) => {
    calls.push({ path, body });
    if (path.endsWith("/devices/attached")) return { device_id: "printer-1" };
    if (path.endsWith("/print-host/next"))
      return calls.filter((c) => c.path.endsWith("/print-host/next")).length === 1
        ? { job: { id: "job-1", escpos: btoa("\x1b@4 x Bud Light") } }
        : { job: null };
    return {};
  }),
  deviceRevoked: vi.fn(),
}));

const { printTurn } = await import("./print-host.js");
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
});
