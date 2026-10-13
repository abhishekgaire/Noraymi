# Install and pair West 4's hardware (M9-07)

The day the hardware goes in. What's there is [spec 09](../spec/09-devices-printing-offline.md) · Devices at West 4, the same list as the [demo seed](../demo-seed.md#cash-drawers-and-devices). Write down each device's serial number from its label as you install it; never guess one.

## Install and pair

Pair every device from Admin → Printers & devices: "Pair a device" makes a one-time code; the device enters it and gets its own key. Name each as below.

| Where | Device | Name in Admin | Done | Serial |
| --- | --- | --- | --- | --- |
| Bar | Computer (desktop app) | Bar computer | [ ] | |
| Bar | USB badge reader, on the bar computer | Bar badge reader (USB) | [ ] | |
| Bar | Receipt printer, the bar drawer on its kick port | Bar receipt printer | [ ] | |
| Bar | Stripe Reader S710, registered to West 4's Location, cellular on | Bar S710 | [ ] | |
| Front desk | Computer (desktop app) | Front-desk computer | [ ] | |
| Front desk | USB badge reader, on the front-desk computer | Front-desk badge reader (USB) | [ ] | |
| Front desk | Receipt printer, the front-desk drawer on its kick port | Front-desk receipt printer | [ ] | |
| Front desk | Stripe Reader S710, registered to West 4's Location, cellular on | Front desk S710 | [ ] | |
| Each room | Room tablet in managed kiosk mode (Guided Access or device management on iPad, lock-task mode on Android), paired to its room | Tablet · Room N | [ ] ×14 | |
| Bar | Up next TV | Up next TV | [ ] | |
| Venue | Dual-WAN router with cellular backup, on a different carrier from the readers | Dual-WAN router | [ ] | |

Readers are registered with their pairing code from the reader's screen in Admin → Printers & devices (M4-02); the venue's Terminal Configuration already has cellular on and the 18/20/22% tips ([spec 06](../spec/06-stripe-setup.md) §4). In Admin, link each drawer to its printer.

## Check

1. **The records:** run `pnpm --filter @west4/api devices:check` (against production, from the ops laptop). Every line must say OK. It checks each pay point's S710 (label, Stripe registration, cellular on, online), its drawer on an online receipt printer, its USB badge reader, one tablet per room (online unless the room is out of service), the Up next TV and the router's backup internet. Paste its output into `docs/gate/hardware-<date>.md`.
2. **Admin against the Console:** open Admin → Printers & devices and the Console's venue list side by side. Both must show the same thing as the check's last lines: both readers online, "Backup internet · on", and every room tablet online but any room out of service (13 of 14 while Room 4 is out of service). They're built from the same rows by the same function.
3. **Drawers:** at each pay point, take a $1.00 cash payment: that station's drawer opens. Do a no-sale (PIN asked again): it opens. Then take a card payment, reprint a receipt, and ring a practice sale in training mode: the drawer stays shut for each. (Drops, paid-outs and tip-outs open it too, by the spec; they're tested at the first close.) Void or refund the test sales.
4. **Room tablets:** on each tablet between sessions, the screen shows "Room available" and offers no menu; try to order and nothing goes through. Try leaving the kiosk app: the device doesn't let you.
5. **Cellular:** run the cellular signal check (`cellular-check.md`) at a busy hour.

Record who did each check and when in the same gate file.

## A Windows bar computer (W-01)

Sing Sing's bar computers run Windows 10 or 11. Do this on each one, signed in as the Windows user the bar works under (the app, its sign-in and its cache belong to that user).

1. **Install the app.** Run `West-4-Staff-Setup-<version>.exe` (from the GitHub release, or CI's `west4-staff-windows` download while testing). An unsigned test build makes Windows SmartScreen say "Windows protected your PC": choose **More info → Run anyway**. A signed build (built with `CSC_LINK`) doesn't ask. It installs for this Windows user in `%LOCALAPPDATA%\Programs\West 4 Staff`, so its updates install at 6:00 AM without an administrator.
2. **Start it at login and keep it running.** Open PowerShell (not as administrator) and run:
   `powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\West 4 Staff\resources\install-windows.ps1"`
   It adds the scheduled task "West 4 Staff watchdog", which opens the app at login and reopens it if it closes or stops answering. Sign out and back in: the app opens by itself.
3. **Pair it** as "Bar computer" (or "Bar computer 2") from Admin → Printers & devices → Pair a device, as above.
4. **Install the receipt printer's driver** before plugging the printer in:
   - **Epson TM-T88V (M244A):** Epson's **Advanced Printer Driver (APD) for TM-T88V** from epson.com (Support → TM-T88V → Drivers). Its port is ESDPRT001 or TMUSB001. Keep the queue's name as installed (for example "EPSON TM-T88V Receipt").
   - **Any other ESC/POS printer (the Rongta RP326):** its maker's Windows driver, or Windows' own **Generic / Text Only** driver on the USB port Windows made for it (Settings → Printers & scanners → Add a printer → "The printer that I want isn't listed" → Add a local printer → Use an existing port: USB001 (Virtual printer port for USB) → Generic → Generic / Text Only). Name the queue "Kitchen RP326".
   - **Star TSP100III on USB:** Star's **TSP100 futurePRNT** driver from starmicronics.com. The app sends it Star raster (W-02), so set its command set to Star raster in Admin (it's suggested from the name).
   - Don't share the printer on the network, and don't make it Windows' default printer for office printing.
   The app prints only to queues on a USB port (USB001, ESDPRT001, TMUSB001), so an office printer is never used for tickets. If a receipt printer sits on another kind of port, set the environment variable `WEST4_WINDOWS_PRINTERS` to the queue names, separated by `;`, and restart the app.
