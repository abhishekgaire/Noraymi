# The mock Friday (M3)

A script for two people to run by hand in staging, on the demo seed. It checks what M3's "done when" in `docs/milestones.md` asks for on real devices and real printers, which the automated tests can't: a tablet and phones ordering, one network printer and one USB printer, and two people's screens agreeing. The browser tests in `e2e/staff.spec.ts` ("M3 scenarios" and the bar orders, Runs, fix panel and 4:00 AM tests) cover the same rules on every pull request.

Write down anything that doesn't read as this script says, with the screen, the time on the simulated clock and a photo.

## Who and what

- **Person A, at the bar:** the bar computer (the desktop app, paired as a bar computer), signed in as Maya S. with her PIN. The USB ticket printer plugged into it.
- **Person B, on the floor:** a phone signed in as Andy C. with his passkey, alerts turned on in Setup. A second phone or a laptop for the guest pages.
- **A room tablet** paired to Room 9 (Admin → Devices → Pair a device).
- **A network printer** (Star CloudPRNT or Epson Server Direct Print) added in Admin → Devices → Network printers, set to print bar tickets.
- The staging API address from `infra/README.md`, written below as `$API`.

## Before you start

1. Reload the demo seed in staging so the night starts at **Fri Sep 25, 2026, 10:41 PM** (the seed workflow, or `pnpm seed` against staging's database from the admin laptop).
2. Check the clock: the board's header reads 10:41 PM.
3. To jump the clock later, from a laptop: `curl -X POST $API/v1/ops/clock -H 'content-type: application/json' -d '{"server_time":"<UTC time>"}'`, then reload the screens. Times below give both the New York time and the UTC value.

## 1. What's ringing at 10:41 PM

- [ ] A: the side menu reads **Bar orders · 2**. The bar orders screen shows Room 9's 2 × Margarita · Peach (Ringing · 0:4x) and Room 5's 4 × Bud Light (Ringing · 2:1x, amber), and under Ready for a runner Room 3 and Room 1.
- [ ] B: the board shows the same two orders waiting at the bar.
- [ ] B: Room 9's tab (DeskRoom, Tab & close out) reads **Drinks $158.00** and **Tab so far $480.00**, and no Margarita · Peach is on it.

## 2. Accept, print, carry (the six steps)

- [ ] A: tap **Accept · print ticket** on Room 9's order. It moves to Being made: "Accepted by Maya S. · 10:4x · on Room 9's tab". **Bar orders · 1**.
- [ ] The ticket prints on the bar printer and the card reads "ticket printed".
- [ ] Room 9's tablet and the guest page read **Being made · on your tab**. Room 9's drinks read $184.00, tab so far $506.00.
- [ ] A: tap **Ready**. B's phone buzzes; Runs lists it "Ready for a runner".
- [ ] B: on Runs tap **I've got it**: every screen reads "On its way · Andy C."; the room reads "On its way to Room 9".
- [ ] B: tap **Delivered**. The tab doesn't change: Delivered never charges.

## 3. Orders from a tablet and from a phone

- [ ] On Room 9's tablet, order one drink. On the guest phone, join Room 9 with code **KX4M7** and order another.
- [ ] Each one rings on the bar orders screen and the board within a few seconds, with the chime.
- [ ] A: tap **Ask the room to wait** on one. The room reads "The bar needs a few minutes"; the order stays under Waiting for you and keeps aging.
- [ ] A: accept both. Each prints and joins Room 9's check at Accept, not before.
- [ ] Do the same once with the network printer set as the bar's printer, and once with the USB printer.

## 4. Nobody answers

- [ ] Order from the tablet and leave it. At 30 s the bar phones buzz; at 2 min the board shows it; at 4 min it reads "on Andy's phone"; at 6 min Andy gets a text.
- [ ] Unplug the bar printer and accept an order: "Ticket didn't print · Reprint" shows on the bar screen and the board. Plug it in, tap Reprint: the ticket says **REPRINT 2**.

## 5. Comps, voids and approvals

- [ ] A (Maya): on Room 9, the fix panel reads **$63.00 left this shift**. Comp one $13.00 Margarita with a reason: no approval, and it reads **$50.00 left this shift** on every screen.
- [ ] B: **Approvals · 1** on Andy's phone: Diego's void of the Large bucket · 10 beers, $70.00, "rang it wrong". Approve it: Tariq A.'s drinks go from $79.00 to $9.00.

## 6. Cut-offs

- [ ] B: cut off Room 1 from the board with a reason. Every screen for Room 1 reads "Cut off by Andy at …"; the room page greys alcohol; a staff order of a beer for Room 1 is refused.
- [ ] Cut off one guest in Room 9: that guest's phone can't order alcohol; the others can.

## 7. The 4 AM stop and the clear-out check

- [ ] Order a beer from the tablet and leave it ringing. Jump to **3:59 AM** (`2026-09-26T07:59:00Z`), then wait for 4:00.
- [ ] At 4:00 AM every alcohol button greys out with the reason; the ringing beer reads "Cancelled at 4:00 AM" with no Decline button, and the room reads "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged". A Red Bull still adds.
- [ ] Jump to **4:30 AM** (`2026-09-26T08:30:00Z`): the board asks for the clear-out check. B taps **Done**: it reads "Clear-out check · Andy · 4:3x AM".

## When it's done

Note the date, who ran it, which printers (model and how connected) and anything that didn't match, in M3-25's Notes in `docs/backlog/M3-room-orders-and-bar-screen.md`.
