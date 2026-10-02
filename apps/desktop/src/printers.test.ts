import { describe, expect, it } from "vitest";
import { parseLpstat, VirtualPrinter } from "./printers.js";

describe("USB printers on the host", () => {
  it("finds USB CUPS queues and leaves network ones out", () => {
    const out = [
      "device for Star_TSP143IIIU: usb://Star/TSP143IIIU?serial=2580618110100000",
      "device for Office_Laser: ipp://192.168.1.20/ipp/print",
      "device for EPSON_TM_T20III: usb://EPSON/TM-T20III?serial=X5ZT012345",
    ].join("\n");
    expect(parseLpstat(out)).toEqual([
      { name: "Star TSP143IIIU", serial: "Star_TSP143IIIU|2580618110100000" },
      { name: "EPSON TM T20III", serial: "EPSON_TM_T20III|X5ZT012345" },
    ]);
  });

  it("the virtual printer prints while plugged in and refuses once unplugged", async () => {
    const usb = new VirtualPrinter();
    const [printer] = await usb.list();
    await usb.print(printer!.serial, Uint8Array.from([0x1b, 0x40, 0x41]));
    expect(usb.printed).toHaveLength(1);
    usb.plugged = false;
    expect(await usb.list()).toEqual([]);
    await expect(usb.print(printer!.serial, Uint8Array.from([0x41]))).rejects.toThrow(
      "printer unplugged",
    );
  });
});