5. **See it in Admin.** With the app open, the printer shows in Admin → Printers & devices within a minute, hosted by this computer. Choose its station (bar, or kitchen for the kitchen printer cabled to this computer, W-03), its command set, and for the bar printer link the bar drawer to it.
6. **Test print** from Admin → Printers & devices → the printer → Test print. It prints TEST TICKET within a few seconds.
7. **Drawer test:** take a $1.00 cash payment at the bar: the drawer opens. If it doesn't, the drawer may be wired to pin 5; tell us (spec 09 · drawer kick) and don't change the Epson driver's own drawer setting.

The badge reader is optional on Windows: without one (Sing Sing signs in with PINs), the app runs as usual and logs "no PC/SC reader support".

## A network printer in the kitchen (W-04)

When the kitchen printer has an Ethernet (or Wi-Fi) port, it can sit in the kitchen on the venue's network with no cable to a computer. A bar computer with the app open sends it each kitchen ticket.

1. **The right model.** It must have a network port: a Star TSP143IIILAN or TSP143IIIW (not the USB-only TSP143IIIU), or an ESC/POS printer with Ethernet (for a Rongta RP326, the version with an Ethernet port, such as the RP326-USE). A USB-only printer can't be reached from the kitchen: cable it to a bar computer instead (W-03).
2. **A fixed address.** Plug it into the venue's router or switch, and in the router's settings reserve its address (a "DHCP reservation" for the printer's MAC address, printed on its self-test page), for example 192.168.1.50. Print the printer's self-test page (hold the feed button while switching it on) to read its address. It must not change, or tickets stop printing.
3. **Add it** in Admin → Printers & devices → Add a printer: name "Kitchen printer", station Kitchen, How it connects: **Network printer (on this venue's network)**, the IP address, port 9100. Its command set is suggested from the name (Star raster for a TSP143III; ESC/POS otherwise); check it.
4. **Printed by:** "Any bar computer" (the default) or one named computer. At least one of them must have the app open while the kitchen is open; with none, every kitchen ticket shows "Kitchen ticket didn't print · Reprint" and the manager on duty is told.
5. **Test print** from its row: TEST TICKET prints in the kitchen within a few seconds.

## Check on a real Windows bar computer

What we could check without Windows: the Windows printer code with the spooler mocked in unit tests, and CI's `desktop-windows` job, which runs those tests and builds the installer on a Windows machine. Everything below needs the real computer and printers. Tick each and write the date and who did it in the gate file.

- [ ] The installer runs (SmartScreen's Run anyway on a test build), the app opens and shows the staff app, and pairing works.
- [ ] Signing out of Windows and back in opens the app by itself (the watchdog task); closing the app with Task Manager brings it back within 10 seconds; opening it again from the Start menu doesn't open a second copy.
- [ ] The app keeps the person signed in after a restart (the keychain is Windows' DPAPI) and the offline view works with the network cable out.
- [ ] The Epson TM-T88V shows in Admin → Printers & devices; Test print prints; a room order's bar ticket prints; a receipt prints.
- [ ] A $1.00 cash payment opens the drawer; a no-sale opens it; a card payment and a receipt reprint don't.
- [ ] With the Epson switched off (or its USB cable out), a ticket shows "Ticket didn't print · Reprint" within about 20 seconds, and nothing prints later when it's switched back on; Reprint then prints it once.
- [ ] The order alarm sounds on the bar computer's speakers with nobody clicking first.
- [ ] **Kitchen printer cabled to the bar computer** (Sing Sing's Rongta RP326, W-03): it shows in Admin with "Cabled to Bar computer"; set its station to Kitchen; Test print prints in the kitchen; a food order's kitchen ticket prints there and nothing for the kitchen prints on the Epson. Then unplug its cable (or switch it off): the next kitchen ticket shows "Kitchen ticket didn't print · Reprint" within about 20 seconds and the manager's phone (if paired) is told; plug it back and Reprint prints it once.
- [ ] **A network printer** (only if one is used, W-04): Test print from Admin prints in the kitchen with the bar computer's app open; with the app closed on every bar computer, a kitchen ticket shows "Kitchen ticket didn't print · Reprint"; with two bar computers open, a ticket prints once, never twice.
- [ ] **A Star TSP100III** (only if one is used, W-02): its command set says Star raster; Test print, a kitchen ticket and a receipt print legibly (the text is drawn as a picture) and the paper is cut; at the bar, a $1.00 cash payment opens the drawer on its DK port.
- [ ] The next morning after an update was published, the app updated itself after 6:00 AM without asking for an administrator.
