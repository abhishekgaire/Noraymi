# W · Windows bar computers and every kind of kitchen printer

Oct 13, 2026 · the tickets for the founder's hardware decisions of Oct 13 ([D127](../decisions.md)). Sing Sing Karaoke Astoria goes first and runs everything on its **bar computers, which run Windows**: an **Epson TM-T88V (M244A)** at the bar for receipts, with the cash drawer on its kick port, and a **Rongta RP326** in the kitchen, cabled to a bar computer. A **Star TSP100III** (TSP143III) is the alternative, at the bar or in the kitchen. The kitchen has no computer.

**Goal (usable when done):** the desktop app installs on a Windows bar computer, prints receipts and opens the drawer on the Epson through Windows' print spooler, and prints kitchen tickets on whichever kitchen printer the venue has: one cabled to a bar computer, one on the venue's network relayed by a bar computer, a cloud printer (Star CloudPRNT or Epson Server Direct Print) as before, or a Star TSP100III, which only understands Star's raster commands. A ticket never prints twice, and "Kitchen ticket didn't print · Reprint" still shows whenever it doesn't print.

**Done when:**

- The desktop app's Windows installer is built and unit-tested on Windows in CI, and the founder's real-Windows check list (below) passes on a bar computer.
- A bar computer can host printers for more than one station: its own bar printer and the kitchen printer on another USB port.
- A network printer on the venue's LAN (raw over TCP port 9100) is printed by a bar computer with the app open.
- A printer's command set is ESC/POS or Star raster, chosen in Admin → Printers & devices and suggested from the printer's name.
- `devices:check --set bar-computers` passes Sing Sing's hardware.

**Depends on:** M3-13, M3-14, M4-13, K-03, M9-07. **Size:** 5 tickets (1 S, 4 M).

