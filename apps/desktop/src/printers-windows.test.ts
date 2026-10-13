import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hostPrinters, CupsPrinters, VirtualPrinter } from "./printers.js";
import {
  LIST_SCRIPT,
  parseWindowsPrinters,
  PRINT_SCRIPT,
  WindowsPrinters,
  type PowerShell,
} from "./printers-windows.js";

// What Get-CimInstance Win32_Printer gives on a bar computer: the Epson on Epson's APD port, a
// Rongta on Windows' own USB port, an office laser on the network and Windows' virtual printers.
const INSTALLED = JSON.stringify([
  {
    name: "EPSON TM-T88V Receipt",
    port: "ESDPRT001",
    driver: "EPSON TM-T88V Receipt5",
    offline: false,
  },
  { name: "Kitchen RP326", port: "USB002", driver: "Generic / Text Only", offline: false },
  { name: "Office Laser", port: "192.168.1.20", driver: "HP Universal", offline: false },
  {
    name: "Microsoft Print to PDF",
    port: "PORTPROMPT:",
    driver: "Microsoft Print To PDF",
    offline: false,
  },
  { name: "Fax", port: "SHRFAX:", driver: "Microsoft Shared Fax Driver", offline: false },
]);

/** A mocked powershell.exe: the list script answers the printers, the print script answers `answer`. */
function mockShell(answer: string | ((env: Record<string, string>) => string)) {
  const calls: { script: string; env: Record<string, string>; bytes?: Buffer }[] = [];
  const ps: PowerShell = async (script, env) => {
    const call: (typeof calls)[number] = { script, env };
    if (env["WEST4_FILE"]) call.bytes = readFileSync(env["WEST4_FILE"]);
    calls.push(call);
    if (script === LIST_SCRIPT) return INSTALLED;
    return typeof answer === "function" ? answer(env) : answer;
  };
  return { ps, calls };
}

describe("printers on a Windows bar computer (W-01)", () => {
  it("lists only receipt printers on a USB port, never the office laser or the virtual ones", () => {
    expect(parseWindowsPrinters(INSTALLED)).toEqual([
      { name: "EPSON TM-T88V Receipt", serial: "win|EPSON TM-T88V Receipt" },
      { name: "Kitchen RP326", serial: "win|Kitchen RP326" },
    ]);
  });

  it("lists exactly the queues WEST4_WINDOWS_PRINTERS names, when it names any", () => {
    expect(parseWindowsPrinters(INSTALLED, ["office laser"])).toEqual([
      { name: "Office Laser", serial: "win|Office Laser" },
    ]);
  });

  it("reads one printer (PowerShell's single object) and survives junk", () => {
    expect(
      parseWindowsPrinters(JSON.stringify({ name: "Star TSP143IIIU", port: "USB001" })),
    ).toEqual([{ name: "Star TSP143IIIU", serial: "win|Star TSP143IIIU" }]);
    expect(parseWindowsPrinters("")).toEqual([]);
    expect(parseWindowsPrinters("not json")).toEqual([]);
  });

  it("sends the ticket's bytes raw to the named queue, and the temporary file goes", async () => {
    const { ps, calls } = mockShell("printed\r\n");
    const win = new WindowsPrinters(ps, []);
    const ticket = Uint8Array.from([0x1b, 0x40, 0x41, 0x0a, 0x1d, 0x56, 0x42, 0x00]);
    await win.print("win|EPSON TM-T88V Receipt", ticket);
    const job = calls.find((c) => c.script === PRINT_SCRIPT)!;
    expect(job.env["WEST4_PRINTER"]).toBe("EPSON TM-T88V Receipt");
    expect([...job.bytes!]).toEqual([...ticket]);
    expect(existsSync(job.env["WEST4_FILE"]!)).toBe(false);
  });

  it("the drawer kick goes the same way, as ESC/POS through the printer", async () => {
    const { ps, calls } = mockShell("printed");
    await new WindowsPrinters(ps, []).print(
      "win|EPSON TM-T88V Receipt",
      Uint8Array.from([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]),
    );
    expect([...calls.find((c) => c.script === PRINT_SCRIPT)!.bytes!]).toEqual([
      0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa,
    ]);
  });

  it("a printer that's gone, offline or stuck is a failure the bar sees, never a silent success", async () => {
    const gone = new WindowsPrinters(mockShell("printed").ps, []);
    await expect(gone.print("win|Office Laser", Uint8Array.from([0x41]))).rejects.toThrow(
      "printer unplugged",
    );
    const offline = new WindowsPrinters(mockShell("failed: the printer is offline").ps, []);
    await expect(offline.print("win|Kitchen RP326", Uint8Array.from([0x41]))).rejects.toThrow(
      "the printer is offline",
    );
    const odd = new WindowsPrinters(mockShell("").ps, []);
    await expect(odd.print("win|Kitchen RP326", Uint8Array.from([0x41]))).rejects.toThrow(
      "the printer refused the ticket",
    );
  });

  it("the print script writes RAW through winspool and deletes a job left stuck in the queue", () => {
    expect(PRINT_SCRIPT).toContain('pDataType = "RAW"');
    expect(PRINT_SCRIPT).toContain("WritePrinter");
    expect(PRINT_SCRIPT).toContain("Remove-CimInstance");
    // The printer's name and the file come in the environment, never pasted into the script.
    expect(PRINT_SCRIPT).toContain("$env:WEST4_PRINTER");
    expect(PRINT_SCRIPT).not.toMatch(/EPSON|Kitchen/);
  });

  it("each platform gets its own printers", async () => {
    expect((await hostPrinters({}, "win32")).port).toBeInstanceOf(WindowsPrinters);
    expect((await hostPrinters({}, "darwin")).port).toBeInstanceOf(CupsPrinters);
    expect((await hostPrinters({}, "linux")).port).toBeInstanceOf(CupsPrinters);
    const fake = await hostPrinters({ WEST4_FAKE_PRINTER: "1" }, "win32");
    expect(fake.port).toBeInstanceOf(VirtualPrinter);
    expect(fake.virtual).toBe(fake.port);
  });
});
