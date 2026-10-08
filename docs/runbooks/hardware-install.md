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