**What only a real Windows computer can show.** Nothing here was run on Windows by us: the Windows side is unit-tested with the spooler mocked, and CI's `desktop-windows` job runs those tests and builds the installer on a Windows runner. The [founder's check list](../runbooks/hardware-install.md#check-on-a-real-windows-bar-computer) is what proves it on the bar computer.

Definition of done: see CLAUDE.md.

## Tickets

### W-01 · The desktop app on a Windows bar computer

- **Status:** doing (built and tested here; waits only on CI's `desktop-windows` job going green after the push, then done)
- **Size:** M
- **Depends on:** M3-14, M4-13, M1-29
- **Spec:** [Devices and printing](../spec/09-devices-printing-offline.md) · Tickets, The desktop app
- **Build:**
  - Windows printing: list the installed printers on a USB port (Windows' USB001, Epson's ESDPRT001 or TMUSB001; or exactly the queues `WEST4_WINDOWS_PRINTERS` names) and write each ticket's raw bytes through the spooler with the RAW datatype (winspool's OpenPrinter, StartDocPrinter, WritePrinter), so Epson's Advanced Printer Driver or "Generic / Text Only" both pass them through untouched. The drawer kick is ESC/POS through the same printer. A queue Windows reports offline, or a job still in the queue after 8 seconds, is a failure (the stuck job is deleted so it never prints late), so the bar sees "Ticket didn't print · Reprint".
  - The way in: PowerShell's Add-Type compiling a few lines of winspool P/Invoke, run with execFile (no shell; the printer's name and the ticket's file in environment variables). It ships with every Windows 10 and 11 and needs no native module built for Electron.
  - Every other desktop piece checked for Windows: the keychain (safeStorage is DPAPI there), the encrypted cache, the alarm (Electron plays sound without a click), updates (a per-user install, so the 6:00 AM update needs no administrator), the badge reader (absent, it degrades to "no PC/SC reader support"), the app's folder, the watchdog and the NSIS installer (unsigned for testing; signed when `CSC_LINK` is set).
  - CI: a `windows-latest` job runs the desktop unit tests and builds the installer.
  - The Windows install and printer setup in [hardware-install.md](../runbooks/hardware-install.md) and [manual-test.md](../manual-test.md) 0.11.
- **Acceptance:**
  - [x] The Windows printer port's unit tests (mocked PowerShell): only USB queues are listed; the bytes reach the named queue unchanged; the drawer kick goes the same way; offline, stuck and unplugged printers fail.
  - [x] Each platform gets its own printers (Windows spooler, CUPS, the virtual printer).
  - [x] The watchdog starts the app without `ELECTRON_RUN_AS_NODE`.
  - [ ] CI's `desktop-windows` job is green (seen on GitHub after the push).
- **Notes:**
  - Built: `apps/desktop/src/printers-windows.ts` (PowerShell Add-Type with winspool's OpenPrinter/StartDocPrinter/WritePrinter, RAW datatype; the job is watched in the queue for 8 seconds and deleted if stuck), `hostPrinters()` picks Windows, CUPS or the virtual printer per platform. Chosen over a node module (such as `printer` or `@thiagoelg/node-printer`) because those are native node-gyp builds that must be rebuilt for each Electron version on Windows; PowerShell and winspool ship with Windows 10 and 11.
  - Found and fixed on the way (they would have broken every Windows bar computer): the watchdog's installer set `ELECTRON_RUN_AS_NODE=1` for the whole Windows user, which makes every Electron app (this one too) start as Node.js; now it is set only for the watchdog's own process, and the watchdog takes it out of the app's environment. The app's folder followed the packaged product name ("West 4 Staff") while both watchdog installers watch `west4-desktop`, so the watchdog would restart a healthy app every 30 seconds; `userData` is now pinned to `west4-desktop`. A packaged app opened `http://localhost:5173` (nothing set `STAFF_URL` at a venue); the build now bakes `resources/west4.json` from `WEST4_STAFF_URL` and `WEST4_API_URL` (CI reads them from the repository variables of the same names). Two copies of the app could run at once (the watchdog's and the login item's) and both would print: there is now a single-instance lock, and on Windows the watchdog's task is the only start at login.
  - The installer is per user (`%LOCALAPPDATA%\Programs\West 4 Staff`), not per machine, so the 6:00 AM update installs without an administrator prompt. Unsigned unless `CSC_LINK` and `CSC_KEY_PASSWORD` are set (CI: the `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` secrets).
  - Checked for Windows without change: safeStorage is DPAPI on Windows; the alarm needs no click (Electron's default autoplay policy); the badge reader degrades to "no PC/SC reader support" when nfc-pcsc can't load or no reader is present; electron-updater's NSIS path. A packaging dry run (`electron-builder --win --dir` from the Mac) produced the Windows app with `west4.json`, `install-windows.ps1` and `watchdog.cjs` in its resources.
  - macOS still adds its login item beside its launchd watchdog; with the new single-instance lock the second copy quits at once and the watchdog starts it again every 2 seconds. Harmless but noisy: worth dropping the login item on macOS too when the watchdog is installed (not changed here; out of this ticket).
  - Verified only by mocks and CI: everything Windows-specific. The founder's real-Windows check list is in hardware-install.md.

### W-02 · Star raster printers (TSP100III)

- **Status:** done
- **Size:** M
- **Depends on:** W-01
- **Spec:** [Devices and printing](../spec/09-devices-printing-offline.md) · Tickets; [D127](../decisions.md)
- **Build:**
  - A printer's **command set**, `escpos` or `star_raster`, on its device row; Admin → Printers & devices shows and changes it, and a printer whose name says TSP100 or TSP143 is suggested Star raster when it is first seen.
  - A Star raster encoder in the API, from Star's own "STAR Graphic Mode Command Specifications" (Rev. 2.31): initialize and enter raster mode (`ESC * r R`, `ESC * r A`), continuous page (`ESC * r P 0 NUL`), feed and partial cut at the end (`ESC * r E 13 NUL`), one `b n1 n2 data` line per dot row, `ESC FF EOT`, quit (`ESC * r B`). The ticket's text is drawn with a bitmap font (DejaVu Sans Mono, Bitstream Vera licence) 16 dots wide, so the same 32 columns fit the 72 mm print width; bold lines are bold.
  - The drawer on a Star raster printer: `ESC * r D 1 NUL` inside raster mode (external device 1).
  - Every desktop-hosted printer, USB or network, gets its ticket in its own command set; cloud printers are unchanged.
- **Acceptance:**
  - [x] The encoder's bytes match the spec's sequences: the header, the line commands with their byte counts, the cut, the drawer.
  - [x] A ticket and a receipt for a Star raster printer come from the print host's next job as raster; an ESC/POS printer's are unchanged.
  - [x] The command set can be changed by a manager only; another venue's printer is not found.
- **Notes:**
  - The byte sequences come from Star's "STAR Graphic Mode Command Specifications" Rev. 2.31 (starasia.com), read on Oct 13, 2026; the unit tests check them byte for byte. Bitmap font: DejaVu Sans Mono and Bold drawn at 16 × 32 dots by `scripts/star-font.py` (Pillow), the Bitstream Vera licence notice carried in `star-font.ts`. Only printable ASCII, as the ESC/POS tickets already print (accents dropped).
  - The command set lives on the printer's device row (`devices.command_set`, migration 0152). A USB printer's is suggested from its name when its computer first reports it (TSP100 / TSP143 / futurePRNT → Star raster). Admin → Printers & devices changes it (`PATCH /v1/venues/{v}/printers/{d}`, manager only).
  - The TSP100III has no CloudPRNT, so it can never be a cloud printer; spec 09 now says which Star models are CloudPRNT. West 4's docs and seed name no TSP143; only tests did (`print-host.int.test.ts` now uses an Epson name for its ESC/POS checks and adds a Star test).
  - D127 and the spec 09 and 16 changes for W-02 to W-04 land with this ticket.
  - Needs a real printer: that the TSP100III prints the raster legibly, cuts, and opens the drawer with `ESC * r D 1 NUL` (founder's check list).

### W-03 · The kitchen printer cabled to a bar computer

- **Status:** done
- **Size:** S
- **Depends on:** W-01
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Kitchen tickets; [D127](../decisions.md)
- **Build:**
  - A printer on a desktop-app host gets its **station** (bar, front desk or kitchen) chosen in Admin → Printers & devices; one bar computer can host its bar printer and the kitchen printer on another USB port.
  - The kitchen's printer may be cabled to a bar computer (any brand); the database's "kitchen printer must be a cloud printer" rule is replaced. Kitchen & food counts it as the kitchen printer.
  - Kitchen jobs go to whichever host has the kitchen printer attached, through the same claim and confirm; with that computer off, or the printer not answering, the job fails and "Kitchen ticket didn't print · Reprint" shows, and the manager on duty is told as before.
- **Acceptance:**
  - [x] A bar computer's second printer set to kitchen takes the kitchen's tickets and no bar tickets; its bar printer takes no kitchen tickets.
  - [x] With nobody claiming a kitchen ticket, it fails after three polls and shows on the bar's list.
  - [x] A kitchen printer on USB satisfies Kitchen & food's "needs a kitchen printer".
- **Notes:**
  - Migration 0153 drops K-03's `devices_kitchen_network_printer_check`; Kitchen & food counts any printer on the kitchen station. Admin → Printers & devices shows a station picker on every printer cabled to a computer. Adding a "usb" printer by hand is refused with a hint (the computer reports it by itself).
  - The kitchen printer cabled to a bar computer uses the existing claim and confirm and the existing print watch, so a kitchen ticket with that computer off fails after three polls and tells the bar and the manager on duty (K-03), and Reprint goes back to it.
  - The station picker in Admin, the route that sets it and the two-printer test landed in W-02's commit (the same screen and route as the command set); this commit is the database rule and Kitchen & food.
  - USB-to-serial: a printer on a serial (COM) port shows only if `WEST4_WINDOWS_PRINTERS` names its Windows queue (W-01 lists USB ports by default).

### W-04 · A network printer on the venue's LAN, printed by a bar computer

- **Status:** todo
- **Size:** M
- **Depends on:** W-01, W-03
- **Spec:** [Devices and printing](../spec/09-devices-printing-offline.md) · Tickets; [Kitchen and food](../spec/16-kitchen.md) · Kitchen tickets; [D127](../decisions.md)
- **Build:**
  - A third kind of printer, **Network printer**: an IP address on the venue's private network and a port (9100 by default), raw ESC/POS or Star raster over TCP. Admin → Printers & devices adds it with a test print and the note "Prints while a bar computer with the app is open".
  - The venue names which desktop computers relay it; by default any bar computer with the app open. One relay at a time holds a short lease on the printer (renewed every poll, 10 seconds), and a relay claims only jobs nobody has been sent, so a ticket prints once; a relay that sent a job and went quiet leaves it to the print watch, which fails it after three polls ("Kitchen ticket didn't print · Reprint"). With no relay up, the same.
  - The desktop app sends the bytes only to a private IPv4 address (10/8, 172.16/12, 192.168/16) and fails with "The printer at 192.168.1.50 didn't answer" when nothing listens.
  - Onboarding step 12 and `devices:check` accept a network printer as the kitchen printer.
- **Acceptance:**
  - [ ] Two relays polling the same network printer: each job is handed to one of them only; the other gets nothing until the lease runs out.
  - [ ] A relay not named for the printer gets nothing; a relay from another venue gets nothing (venue wall); every route as every principal.
  - [ ] The desktop's network send writes the bytes to a listening socket, refuses a public address, and fails on a closed port.
  - [ ] The test print reaches the relay.
- **Notes:**

### W-05 · Sing Sing's hardware: Windows bar computers, the Epson at the bar, the kitchen printer

- **Status:** todo
- **Size:** M
- **Depends on:** W-01 to W-04, F-09 (shares the `devices:check` set)
- **Spec:** [Devices and printing](../spec/09-devices-printing-offline.md) · Devices; [Sing Sing](../venues/sing-sing/venue.md)
- **Build:**
  - `devices:check --set bar-computers`: at least one bar computer with the desktop app, a receipt printer with the bar drawer on its kick port and online, the kitchen printer (cabled to a bar computer, on the network, or a cloud printer) when Kitchen & food is on, card readers only when the outside card machine is off; no front desk, tablets, badge readers, phones or Up next TV asked for. The default set stays West 4's.
  - Sing Sing's venue guide and the hardware runbook: today's setup (Epson TM-T88V at the bar, Rongta RP326 in the kitchen, both cabled to the bar computer), the Star TSP100III as the alternative (USB to a bar computer, or the LAN or Wi-Fi model over the network), and the founder's check list for a real Windows bar computer.
- **Acceptance:**
  - [ ] `devices:check --set bar-computers` passes Sing Sing's set and names what's missing otherwise; West 4's set is unchanged.
- **Notes:**
