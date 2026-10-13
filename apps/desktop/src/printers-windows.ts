import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrinterPort, UsbPrinter } from "./printers.js";

/**
 * Printers on a Windows bar computer (W-01; spec 09 · Tickets). Windows owns
 * its USB printers through the print spooler, so the app does what Windows
 * POS software does: it writes the ticket's raw ESC/POS bytes to the
 * printer's queue with the RAW datatype (winspool's OpenPrinter,
 * StartDocPrinter, WritePrinter), which passes them to the printer untouched
 * whatever its driver (Epson's Advanced Printer Driver or "Generic / Text
 * Only"). The drawer kick is ESC/POS too, so it goes the same way.
 *
 * Why PowerShell: it ships with every Windows 10 and 11, and its Add-Type
 * compiles the few lines of winspool P/Invoke below at run time, so the
 * packaged app carries no native module to build for Electron (the pain a
 * node-gyp printer module brings on every Electron upgrade). Each call runs
 * `powershell.exe` with execFile: no shell, the printer's name and the
 * ticket's file passed in environment variables, never pasted into the script.
 *
 * Which printers: only queues on a USB port (USB001, Epson's ESDPRT001 or
 * TMUSB001), so an office laser on the network never takes a bar ticket; or,
 * when WEST4_WINDOWS_PRINTERS names them ("EPSON TM-T88V Receipt;Bar"), exactly
 * those queues. A queue Windows reports offline, or a job still stuck in it
 * after a few seconds (unplugged, out of paper, the lid open), is a failure:
 * the stuck job is deleted so it never prints late, and the bar sees
 * "Ticket didn't print · Reprint".
 */

/** How `powershell.exe` is run: injectable, so the tests mock the Windows side. */
export type PowerShell = (script: string, env: Record<string, string>) => Promise<string>;

const encode = (script: string) => Buffer.from(script, "utf16le").toString("base64");

export const runPowerShell: PowerShell = (script, env) =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encode(script),
      ],
      { timeout: 30_000, windowsHide: true, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message).trim().split("\n")[0]!));
        else resolve(stdout);
      },
    );
  });

/** The installed printers as JSON: name, port, driver and whether Windows calls them offline. */
export const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$list = @(Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; port = $_.PortName; driver = $_.DriverName; offline = [bool]$_.WorkOffline; status = [int]$_.PrinterStatus; error = [int]$_.DetectedErrorState }
})
ConvertTo-Json -InputObject $list -Compress
`;

/**
 * Raw bytes to one queue through winspool, then a watch on the job: printed once it leaves the
 * queue; still there with an error, or after the wait, it is deleted and reported. Prints
 * "printed" or "failed: <why>".
 */
export const PRINT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class West4Raw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr h, byte[] bytes, int count, out int written);
  public static int Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("no such printer (" + Marshal.GetLastWin32Error() + ")");
    try {
      var di = new DOCINFO { pDocName = "West 4 ticket", pDataType = "RAW" };
      int job = StartDocPrinter(h, 1, di);
      if (job <= 0) throw new Exception("the spooler refused the ticket (" + Marshal.GetLastWin32Error() + ")");
      StartPagePrinter(h);
      int written;
      bool ok = WritePrinter(h, bytes, bytes.Length, out written);
      EndPagePrinter(h);
      EndDocPrinter(h);
      if (!ok || written != bytes.Length) throw new Exception("the printer took " + written + " of " + bytes.Length + " bytes");
      return job;
    } finally { ClosePrinter(h); }
  }
}
'@
$name = $env:WEST4_PRINTER
$p = Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -eq $name }
if (-not $p) { 'failed: printer unplugged'; exit 0 }
if ($p.WorkOffline -or $p.PrinterStatus -eq 7) { 'failed: the printer is offline'; exit 0 }
$bytes = [IO.File]::ReadAllBytes($env:WEST4_FILE)
$job = [West4Raw]::Send($name, $bytes)
$deadline = (Get-Date).AddMilliseconds([int]$env:WEST4_WAIT_MS)
while ((Get-Date) -lt $deadline) {
  $j = Get-CimInstance -ClassName Win32_PrintJob | Where-Object { $_.JobId -eq $job -and $_.Name -like "$name,*" }
  if (-not $j) { 'printed'; exit 0 }
  Start-Sleep -Milliseconds 250
}
$j = Get-CimInstance -ClassName Win32_PrintJob | Where-Object { $_.JobId -eq $job -and $_.Name -like "$name,*" }
if (-not $j) { 'printed'; exit 0 }
$why = if ($j.JobStatus) { $j.JobStatus } else { 'not taken by the printer' }
Remove-CimInstance -InputObject $j -ErrorAction SilentlyContinue
"failed: $why"
`;

interface WinPrinter {
  readonly name: string;
  readonly port: string | null;
  readonly driver: string | null;
  readonly offline: boolean;
}

/** USB ports: Windows' own USB001, Epson's Advanced Printer Driver ports ESDPRT001 and TMUSB001. */
const USB_PORT = /^(USB\d+|ESDPRT\d+|TMUSB\d+)$/i;

/** Windows' printers, parsed from the list script's JSON, and kept to receipt printers on USB or the named ones. */
export function parseWindowsPrinters(json: string, named: readonly string[] = []): UsbPrinter[] {
  let rows: WinPrinter[];
  try {
    const parsed: unknown = JSON.parse(json.trim() || "[]");
    rows = (Array.isArray(parsed) ? parsed : [parsed]) as WinPrinter[];
  } catch {
    return [];
  }
  const wanted = new Set(named.map((n) => n.trim().toLowerCase()).filter(Boolean));
  return rows
    .filter((r) => typeof r?.name === "string" && r.name.length > 0)
    .filter((r) =>
      wanted.size > 0 ? wanted.has(r.name.toLowerCase()) : USB_PORT.test((r.port ?? "").trim()),
    )
    .map((r) => ({ name: r.name, serial: `win|${r.name}` }));
}

export class WindowsPrinters implements PrinterPort {
  constructor(
    private readonly ps: PowerShell = runPowerShell,
    private readonly named: readonly string[] = (process.env["WEST4_WINDOWS_PRINTERS"] ?? "")
      .split(";")
      .filter((n) => n.trim().length > 0),
    /** How long a job may sit in the queue before it counts as not printed. */
    private readonly waitMs = 8_000,
  ) {}

  async list(): Promise<UsbPrinter[]> {
    try {
      return parseWindowsPrinters(await this.ps(LIST_SCRIPT, {}), this.named);
    } catch {
      return [];
    }
  }

  async print(serial: string, bytes: Uint8Array): Promise<void> {
    if (!serial.startsWith("win|")) throw new Error("printer unplugged");
    const name = serial.slice(4);
    if (!(await this.list()).some((p) => p.serial === serial)) throw new Error("printer unplugged");
    const file = path.join(tmpdir(), `west4-ticket-${randomUUID()}.bin`);
    await writeFile(file, bytes);
    try {
      const out = (
        await this.ps(PRINT_SCRIPT, {
          WEST4_PRINTER: name,
          WEST4_FILE: file,
          WEST4_WAIT_MS: String(this.waitMs),
        })
      ).trim();
      const last = out.split(/\r?\n/).pop() ?? "";
      if (last === "printed") return;
      throw new Error(
        last.startsWith("failed: ") ? last.slice(8) : "the printer refused the ticket",
      );
    } finally {
      await rm(file, { force: true });
    }
  }
}
