# Manual test guide

This guide is for testing the whole system yourself, by hand, on your own Mac. You don't need to know how to program. Every test follows the same pattern:

- **Goal:** what you're checking.
- **Who / where:** who to sign in as and which window to use.
- **Steps:** what to click, in order.
- **You should see:** the exact words and amounts. Words in **bold** or "quotes" are what the screen should say.
- **If it's wrong:** what to note down.

Everything runs on the pretend Friday night, **Fri Sep 25, 2026, 10:41 PM**, the "demo seed". The people, rooms and amounts are in [demo-seed.md](demo-seed.md), and the setup basics are in [local-testing.md](local-testing.md). This guide repeats what you need, so you don't have to switch between them.

**When something is wrong**, write down four things:

1. The screen and the button you pressed.
2. The time on the app's clock (top of the board), not your Mac's clock.
3. What you expected (from this guide) and what you saw.
4. A screenshot (Cmd + Shift + 4).

The app's own logs are in the `.demo-logs` folder (`api.log`, `staff.log`, `guest.log`, `worker.log`, `stripe.log`). Attach them if a page shows an error.

**Tests build on each other.** Many tests change the night: they pay a check, move a room, or close the night. To repeat a test from the start, reset the night (step 0.9). A good order is the section order below. Do anything that moves the clock past 4 AM (sections 7, 17 and 18) last, then reset.

---

## Contents

0. [Before you start](#0-before-you-start)
1. [Rooms: the board](#1-rooms-the-board)
2. [Check-in, walk-ins, the waitlist and the door QR page](#2-check-in-walk-ins-the-waitlist-and-the-door-qr-page)
3. [Rooms: clock, party size, move, faults, damage, notes, lost and found](#3-rooms-clock-party-size-move-faults-damage-notes-lost-and-found)
4. [Room orders from the guest phone and the room tablet](#4-room-orders-from-the-guest-phone-and-the-room-tablet)
5. [Bar orders screen: accept, wait, decline, runs, delivery](#5-bar-orders-screen-accept-wait-decline-runs-delivery)
6. [Comps, voids and approvals](#6-comps-voids-and-approvals)
7. [Alcohol rules: 86, cut-offs, ID checks, the 4 AM stop](#7-alcohol-rules-86-cut-offs-id-checks-the-4-am-stop)
8. [Bar POS, tabs, quick sale and rounds](#8-bar-pos-tabs-quick-sale-and-rounds)
9. [Bar mode: singers, the song queue, credits and the TV](#9-bar-mode-singers-the-song-queue-credits-and-the-tv)
10. [Payments: the check, reader, cash, split, Pay my share, tips, receipts, refunds](#10-payments-the-check-reader-cash-split-pay-my-share-tips-receipts-refunds)
11. [Kitchen and food](#11-kitchen-and-food)
12. [Guest website and online booking](#12-guest-website-and-online-booking)
13. [Messages, texts and STOP](#13-messages-texts-and-stop)
14. [Calendar](#14-calendar)
15. [Staff, PINs, badges, the time clock, breaks, tips and the tip pool](#15-staff-pins-badges-the-time-clock-breaks-tips-and-the-tip-pool)
16. [Cash drawers](#16-cash-drawers)
17. [Close the night, X and Z reports, unmatched payments, break-glass card](#17-close-the-night-x-and-z-reports-unmatched-payments-break-glass-card)
18. [Reports and exports](#18-reports-and-exports)
19. [Admin, section by section](#19-admin-section-by-section)
20. [Offline and outages](#20-offline-and-outages)
21. [The Console (our own staff)](#21-the-console-our-own-staff)
22. [The status page](#22-the-status-page)
23. [Spanish review](#23-spanish-review)
24. [Accessibility quick checks](#24-accessibility-quick-checks)
25. [CAPTCHA and daily limits](#25-captcha-and-daily-limits)
26. [What you can't test locally](#26-what-you-cant-test-locally)
27. [Printable checklist](#27-printable-checklist)

---

## 0. Before you start

### 0.1 Start the demo

1. Open **Docker Desktop** and wait until it says it's running.
2. Open **Terminal** and type:

   ```
   cd ~/Downloads/west4-karaoke
   nvm use
   scripts/demo-start.sh
   ```

   The first time only, run `corepack enable` and `pnpm install` before `scripts/demo-start.sh`.
3. Wait for **Ready**. Leave this window open: the app runs only while it's open. **Ctrl+C** in this window stops everything.

The start script prints two **invite links**, one for Abhishek (owner) and one for Andy (manager).

To test the kitchen (section 11), start it as `scripts/demo-start.sh --sing-sing` instead: it also makes Sing Sing, a second demo venue with Kitchen & food on, and prints its own invite links.

**The addresses** (always use Chrome, and always `localhost`, never `127.0.0.1`, or Touch ID won't work):

| What | Address |
| --- | --- |
| Staff app | http://localhost:5173 |
| Guest website | http://localhost:3001/v/west4karaoke |
| Book a room | http://localhost:3001/v/west4karaoke/book |
| Menu | http://localhost:3001/v/west4karaoke/menu |
| Private parties | http://localhost:3001/v/west4karaoke/parties |
| Waitlist (the door QR) | http://localhost:3001/v/west4karaoke/waitlist |
| Singer queue | http://localhost:3001/v/west4karaoke/sing |
| Room tablet | http://localhost:3001/tablet |
| Up next TV | http://localhost:3001/tv |
| Status page | http://localhost:3001/status |
| Email inbox | http://localhost:8025 |
| Console (start it first, see section 21) | http://localhost:5174 |

To check the API is alive, open http://localhost:3000/v1/health. It should show `"ok":true`.

### 0.2 Sign in as the owner (Abhishek)

1. Copy the line `Invite for abhishek@demo.west4.local: http://localhost:5173/invite/…` from Terminal and open it in Chrome.
2. You should see "Join West 4 Boho Karaoke · you're joining as Owner".
3. Type any US mobile number, for example `+1 212 555 0123`, and press **Text me a code**.
4. Get the code from a second Terminal window:

   ```
   cd ~/Downloads/west4-karaoke
   scripts/demo-codes.sh
   ```

   Use the code marked `text to +12125550123`.
5. Type the code and press **Confirm**.
6. Choose a 6-digit PIN. Easy ones like 123456 are refused. Press **Set my PIN**.
7. Press **Add a passkey** and touch Touch ID.
8. Press **Go to sign-in**, type `abhishek@demo.west4.local`, press **Continue with a passkey**, and touch Touch ID. You land on **Rooms** (the board).

### 0.3 A second person: Andy, the manager

Approvals must be decided on the approver's own phone. To test them you need two "people" at once.

1. Open an **Incognito window** (Cmd + Shift + N), or a second Chrome profile.
2. Repeat 0.2 with Andy's invite link and `andy@demo.west4.local`.
3. In Andy's window, open **Alerts** (on the phone layout, or the side menu) and press **Turn on alerts**. This browser is now "Andy's phone". Approvals for Maya and Diego land here.

Do the same for Abhishek's window: requests from Andy himself go to Abhishek.

### 0.4 A shared screen for PIN staff (Maya and Diego)

Bartenders and front-desk staff sign in with a name and PIN on a **paired** shared computer.

| Person | Role | PIN |
| --- | --- | --- |
| Abhishek G. | Owner | 915204 (passkey) |
| Andy C. | Manager | 730915 (passkey) |
| Maya S. | Bartender | 4071 |
| Diego R. | Front desk | 6358 |

1. As Abhishek, open **Admin → Printers & devices** and make a pairing code (choose the bar computer or the front-desk computer).
2. In another Chrome profile or Incognito window, open http://localhost:5173/sign-in and press **Pair this screen**.
3. Type the code in "Pairing code from Admin → Devices" and press **Pair**.
4. Name tiles appear. Tap **Maya S.** and type `4071`. She lands on her bar home (Bar POS). Diego (`6358`) lands on Rooms.

A pairing code works only once. **Revoke** in Admin → Printers & devices signs that screen out at once ("Revoke {name}? It signs out at once and has to be paired again.").

Tip: a Chrome window can only be one paired screen at a time. Use one profile for "the bar computer" and another for "the front desk".

### 0.5 See it as a phone

1. In Chrome, press **Cmd + Option + I** to open the developer tools.
2. Press **Cmd + Shift + M** for the device toolbar, and pick an iPhone at the top.
3. Reload. The bottom of the screen shows the phone tabs: Bookings, Rooms, Calls, Waitlist, Messages, Approvals, Incidents, Tips to enter, Clock in and out, My tips, Reports, Offline codes, Alerts and Admin. Which ones you see depends on who's signed in.

Use the phone size for the guest pages too.

### 0.6 Spanish

Press **Español** in the staff app's side menu. Every staff screen switches. **English** switches back. A person's language can also be set in **Admin → Team**; it then applies at their next sign-in.

### 0.7 Moving the simulated clock

The app's clock starts at 10:41 PM and ticks forward like a real clock. It never uses your Mac's date. To jump, use a second Terminal window:

```
curl -X POST http://127.0.0.1:3000/v1/ops/clock -H 'content-type: application/json' -d '{"server_time":"2026-09-26T02:45:00Z"}'
```

Then **reload** every page.

The time is in **UTC**, which is New York time **plus 4 hours** in September. Handy values:

| New York time | Type this |
| --- | --- |
| Fri 10:44 PM | `2026-09-26T02:44:00Z` |
| Fri 10:45 PM | `2026-09-26T02:45:00Z` |
| Fri 10:50 PM | `2026-09-26T02:50:00Z` |
| Fri 11:11 PM | `2026-09-26T03:11:00Z` |
| Fri 11:20 PM | `2026-09-26T03:20:00Z` |
| Sat 3:30 AM | `2026-09-26T07:30:00Z` |
| Sat 3:59 AM | `2026-09-26T07:59:00Z` |
| Sat 4:00 AM | `2026-09-26T08:00:00Z` |
| Sat 4:02 AM | `2026-09-26T08:02:00Z` |
| Sat 4:12 AM | `2026-09-26T08:12:00Z` |
| Sat 4:30 AM | `2026-09-26T08:30:00Z` |
| Sat 4:48 AM | `2026-09-26T08:48:00Z` |
| Sat 5:10 AM | `2026-09-26T09:10:00Z` |

You can only move forward in a useful way. To go back to 10:41 PM, reset the night (0.9).

### 0.8 Where texts and emails show up

Nothing ever reaches a real phone or inbox.

- **Emails** (codes, receipts, payroll copies, alerts to the owner): http://localhost:8025.
- **Sign-in codes:** `scripts/demo-codes.sh` in a second Terminal window. It shows each code whether it was texted or emailed: West 4 has a pretend connection to its own Twilio account, so its codes are "texted"; a venue that hasn't connected Twilio (Sing Sing, a new venue) gets its codes by email.
- **Every text the app writes** (Room code, Room ready, Running late, confirmations, payment links, receipts): the **Messages** screen in the staff app. Links inside the texts the app sends while you test (for example the room host link `/r/…` in a Room code text after a check-in, or a booking's manage link `/b/…` after an online booking) can be copied from there and opened in a phone-size window.
- **The night's own guest links:** the texts already in the demo night carry no links, so the reset script (0.9) prints two at its end: `Room 9 host link (Marcus T.): http://localhost:3001/r/…` and `Jae & co.'s manage link: http://localhost:3001/b/…`. To print them again (a new manage link each time; the last one stops working):

  ```
  cd ~/Downloads/west4-karaoke
  node scripts/demo-links.mjs
  ```

- **A guest texting the venue** (STOP, HELP, "running late"): there's no real phone, so a command sends the text in, as Twilio would (section 13):

  ```
  cd ~/Downloads/west4-karaoke
  node scripts/demo-text.mjs "STOP"
  ```

### 0.9 Resetting the night

```
cd ~/Downloads/west4-karaoke
scripts/demo-local.sh
```

This puts the night back to 10:41 PM with fresh data and prints new invite links, then Room 9's host link and Jae & co.'s manage link (0.8). **It signs everyone out and removes your passkeys**, so redo 0.2 to 0.4 afterwards. Restarting `scripts/demo-start.sh` does the same.

Don't run `pnpm e2e` while the demo is open: it reloads the same database. Use `pnpm e2e:isolated` if you need the automated tests.

### 0.10 The fake card reader and test cards

The demo uses a **fake Stripe**, so no real money moves and you never type a card number.

- **On the guest payment page**, the page reads "Test payment · no real card is charged". The main **Pay …** button pays with Stripe's test Visa (4242 4242 4242 4242). **Try a declined test card** shows a decline.
- **On the card readers (Bar S710, Front desk S710)**, staff press **Send {amount} to the reader**. The screen then waits: "Waiting for a tap on the front-desk reader · Cancel". Outside training mode, nobody can "tap" a card in the demo, so the payment waits. Press **Cancel** to free it.
- **To finish a reader payment by hand, use training mode.** As Abhishek, open **Admin → Team** and turn on **Training mode for {name}** (for example Maya) or **Training mode on a device**. That screen then shows a band, "TRAINING · not real money", and the payment screens offer **Tap a test card** and **Tap a declined test card** ("Practice: the simulated reader takes Stripe's test cards"). Practice checks are numbered T-…; real checks (like Room 9's #1042) aren't touched. Turn training off again afterwards.

Other test cards the fake understands (for reference): decline 4000 0000 0000 0002, saves then declines later 4000 0000 0000 0341, refund fails ··5126, dispute 4000 0000 0000 0259.

### 0.11 The desktop app (bar and front-desk computers)

Some things only work in the desktop app: printing to a USB printer, the cash drawer kick, the read-only offline view, queue mode and badge readers. The start script doesn't open it. With the demo running, open a third Terminal window:

```
cd ~/Downloads/west4-karaoke
mkdir -p .demo-logs/printer
WEST4_FAKE_PRINTER=1 WEST4_FAKE_PRINTER_DIR="$PWD/.demo-logs/printer" WEST4_FAKE_READER=1 pnpm --filter @west4/desktop dev
```

- A window opens with the staff app (http://localhost:5173). Pair it as the bar computer (0.4).
- `WEST4_FAKE_PRINTER=1` gives it a **virtual USB printer**. Each ticket it "prints" is saved as `ticket-1.bin`, `ticket-2.bin`… in `.demo-logs/printer`. To read one roughly: `strings .demo-logs/printer/ticket-1.bin`.
- To "unplug" the virtual printer: click the desktop app's window ("West 4 Staff"), then in the menu bar at the top of the Mac's screen choose **View → Toggle Developer Tools** (or press **Alt + Cmd + I**). In the **Console** tab, type `await west4.fakePlug(false)` and press Return. `await west4.fakePlug(true)` plugs it back. It only works when the app was started with `WEST4_FAKE_PRINTER=1` (otherwise: "refused: no virtual printer").
- `WEST4_FAKE_READER=1` gives it an emulated badge reader. A real badge tap can't be done by hand without hardware; sign in with PINs instead.

The optional `pnpm --filter @west4/desktop rebuild-native` builds the real USB reader support. You don't need it for the demo.

**On a Windows computer (W-01).** The demo runs on the Mac; the Windows app is tested on a real bar computer instead. Install it from CI's `west4-staff-windows` download (GitHub → Actions → CI → the run → Artifacts) or a release, then follow [hardware-install.md](runbooks/hardware-install.md#a-windows-bar-computer-w-01): install, the watchdog, pairing, the printer's driver (Epson's TM-T88V driver, or Generic / Text Only for another ESC/POS printer), Test print in Admin → Printers & devices, then the drawer test with a $1.00 cash payment. Tick the [real-Windows check list](runbooks/hardware-install.md#check-on-a-real-windows-bar-computer). To point a Windows app at your Mac's demo instead of staging, start it from PowerShell with `$env:STAFF_URL="http://<your Mac's address>:5173"; & "$env:LOCALAPPDATA\Programs\West 4 Staff\West 4 Staff.exe"` (the Mac and the PC on the same Wi-Fi).

### 0.12 Getting a room's wall-QR address

The room's wall QR opens `http://localhost:3001/v/west4karaoke/room/<room id>`. The room id is an internal number. To get it, in a Terminal window:

```
cd ~/Downloads/west4-karaoke
docker compose exec -T postgres psql -U west4 -d west4 -Atc "select name, id from rooms order by name"
```

Copy the id next to "Room 9". (The easier way into Room 9 as the host is its host link, printed by the reset script; see 0.8.)

---

## 1. Rooms: the board

**Who / where:** Andy (or Abhishek), desktop size, side menu **Rooms** (it was Tonight).

### 1.1 Counts and headcount

1. Open **Rooms**.
2. You should see:
   - The clock at **10:41 PM**.
   - "**8 in use · 3 open · 2 cleaning · 1 out of service**".
   - "**93 inside**" with "**77 in rooms · 16 waiting**".
   - "**Limit not set · Admin → Safety**". The app never invents an occupancy limit.
3. Press **+** on the door counter: 94. Press **−**: back to 93.

If it's wrong, note which number differs.

### 1.2 Room tiles

Check each tile's words and money:

| Room | Tile says | Room time so far | Tab so far |
| --- | --- | --- | --- |
| Room 1 | In room · 49 min left | $47.33 | $123.33 |
| Room 2 | Open · held for Sam O. until 10:45 | none | none |
| Room 3 | Wrap up · 4 min left | $96.67 | $175.67 |
| Room 4 | Out of service | none | none |
| Room 5 | In room · 79 min left | $40.00 | $40.00 |
| Room 6 | Needs a wipe · left 10:33 PM (8 min) | none | none |
| Room 7 | Needed now · 11 min past | $152.83 | $210.83 |
| Room 8 | Open · next 11:00 | none | none |
| Room 9 | In room · 19 min left | $322.00 | $480.00 |
| Room 10 | Staying · 41 min past | $331.50 | $441.50 |
| Room 11 | Open · free all night | none | none |
| Room 12 | In room · 79 min left | $235.67 | $305.67 |
| Room 13 | Needs a wipe · left 10:36 PM (5 min) | none | none |
| VIP room | In room · 109 min left | $295.83 | $775.83 |

- Wait one minute: the times and money move by one minute.
- Room 10 also reads "Stay on by the minute until we close at 4 AM".

### 1.3 Alerts, most urgent first

The alerts band at the top should list, in this order:

1. Pink: Room 7 is 11 min past its time, and The Parks (8) are booked into Room 7 at 11:00.
2. Pink: Room 9 called for another mic.
3. Amber: Room 3, 4 min left, Jae & co. at 11:00.
4. Lime: Room 11 is free all night, and Amara B. (7) has waited 26 min.
5. Grey: Rooms 6 and 13 need a wipe; Nadia K. and Chris P. are waiting.
6. Grey: Sam O. running 15 late, held until 10:45.

Press **Show all {count}**, then **Show only the {count} most urgent**. The waitlist name must be **Nadia K.**, never "Priya K.".

### 1.4 Timeline and list

1. Switch to **Timeline**: "Room by room, {from} to {to}" and "Tap a block for details".
2. Tap a block: its booking details open.
3. Switch back to **List**.

### 1.5 The room side panel

1. Tap Room 9's tile. A side panel opens with **Tab & close out**, **Move**, **Report a fault**, **Damage fee**, party size, the ID chip, **Scan ID**, the cut-off button and the faults.
2. Press **Tab & close out →**. You should see "161 min · $2.00 a minute", Room time so far **$322.00**, Drinks **$158.00**, Tab so far **$480.00**, "Deposit $120.00 · comes off at settle-up", and "Before tax and gratuity". The ringing margaritas are **not** on the tab yet.

### 1.6 Phone layout

1. Switch Andy's window to iPhone size (0.5).
2. The tabs show (Bookings, Rooms, Calls, Waitlist, Messages, Approvals, Alerts, Admin…). There is one **Rooms** (the board) and no Tonight; **Bookings** is tonight's bookings.
3. On Bookings, Sam O. offers **Check in**. **Mark no-show** shows only from 10:45. Marcus T. offers neither.
4. Sign in as Maya on a phone-size paired screen: she has no Approvals tab.

---

## 2. Check-in, walk-ins, the waitlist and the door QR page

### 2.1 Check in Sam O. (do this OR 2.2, not both, then reset)

**Who:** Diego or Andy. **When:** move the clock to 10:44 PM (`2026-09-26T02:44:00Z`) and reload.

1. In "Arriving", Sam O. reads "10:30 PM · Room 2". Press **Check in**.
2. Party: 3 guests. You should see "**3 guests · Fridays bill at least 4**" and "**Deposit applied −$40.00**".
3. Fill **IDs checked**, then check in.
4. The result line reads "Room 2 · room code {code} · check #{n}". The code has 5 characters.
5. Open **Messages**: a Room code text went to Sam with a join link.
6. Room 2's room time is $40.00 (the first-hour minimum for 4 guests).

### 2.2 Mark Sam O. a no-show

1. At 10:41, **Mark no-show** is hidden ("No-show from 10:45 PM").
2. Move the clock to 10:45 PM (`2026-09-26T02:45:00Z`) and reload.
3. Press **Mark no-show** on Sam O. Room 2 becomes free.

### 2.3 Walk-in

1. On Room 11, press **+ Walk-in**: a dialog "Walk-in · Room 11" opens over the board, which stays visible behind it. **Seat them** and **Cancel** stay at the dialog's foot while you scroll it. Step 5 reads "No deposit" at West 4.
2. Press **Esc**: the dialog closes, nothing is seated, and **+ Walk-in** has the focus again. Open it again; **Tab** never leaves the dialog. On a phone it's a full-height sheet from the bottom.
3. Enter a party and press **Seat them**.
4. Try a party too big for the room: "That room isn't free for this party".
5. Card on the tab (D112): in Admin → Deposits & cancelling, under **At a walk-in check-in**, pick **Put a card on the tab** and Save and publish. + Walk-in on a free room: step 5 reads "Card on the tab · the guest taps a card once they're seated". **Seat them**, then the dialog shows the consent line; press **Read to guest ✓** and tap a test card on the front-desk reader (demo: `scripts/demo-start.sh` runs the fake Stripe; present a card to "Front desk S710"). The done line ends "Card on the tab · visa ···4242"; nothing is charged. **Skip the card** seats them with no card. Set it back to **Take a deposit**.
6. Card behind the bar (D116; Sing Sing's choice, already set at Sing Sing, 11.1): in Admin → Deposits & cancelling, under **At a walk-in check-in**, pick **Keep the card behind the bar** and Save and publish. + Walk-in on a free room: step 5 reads "**Card behind the bar · note the name on the card and its last 4**". **Seat them**, then the dialog reads "Card behind the bar · Room {n}": "Take the guest's card, then type the name on it and its last 4 digits. Nothing is charged; it's given back at close-out." Fill **Name on the card** (`M. TORRES`) and **Last 4 digits** (`4242`) and press **Save the card**.
   - A full card number, a name with digits, or 3 digits is refused: "Type the name on the card and exactly its last 4 digits, never the whole number".
   - Done: the tile and the room read "**Card behind the bar · M. TORRES ···· 4242**". No reader is used and nothing is charged. **Skip the card** seats them with "No card behind the bar".
   - When the room's check is paid, the room screen shows "**Give the card back**" ("Hand the guest their card: M. TORRES ···· 4242") with **Returned**: "Card given back".
   - A card not given back is listed on Close the night: "Cards still behind the bar · {count}".
   - Set it back to **Take a deposit**.

### 2.4 The waitlist (staff side)

1. Open the board's **Waitlist · 3** drawer (phone: the Waitlist tab).
2. You should see Amara B. (7, "Joined 10:15 PM · waited 26 min", "Quoted 25 min"), Nadia K. (6) and Chris P. (3, "3 guests · bills as 4").
3. On Amara, press **Offer a room** (or the board's **Offer Room 11 · 10 min to claim**). You should see "Room 11 · 9:58 to claim" counting down, and a Room ready text in Messages.
4. Press **Seat**, enter 7 IDs checked, and check them in.
5. **Remove** takes a party off everywhere.
6. Optional, waits 10 minutes: if an offer isn't claimed, a 5-minute warning text goes out, and after 10 minutes it moves to the next party (Nadia K.).
7. If a Room ready text fails, the party reads "**Not delivered · Call**" (can't be forced in the demo).

### 2.5 The door QR page (guest side)

**Where:** a phone-size window, http://localhost:3001/v/west4karaoke/waitlist.

1. The page reads "Join the waitlist at West 4 Boho Karaoke", with Your name, Mobile number and How many of you.
2. Join as a party of **4** with any US number and press **Join the waitlist**.
3. You should see "**3 parties ahead**", and a **Leave the waitlist** button.
4. Move the clock to 10:45 PM, mark Sam O. a no-show (2.2), then in the staff Waitlist drawer press **Offer a room** on your party.
5. Reload the guest page: "**Room 2 is ready · 10:00 to claim it**", with **Give it away**.

---

## 3. Rooms: clock, party size, move, faults, damage, notes, lost and found

**Who:** Andy, unless a step says Diego. Use the room side panel (1.5).

### 3.1 Party size

1. Room 9: press **One guest more** twice (12 → 14). You should see "**$140.00 an hour**" and the chip "**ID ✓ 12 of 14**".
2. Move the clock to 11:11 PM: Room 9's room time reads **$392.00**.
3. Room 9 back down (**One guest fewer**). As Diego, lowering the party reads "**Waiting for Andy**", and the clock keeps billing the old size until Andy approves on his phone.
4. VIP room from 22 to 19 guests: the rate drops from $250 to $190 an hour.

### 3.2 Move a room

1. On Room 7's pink alert, press **Move a room…**.
2. Only **Room 11 · free all night** is offered; the others are greyed, each with a reason.
3. Pick Room 11. You should see "Moved to Room 11 · new code …". The price stays $70 an hour, the old code stops working, Room 7 goes to cleaning, and the check doesn't change.
4. Moving into Room 8 is refused (it's booked at 11:00).

### 3.3 Faults

1. On Room 5, press **Report a fault** ("Report a fault · Room 5").
2. In "What's wrong" type "Mic 2 cuts out", tick **Comp 15 min of room time**, and press **Log the fault**.
3. You should see "**Comp of $10.00 added**" (−$10.00 on the tab at once).
4. On Room 9, the same 15-minute comp is $30.00 and needs Andy's approval.
5. As Diego on the front desk, try **Pause the clock**: "Waiting for Andy", and it lands only on Andy's phone. Once approved, the room shows "Clock paused" and **Start the clock**.
6. **Fixed** clears the fault.
7. Room 4 reads "Out of service": "Mic dead since Tue. Replacement ordered."

### 3.4 Damage fee

1. On Room 9, press **Damage fee** ("Damage fee · Room 9").
2. Try without a photo: refused ("Photo of the damage" is required).
3. Add any photo and type in "What happened", then press **Add the damage fee**.
4. You should see a **$150.00** line with the photo's thumbnail, and Room 9's tab going from $480.00 to **$630.00**. Press **Done**.

### 3.5 Cleaning and notes

1. Room 6 reads "Needs a wipe · left 10:33 PM (8 min)". Press **Mark clean**: it becomes Open.
2. Room 6's **Room notes** read "TV remote goes missing. Check under the couch."

### 3.6 Lost and found

1. At the bottom of the board, press **Log a lost item**. Fill What it is ("Green scarf"), Where it was found (Room 9), Kept at, and a Photo. Press **Log it**.
2. It reads "Found in Room 9 · kept at the bar".
3. Press **Claimed**: it reads "claimed by …".

### 3.7 Calls from rooms

1. Open **Calls** (phone tab). Room 9's "Another mic, please" is there, and on the board.
2. As Diego, press **On it**: it disappears on every screen.
3. A call about the TV offers **Log as a fault**.

---

## 4. Room orders from the guest phone and the room tablet

### 4.1 Join Room 9 as a guest

**Where:** a phone-size window.

- **As the host:** open the `Room 9 host link (Marcus T.)` that the reset script printed (0.8; or run `node scripts/demo-links.mjs`). You should see "You're the host". (After you check a party in yourself, its Room code text in Messages carries the same kind of `/r/…` link.)
- **As a friend:** open the wall-QR address (0.12) for Room 9. It shows "Join Room 9" and a **Room code** field. Type `KX4M7` and press **Join**: "You're in", headed "Room 9 · Code KX4M7".
- A wrong code: "That code isn't right. Check the code on the wall." On the 10th wrong try the code changes and Andy is alerted.
- Room 11's wall QR: "Room 11 is closed right now."

### 4.2 What the guest sees

On the room page:

- "Tonight so far": Room time · 161 min **$322.00**, Drinks on your tab **$158.00**, Tab so far **$480.00**, "Before tax and gratuity · $2.00 a minute for 12", and "Your $120.00 deposit comes off when you settle up".
- **Call staff → Another mic**: "Staff get it on their phones", and it shows in Calls.
- **Need a manager, privately?** link (own phone only, never on the tablet). See 19.11.

### 4.3 Order a drink

1. Order 2 × Margarita · Peach (Margarita asks for a flavor: Raspberry, Peach or Strawberry).
2. You should see "**Sent to the bar · you can still cancel**".
3. As the bar accepts it (section 5), the status goes: "The bar needs a few minutes" (if asked to wait), "Being made · on your tab", "On its way to Room 9", "Delivered".
4. Cancel disappears once the bar accepts.
5. If the bar declines with "Out of peach": "The bar couldn't take this order · nothing charged".

### 4.4 Host lock and Same again

1. As the host, press **Lock ordering**. In the friend's window: "Marcus T. has locked ordering · ask them to send it".
2. Same again: after Room 3's order is delivered, Room 3 shows "2 × Margarita · Peach, 1 × Margarita · Strawberry" for $39.00. **Order this again** rings a new order. If something in it is 86'd: "Without {names} · 86'd tonight".

### 4.5 The room tablet

1. As Abhishek, Admin → Printers & devices: make a pairing code for Room 9's tablet.
2. In a new window open http://localhost:3001/tablet, press **Pair this tablet**, type the code, press **Pair**.
3. It shows Room 9's clock and $480.00. Order a drink: it rings at the bar within a few seconds.
4. Room 11's tablet (pair another) reads "Room available" and can't order.
5. There's no PIN pad on the tablet. Admin shows 13 of 14 tablets online (Room 4's is off).

---

## 5. Bar orders screen: accept, wait, decline, runs, delivery

**Who:** Maya on the paired bar screen. Side menu **Bar orders** (/bar-orders).

### 5.1 What's ringing at 10:41

- The menu reads "**Bar orders · 2**".
- "Waiting for you": Room 9's 2 × Margarita · Peach "Ringing · 0:4x", and Room 5's 4 × Bud Light "Ringing · 2:1x" in amber.
- "Ready for a runner": Room 3 and Room 1. Room 1 shows "ID ✓ 3 of 4 · the runner checks the last ID".
- No Ready or Delivered buttons on orders that aren't accepted yet.

### 5.2 Accept

1. On Room 9's order, press **Accept · print ticket**.
2. It moves to Being made: "Accepted by Maya S. · 10:4x · on Room 9's tab". The menu reads "Bar orders · 1".
3. Room 9's drinks go from **$158.00 to $184.00**, and the tab from **$480.00 to $506.00**.
4. Room 9's guest page reads "Being made · on your tab".
5. With the desktop app's virtual printer, a ticket file appears in `.demo-logs/printer`.

### 5.3 Ask the room to wait, then accept

1. On Room 5's order, press **Ask the room to wait**. It reads "Asked to wait", stays under Waiting for you and keeps aging. Room 5's phone reads "The bar needs a few minutes".
2. Accept it: Room 5's tab so far goes from $40.00 to **$72.00**.

### 5.4 Decline

1. Order something from a guest phone, then press **Decline…**.
2. Fill "Why? The room sees this" and press **Decline**. The guest sees "The bar couldn't take this order · nothing charged".

### 5.5 Nobody answers (aging)

Order from the tablet and leave it ringing:

- At 30 s the bar phones buzz.
- At 2 min it shows on the board.
- At 4 min it reads "on Andy's phone".
- At 6 min Andy gets a text (see Messages).
- **Mute the chime for 60 s** shows "Chime muted · back in {s} s".

### 5.6 No bar device

Close every bar-screen window. Within a short time the board and Maya's phone read "No bar device connected since {time}…". It clears when you reopen the bar screen.

### 5.7 Ticket didn't print (desktop app needed)

1. In the desktop app, unplug the virtual printer (`west4.fakePlug(false)`, see 0.11).
2. Accept an order. You should see "**Ticket didn't print · Reprint**" on the bar screen and the board.
3. Plug it back in (`west4.fakePlug(true)`) and press **Reprint**. The new ticket says **REPRINT 2**.

### 5.8 Runs and delivery

**Who:** Andy, phone size, the **Runs** tab (or menu Runs).

1. Room 3's order is "Ready for a runner". Press **I've got it**: every screen reads "On its way · Andy C."; Room 3's guest page reads "On its way to Room 3".
2. Press **Delivered**: "Delivered · {time} · Andy". **The check doesn't change**: drinks are charged at Accept, never at Delivered.
3. On Room 1's order, press **Couldn't serve…**, pick "No ID for someone who ordered", then **Send it back to the bar**. It shows under "Returned". The bar picks Void · not made, Void · made (waste) or Remake.
4. Picking the "too drunk" reason offers Andy "Cut off Room 1?".
5. **Record an ID checked here** makes Room 1 read "ID ✓ 4 of 4".

---

## 6. Comps, voids and approvals

### 6.1 A comp that needs only a reason

**Who:** Maya.

1. On Room 9, open **Fix** ("Fix a sent drink"). The panel reads "**$63 left this shift**".
2. Choose **COMP · the house pays for it** on a $13.00 Margarita and give a reason.
3. No approval is asked. The panel reads "**$50 left this shift**" on every screen.

### 6.2 A void that needs Andy

1. Andy's phone (Approvals tab) reads "**Approvals · 1**": Diego's void of 1 × Large bucket · 10 beers, $70.00, "rang it wrong", on Tariq A.'s tab.
2. Diego's screen shows "Waiting for Andy".
3. Andy presses **Approve**. Tariq A.'s drinks go from **$79.00 to $9.00**; tax $0.80; total **$9.80** (was $86.01).
4. Try again with a new void: Diego voids a $26 line → "Waiting for Andy" → Andy presses **Decline** → nothing changes.
5. Andy's own void over $25 goes to Abhishek's phone, never his own.

**Rules to check:** comps and voids up to $25 each and $75 a shift need only a reason. Over that, a manager approves on their own phone. Nobody approves their own request.

---

## 7. Alcohol rules: 86, cut-offs, ID checks, the 4 AM stop

### 7.1 86 an item

1. The menu already shows Hoegaarden, Casamigos Blanco and Casamigos · bottle as "**86'd tonight**" (bar POS, guest room page, website menu).
2. As Maya on Bar orders, use **86 an item** on Bud Light ("Out tonight"). It greys out everywhere. Tap again to bring it back.
3. A runner can't 86.

### 7.2 Cut off a room

**Who:** Andy.

1. On Room 9 (side panel or Runs), press **No more alcohol for this room**, answer "Why is Room 9 cut off?", press **Cut off**.
2. Every Room 9 screen reads "Cut off by Andy at 10:4x PM". A ringing alcohol order reads "Cancelled · cut off by Andy". Guests see "Your server has paused alcohol for this room".
3. A Red Bull still goes through. A staff order of a beer for Room 9 is refused.
4. **No more alcohol for this guest** blocks only that one guest's phone.
5. Hana K.'s bar tab is already "**Cut off by Andy at 10:30 PM**": alcohol greyed, her song still plays.

### 7.3 ID checks

1. Room 1's chip reads "ID ✓ 3 of 4 · the runner checks the last ID". Room 5: "ID ✓ 4 of 4".
2. Check-in has **IDs checked** and a **Scan ID** button (it uses the camera). With Safety & ID records off in Admin → Features, Scan ID disappears.

### 7.4 The 4 AM stop (do this near the end, then reset)

1. Order a beer from the tablet and leave it ringing.
2. Move the clock to 3:59 AM (`2026-09-26T07:59:00Z`), reload, and wait a minute.
3. At 4:00 AM:
   - Every alcohol button greys out with the reason in words.
   - The ringing beer reads "**Cancelled at 4:00 AM**" with no Decline button.
   - The guest page reads "**The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged**".
   - A Red Bull still adds. A Margarita + Red Bull order keeps ringing with only the Red Bull.
   - Every room reads Wrap-up; nothing offers stay-on (from 3:30 AM).
4. Move to 4:30 AM (`2026-09-26T08:30:00Z`). The board asks for the clear-out check: "Walk every room and the bar · no drinks left out". Andy presses **Done**: "**Clear-out check · Andy · 4:3x AM**". It happens once a night.

---

## 8. Bar POS, tabs, quick sale and rounds

**Who:** Maya on the paired bar screen, side menu **Bar POS** (/bar).

### 8.1 The screen

- Tabs in this order: Hana K. ($43.55, Cut off), Jess P. ($32.66), Luis M. ($63.15), Tariq A. ($86.01, Waiting for Andy), Seat 6 · blue jacket ($13.07). Then room tabs: Room 9, Room 12, VIP room.
- Ringing room orders across the top, each with **Accept**. Accepting Room 5 makes its tab $72.00.
- The words are "Ask the room to wait" and "Back to the sale", never "Hold", for a room order.

### 8.2 Repeat round

1. Open Jess P., press **Repeat round**, then Send. Two taps.
2. If the round includes an 86'd item, it's left out and the screen says so.
3. A Margarita without a flavor blocks Send; the button names the missing flavor.

### 8.3 Quick sale

1. Press **Quick sale**, add a Bud Light, pay in cash. "Logged to Maya · bar drawer".
2. A $9 sale on the reader offers tips of $1/$2/$3; a $30 sale offers $5.40/$6.00/$6.60. (Finishing a reader payment needs training mode, 0.10.)
3. Picking a singer (Kira) gives her 1 song credit.

### 8.4 New tab

1. Press **New tab**, tick **Read to guest ✓**, type a label, press **Open**.
2. The consent line reads "We'll hold $50 on this card and add to it as you order…".
3. The card tap needs training mode in the demo. Tapping Jess's card again reopens her existing tab.

### 8.5 Holds, splitting, closing

- Luis M.'s hold already grew from $50 to $80. A declined raise reads "**Hold raise declined**", and the next round waits for Andy. A tab over $600 alerts Andy.
- **Close tab → Close to the card** on Jess ($32.66): the reader offers $5.40 / $6.00 / $6.60, Custom, No tip. With $6.00 she pays **$38.66**. Luis $63.15 + 22% ($12.76) = **$75.91**. (Reader steps need training mode.)
- Split Jess's tab in 2: $16.33 + $16.33. Pay one in cash, leave, come back: "**Partly paid · $16.33 of $32.66**". Luis split in 4: $15.79 × 3 and $15.78. **Stop splitting · charge the rest to Visa ··4417**.
- Hana's $43.55 on another card: her hold on ··5120 is released. Seat 6's $13.07 in cash: the drawer opens and the tab closes.
- **Reopen** a closed tab from "Closed tonight": it reads "Paid … · no hold". Adding a drink offers **Charge the saved card** (needs a Yes on the reader or Andy's approval).

### 8.6 Move a tab into a room

1. Move Jess P.'s tab to Room 9. Lines read "Moved from Jess P.'s bar tab"; the tab reads "Moved to Room 9"; her hold is released.
2. Room 9 now presents at subtotal $510.00, tax $45.26, gratuity $102.00, total **$657.26**, **$537.26** left.
3. Moving 2 × Modelo onto Hana's tab is refused (she's cut off).

### 8.7 Shared screen behaviour

- 3 idle minutes lock the screen.
- **Wipe screen** ignores touches for 10 seconds.
- On a break, the top bar reads "Maya · on break" (see 15.3).
- Diego's unsent Red Bull ($6) on Tariq's tab follows him; Maya sees "1 not sent".

### 8.8 Gift a drink

1. Tariq sends Jess a Modelo: it rings at the bar, goes on Tariq's tab, and the ticket names Jess.
2. A gift to Hana is refused ("Cut off by Andy at 10:30 PM"). A gift after 4 AM is refused.

### 8.9 Drink tickets setting (M6-29)

1. As Andy, **Admin → Bar POS**: the row "**Print tickets for drinks rung at the bar**" is **off** at West 4.
2. Off: a Send on Jess's tab and a quick sale print nothing.
3. Turn it on and **Save and publish**. Send on a bar tab now prints a bar ticket.
4. Room 9's orders always print, whatever the setting: accepting a guest order, adding from Room 9's tab on a phone, or a round rung on the bar POS.
5. Maya can't change the setting. Andy's change is live at once.

---

## 9. Bar mode: singers, the song queue, credits and the TV

### 9.1 Song queue

**Who:** Maya, side menu **Song queue** (/song-queue).

1. The header reads "**Song queue · 6**". Round 3, 23 songs sung.
2. Now singing: Luis M., "Mr. Brightside", The Killers. Next: Jess P., Kira, Ben T., Tariq A., Hana K., Sofia R.
3. Sofia is flagged "**Needs a drink credit**" and can't start without one. Tariq has 2 credits.
4. Jess's second song goes into round 4. Moving Sofia up needs a reason.
5. **Started** on a singer with a tab puts a $0.00 song line on the tab. Kira spends a credit and gets no line. Skipping Jess gives her credit back.

### 9.2 The singer's page

**Where:** phone size, http://localhost:3001/v/west4karaoke/sing.

1. Ben T.'s view reads "**2 singers before you**".
2. A new singer joins with a phone code (from `scripts/demo-codes.sh`) and searches "Valerie".
3. Only the singer's own phone number ever shows.
4. When their turn is near: a push, then "You're up next at the bar · come to the stage" by push and text. A singer who texted STOP gets the push only.

### 9.3 Up next TV

Open http://localhost:3001/tv (pair it as the Up next display in Admin → Printers & devices if asked). It shows Luis, the next 5 and the join QR, never a phone number, and updates within 3 seconds of a change.

### 9.4 Songbook and settings

1. **Admin → Bar mode:** "Song price · not set · songs need a drink credit", drink credit on, 1 song per round, both alerts on. A free drink with a song is refused.
2. Upload a songbook CSV there, then search "brightside": "Mr. Brightside · The Killers". A CSV with a missing title on line 12 is reported as line 12. The website's song section then shows a search box.

---

## 10. Payments: the check, reader, cash, split, Pay my share, tips, receipts, refunds

### 10.1 Room 9's totals

**Who:** Andy or Diego, Room 9's **Tab & close out**.

| Line | Amount |
| --- | --- |
| Room time, 161 min × $2.00 | $322.00 |
| Drinks | $158.00 |
| Tax (8.875%) | $42.60 |
| Gratuity (20%, before tax) | $96.00 |
| **Total** | **$618.60** |
| Deposit | −$120.00 |
| **Left to pay** | **$498.60** |

If the margaritas were accepted first: total **$652.11**, **$532.11** left.

### 10.2 Present the check

1. While the margaritas still ring, press **Present the check**. Refused: "**2 × Margarita · Peach is ringing at the bar · accept or cancel it first**".
2. Cancel or decline that order, then **Present the check**: check **#1042**, **$618.60**.
3. Guest phones and the tablet read "**Your bill is ready · ordering is closed**". A new order from a guest phone is refused.
4. Andy reopens the check. Diego can't reopen.

### 10.3 Card reader

1. Press **Send $498.60 to the reader** and pick the Front desk S710: "Waiting for a tap on the front-desk reader · Cancel".
2. Outside training mode this waits forever in the demo. Press **Cancel**: the $498.60 is free again.
3. In training mode (0.10): **Tap a test card** → "Paid". **Tap a declined test card** → "Declined · try another card or cash", and cash is still offered.
4. A second payment on a busy reader shows "Reader busy"; picking the other reader works.
5. While a payment's result is unknown, screens read "**Checking with Stripe · don't retry**" and no second payment can start.

### 10.4 Cash

**Who:** Diego on the front desk.

1. Room 9's $498.60, with $500.00 handed over: **$1.40** change in large type, "Logged to Diego · front-desk drawer".
2. Room 5 at $51.55 with "the next $20" ($60.00): **$8.45** change. **Wrong amount? Fix the change** to $100.00 shows **$48.45**.
3. A cash tip shows as "Additional tip (optional)".
4. Paid in full: receipt choices appear, then "Room 9 goes to cleaning" and the tile turns to cleaning.

### 10.5 Split the check

1. Even split in 3: **$166.20** each.
2. Pay share 1 (training reader) and share 2 in cash. Leave and come back: both still paid, $166.20 left.
3. **Stop splitting · charge the rest to …**. Split by item also works.

### 10.6 The guest's bill and Pay my share

**Where:** a guest phone joined to Room 9 (4.1), after the check is presented.

1. **Your bill**: room time $322.00, drinks $158.00, tax $42.60, gratuity $96.00, total $618.60, deposit −$120.00, **$498.60** due.
2. **Pay cash to staff** shows on the board and every staff phone's Calls.
3. **Pay my share** for 1 of 12: **$41.55** (each share shows $3.55 tax and $8.00 gratuity). The payment page reads "Test payment · no real card is charged"; press **Pay $41.55**.
4. The room screen reads "**Paid by a guest · Kevin (share 1 of 12) $41.55**" (the name is whatever the guest gave).
5. With the margaritas accepted first: shares 1–3 are $44.35 and 4–12 are $44.34.
6. Turn off Pay my share in Admin → Card fee & gratuity: the button is gone.

### 10.7 Card on file

1. Andy picks **Card on file** on Room 9: "Waiting for Marcus to confirm on his phone · Cancel".
2. On Marcus's (host) phone, tap **Pay with Amex ··1005**: $498.60 charged, #1042 paid, receipt text sent.
3. As Diego: **Ask a manager to approve** → "Waiting for Andy"; the charge runs only after Andy approves on his own phone.

### 10.8 Receipts

1. After paying, choose a receipt: print, text or email.
2. Texted receipts appear in Messages; emailed ones at http://localhost:8025. Open the `/receipt/…` link.
3. Every copy matches: "**Gratuity included (20%)**", tax lines $28.58 and $14.02, "Deposit −$120.00", the payments, #1042. A tip prints as "Additional tip (optional)", never "Gratuity".
4. A broken receipt link shows not found.

### 10.9 Refunds

1. As Andy, open **Refund from check** on Marcus's booking. The amount starts empty and is capped at $120.00. The button reads "**Send to Abhishek**".
2. Status: "Waiting for Abhishek". $120.01 is refused.
3. Abhishek approves on his phone: "Refund pending" → "Refunded". After a $50 refund, at most $70 more can come off.
4. Maya and Diego don't see Refund.

### 10.10 Deposits at check-in

- Sam O. (3, bills as 4): "(−$40)" applied (2.1).
- Room 9's $120.00 deposit is already on the check.

---

## 11. Kitchen and food

**Important:** West 4's plan in the demo does **not** include Kitchen & food. In West 4's Admin → Features it reads "**Not in your plan**", and Admin → Kitchen isn't listed. Kitchen & food is tested at **Sing Sing**, a second demo venue that one command sets up with the kitchen on.

### 11.1 Start the Sing Sing demo (one command)

Sing Sing Karaoke Astoria is made in the same demo, next to West 4, with:

- **6 rooms**, Room 1 to Room 6 (their sizes and prices are copied from West 4's: placeholders until Sing Sing's manager gives the real ones);
- **Kitchen & food on** (allowed in its plan, a pretend kitchen network printer, and an allergy notice marked "DEMO ONLY");
- **Ordering from the room on** (guests order food and drinks from their phones and the room tablets), and Bar mode off;
- **No deposits** for online bookings, and **Keep the card behind the bar** at a walk-in check-in (D116);
- all ages until 8 PM, then 21 and over; Sing Sing's opening hours (Fri and Sat until 3 AM);
- **Sing Sing's real menu** (about 104 items, drinks and food, including Mac & Cheese, French Fries, Onion Rings, Classic Cheese, Cheese Sticks and Coleslaw), loaded with the importer from `docs/venues/sing-sing/import`;
- the same four people as West 4, with their own sign-ins: Abhishek (owner) and Andy (manager) by invite link, Maya (bartender, PIN **4071**) and Diego (front desk, PIN **6358**).

There are no guests, bookings or tabs yet: it's an empty Friday at 10:41 PM, on the same clock as West 4.

**To start it**, stop the demo (Ctrl+C) and start it with Sing Sing:

```
cd ~/Downloads/west4-karaoke
scripts/demo-start.sh --sing-sing
```

Or, while the demo is already running, reset the night with Sing Sing in a second Terminal window (this also resets West 4's night, see 0.9):

```
cd ~/Downloads/west4-karaoke
scripts/demo-local.sh --sing-sing
```

After West 4's two invite links, it prints:

```
Seeded Sing Sing Karaoke Astoria: 6 rooms, Kitchen & food on, 104 menu items.
Sing Sing invite for abhishek@singsing.demo.local: http://localhost:5173/invite/…
Sing Sing invite for andy@singsing.demo.local: http://localhost:5173/invite/…
Sing Sing's PIN staff: Maya S. 4071 (bartender), Diego R. 6358 (front desk). Guest site: http://localhost:3001/v/singsing
```

**Sign in to Sing Sing:**

1. Use a **separate Chrome profile** (or an Incognito window) for Sing Sing, so West 4's sign-in in your main window stays as it is. A browser window is signed in to one venue at a time.
2. Open Sing Sing's invite for `abhishek@singsing.demo.local` and follow 0.2 (any US mobile number, the code from `scripts/demo-codes.sh`, a PIN, a passkey). At sign-in, type `abhishek@singsing.demo.local`. Do the same for Andy in another profile if you need approvals.
3. For Maya at the bar POS, pair a screen in Sing Sing's **Admin → Printers & devices** (as in 0.4) and tap **Maya S.**, PIN `4071`.

**Sing Sing's addresses:**

| What | Address |
| --- | --- |
| Guest website | http://localhost:3001/v/singsing |
| Menu (food and the allergy notice) | http://localhost:3001/v/singsing/menu |
| Book a room | http://localhost:3001/v/singsing/book |
| A room's wall QR | `http://localhost:3001/v/singsing/room/<room id>` (the room id: in the query of 0.12, use the row of Sing Sing's room; `select v.slug, r.name, r.id from rooms r join venues v on v.id = r.venue_id where v.slug = 'singsing' order by r.name`) |

**Check the setup**, as Sing Sing's Abhishek:

1. **Admin → Features**: Kitchen & food is **On**. Bar mode is off.
2. **Admin → Kitchen**: "Allergy notice · In English" and "· In Spanish" are filled with the DEMO ONLY text.
   - Empty one language and press **Save and publish**: refused, "Write the notice in English and Spanish, or leave both empty."
   - The prerequisite check (K-01): in **Admin → Features** press **Off** for Kitchen & food, then empty both languages in Admin → Kitchen and **Save and publish**. Back in Admin → Features, the **On** button for Kitchen & food is greyed and reads "**Kitchen · needs the allergy notice**". Put the notice back in both languages, save, and press **On** again.
3. **Admin → Deposits & cancelling**: deposits are off, and **At a walk-in check-in** reads **Keep the card behind the bar**.
4. **Admin → Menu**: the **Station** column shows (it only appears with the kitchen on): burgers, sides and wings are **Kitchen**, drinks are **Bar**.

**Start a room to order from:** on **Rooms**, press **+ Walk-in** on Room 2, 4 guests, IDs checked, **Seat them**. The dialog then asks for the card behind the bar (2.3, step 6): type `SAM ORTIZ` and `4242` and press **Save the card**. The done line shows the room code. Open the room's wall-QR address in a phone-size window and type that code to join as the guest.

Resetting the night (0.9) without `--sing-sing` leaves Sing Sing as it was; with `--sing-sing`, Sing Sing is made again from scratch (new invite links, your Sing Sing passkeys removed).

### 11.2 Food on the menu

Sing Sing's menu already has food (11.1). To add more, use Sing Sing's **Admin → Menu**: add an item (for example "Test Fries", $8.00) and set its **Station** to **Kitchen**. Add a second one with a required choice (for example a burger with "Cheese · pick one").

In the steps below, "Jess's tab" means any bar tab at Sing Sing (Bar POS → **New tab**), "Room 9" means the room you started in 11.1, and Andy is Sing Sing's Andy.

### 11.3 How a kitchen ticket "prints" in the demo

No real kitchen printer is connected, so **every kitchen ticket fails after about 15 seconds**, unless the desktop app's virtual printer is set to the Kitchen station (19.4). That's expected, and it's itself a test (11.6). To read what the ticket would say:

```
docker compose exec -T postgres psql -U west4 -d west4 -c "select payload from print_jobs where station='kitchen' order by created_at desc limit 1"
```

The ticket starts with "KITCHEN", then the room (or "Bar · Jess P."), the time, who accepted or sent it, then the lines with their options and notes. An allergy note is in capitals, boxed and bold: "ALLERGY: …". There are no prices.

### 11.4 Admin → Kitchen settings

- "Not sent reminder (minutes)": default 5. 0 and 61 are refused.
- "Last order": "Empty: food can be ordered whenever room ordering is open."
- "Print AFTER OUTAGE on replayed food".

### 11.5 Send to kitchen from the bar POS (K-05)

**Who:** Maya, Bar POS.

1. A **Food** chip after the drink sections opens the "Food categories" row. Search "fries" finds French Fries.
2. A required choice reads "{group} · pick one", and the button reads "Pick {group} first" until you pick. An optional one reads "{group} · optional" (for example Make it a meal +$5.00).
3. Add food to Jess's tab. The line reads "**Not sent**". The button reads "**Send to kitchen (1)**" and only works while unsent food exists.
4. Press it. The dialog has "Note for the kitchen (optional)", "This is an allergy" ("Prints boxed and bold on the ticket: ALLERGY: {note}") and Cancel. Send with an allergy note.
5. You should see "Sent to the kitchen · {time}", and the line reads "Sent · {time}".
6. A second send lists only new food. Two screens sending at once give one ticket ("Some of this food was already sent from another screen").
7. Unsent food has **Delete** ("Delete {name} · it never reached the kitchen"), no reason needed. Sent food can only be voided through the fix panel, and has **Reprint**.
8. Quick sale with food asks "Name or label for the ticket" ("A first name, or a label such as Seat 3"). Without one: "Give the guest a name or a label first". The ticket reads "Bar · Seat 3".

### 11.6 Not sent reminder, and closing with unsent food

1. Add food and don't send it. After 5 minutes: "**1 food item not sent to the kitchen**".
2. Close or pay that tab: a warning at once, with **Close anyway** or **Pay anyway**.

### 11.7 Kitchen ticket didn't print, and reprint (K-03)

1. After sending food, wait about 15 seconds.
2. You should see "**{room} · Kitchen ticket didn't print · Reprint**" on the bar POS, Bar orders and the board, and a push to the manager.
3. Press **Reprint**. The panel "Reprint the kitchen ticket" offers **Kitchen printer** and **Print at the bar instead**.
4. **Print at the bar instead** sends it to the bar printer as REPRINT 2 (with the desktop app's virtual printer, a file appears). The toast reads "Reprinted · REPRINT {n}". Nothing is added to the check.

### 11.8 Guest food ordering (K-04)

**Where:** Room 9's guest phone or tablet.

1. A "Food" heading, each food category its own section. The allergy notice is boxed at the top (K-08).
2. In the basket, each food line has "Allergies or notes for the kitchen" and "This is an allergy".
3. A basket with 1 food + 2 drinks becomes two orders, titled "Drinks" and "Food".
4. The guest can cancel the Food card while it rings; nothing is charged.
5. On Bar orders, the food card shows a "Kitchen" chip and "ALLERGY: {note}". A food-only order shows no ID status.
6. Accept the mixed basket: one bar ticket and one kitchen ticket.
7. Same again copies food without its notes.
8. At 4:00 AM drinks are cancelled, food keeps ringing.

### 11.9 Picked up and Delivered (K-06)

1. Bar orders' Being made shows "In the kitchen · ticket printed · {age}" with no Ready button.
2. On Andy's Runs: **Picked up**, then "On its way · Andy", then **Delivered** (charges nothing).
3. Food on bar tabs and quick sales has no run. A remake prints REMAKE and charges nothing.

### 11.10 86, Close the kitchen, last order (K-07)

1. 86 a food option: it greys on the bar POS and the room page.
2. **Close the kitchen** is at the end of the bar POS Food row, and on the manager's phone Today (managers and owner only).
3. While closed, food reads "Kitchen closed" on the bar POS, room page and website menu. Orders already accepted still print.
4. With Last order set (for example 1:30 AM), the chip reads "Kitchen closed · last order 1:30 AM".
5. **Reopen the kitchen** brings it back. Closing the night reopens it too.
6. Turning Kitchen off while a kitchen order is ringing, accepted or ready is refused. Turning off "Bar screen & tickets" lists Kitchen in "These turn off with it: …".

### 11.11 Allergy notice (K-08)

It shows on the room page, the room tablet, the website menu page and the menu PDF, boxed at the top, English then Spanish. After a change, it updates within about a minute (the tablet checks every 30 seconds).

### 11.12 Packages with food (K-09)

1. Make a package with a food item in Admin → Menu (the package editor), or use one from Sing Sing's menu.
2. On Room 9's room screen: **Add a package** → "Choose a package" → "Pick for {name}" → **Add · {price}** → "{name} added · its food reads Not sent until you send it".
3. The drinks print at the bar at once; the food waits for Send to kitchen.
4. Lines group under "On this tab"; the receipt reads "Party pack · Wings" (or your package's name).
5. Packages with food are for room tabs only. An hourly package with food can't be saved.

### 11.13 Meals, combos, sauces, voiding a meal (K-12)

1. "Make it a meal" (+$5.00) makes the side and the soda their own lines.
2. In the kitchen the side prints under the burger ("+ Fries"); the soda prints at the bar ("with Classic Cheese").
3. Sauces read "{n} included · each extra +{price}".
4. Descriptions show on the guest menu. The bar POS grid pages with **More** and **Back**.
5. Void a meal burger in the fix panel: it reads "Comes off with …" and its parts go with it.

### 11.14 Food on reports (K-10)

The X/Z report has a "Food" line. A package's food counts under Packages, not Food. Food is taxed at 8.875%.

---

## 12. Guest website and online booking

**Where:** phone size and desktop, http://localhost:3001/v/west4karaoke.

### 12.1 The website

1. The home page says open until 4 AM, with "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour".
2. The age line reads "21 and over" (see 19.11 for the age policy).
3. The rooms picker for 3 guests on a Friday shows a small room billed for 4.
4. The song section shows a count and no search box until a songbook is uploaded (9.4).
5. **Menu** (http://localhost:3001/v/west4karaoke/menu) and its PDF show the same items as Room 9's page, with the three "86'd tonight".

### 12.2 Light and dark mode

There's no button for it. Switch your Mac's appearance: **System Settings → Appearance → Light / Dark**, and reload. The guest pages follow it. (The staff app is dark only.)

### 12.3 Book a room

1. Open **Book a room** (http://localhost:3001/v/west4karaoke/book). Pick 5 guests, Fri Sep 25, 11:00 PM, 2 hours. Press **Show times**.
2. "**Before you pay**": room time $100.00, tax $8.88, gratuity $20.00 ($128.88), deposit **$50.00**.
3. A 10-minute countdown runs ("{time} left to finish", **More time**).
4. 3 guests on a Friday: "Fri & Sat bill at least 4 · you pay for 4", $40 deposit.
5. "**Your details**": the marketing box ("Also text me news… Reply STOP anytime.") starts unticked. A non-US number is refused: "Check your name, your email and a US mobile number (+1)." Press **Continue**.
6. On the payment page, try **Try a declined test card** first: "Your card was declined · try another card". Then press **Pay $50.00 deposit**.
7. You should see "**Booked · we texted your confirmation and a link to manage your booking.**", with "Free to cancel until …" and $50 paid.
8. The confirmation text ("Booking confirmed", with the `/b/…` manage link) is in Messages. The guest gets **no email**; that's by design.
   - The venue can get an email copy of each online booking: as Abhishek, **Admin → Venue → Booking inbox → Add an address**, type `bookings@west4.local` and press **Save**. Book again: an email "**New booking · {name}, {party} guests, {when}**" ("{name} booked online at West 4 Boho Karaoke.") arrives at http://localhost:8025. Changes, cancellations and party enquiries send a copy too.
9. If the hold runs out: "Your hold ran out, and the room went back on sale." / **Pick a time again**.
10. In a second window, try to hold the same overlapping time: refused while the first hold lives.

### 12.4 Manage a booking

**Where:** the manage link from the confirmation text (`/b/…`) of a booking you made in 12.3, or the demo's own booking, **Jae & co.** (5 guests, 11:00 PM, Room 3, $50 deposit): open the `Jae & co.'s manage link` that the reset script printed (0.8; `node scripts/demo-links.mjs` makes a new one).

1. **Change party size** 5 → 6: "Your deposit becomes $60.00", "Pay the $10.00 difference".
2. 6 → 3 before the cut-off: deposit $40.00 and "$20.00 goes back to your card".
3. **Change time or date** to Saturday keeps the deposit.
4. **Running late?**: "We'll hold your room until 11:15 PM. That's our 15-minute grace." The board shows the booking as late.
5. **Cancel booking → Yes, cancel**. Inside the free-cancel window: auto refund, "Refund pending" then "Refunded · $50.00…". After it (as tonight at 10:41 PM): "Deposit kept per our policy · $50.00".

### 12.5 No-show

Move the clock past 11:15 PM (`2026-09-26T03:20:00Z`). Mark The Nguyens a no-show: West 4 keeps their $60.00 deposit.

### 12.6 Payment links

1. As Andy, **Calendar → Send payment link** for 22 guests in the VIP room on another night: "Payment link texted to {name} · the room is held until {time}".
2. Open the link from Messages and pay $250.00: the booking is confirmed.
3. Refused: 24 guests in the VIP room at 9 PM tonight (Bianca L.), and any past time.
4. An unpaid link lapses. "Card hold" mode ("Save card · nothing is charged now") exists for a test venue only; it can't be seen at West 4.

### 12.7 Private-party enquiry

1. On http://localhost:3001/v/west4karaoke/parties, send a 22-guest enquiry. An email in the mobile field is refused.
2. It lands unread in Messages. A staff reply with a link is refused: "A reply can't carry a link. For a deposit, send the Payment link text."

### 12.8 Online booking off

1. **Admin → Features**: turn off "Online booking & deposits".
2. The website shows **Call to book** with (212) 255-0011. The book page reads "Online booking is off. Call us to book."
3. Jae's manage link still opens, cancels and shows refund status.
4. Turn it back on.

### 12.9 Website editing

**Admin → Website**: change the hero words and **Save and publish**. They're live within a minute. The previous version can be republished. A photo without alt text can't be saved. No PIN sign-in can open it.

---

## 13. Messages, texts and STOP

**Who:** Andy, side menu **Messages**.

1. Sam O.'s "running 15 late" is unread. Open it and press **Reply "no problem"**: "No problem. We'll hold your room until 10:45 PM."
2. Reply with "west4karaoke.com/book": refused. Staff replies can't carry links or promotions.
3. **A guest texts in (STOP, HELP).** There's no real phone in the demo, so a command sends a guest's text to the app the way Twilio would. In a second Terminal window:

   ```
   cd ~/Downloads/west4-karaoke
   node scripts/demo-text.mjs "HELP"
   ```

   It sends the text from Jae & co.'s number (+1 347 555 0165). To send from another number, add it after the text, with no spaces: `node scripts/demo-text.mjs "STOP" +12125550123`. It signs the text with the venue's own Auth Token, as Twilio would (West 4's seed has a pretend Twilio connection; texts the app sends still only show in Messages). Each run ends with "Texted "…" from … to west4karaoke". Then reload **Messages**:
   - **HELP**: the reply reads "**West 4 Boho Karaoke: for help, call +1 212 255 0011. Reply STOP to stop texts.**"
   - **STOP** (also "unsubscribe", "cancel", "quit"…): one reply, "**You're unsubscribed from West 4 Boho Karaoke texts. You won't get any more.**", then nothing more goes to that number (for example no Room code text at check-in).
   - "**please stop texting me**" counts as STOP too: `node scripts/demo-text.mjs "please stop texting me" +12125550124`.
   - An ordinary text (`node scripts/demo-text.mjs "Running 10 min late, sorry" +12125550125`) lands unread in Messages. Under it, staff can press **Mark as an opt-out**, the one-tap opt-out for a guest who asks in other words.
   - At Sing Sing (11.1), add `--venue singsing` before the text: `node scripts/demo-text.mjs --venue singsing "HELP"`.
4. Move the clock to 10:50 PM: Marcus T. gets the Reminder text about 11:00 PM and staying on by the minute.
5. **Admin → Texts** lists all 14 texts. Review ask and Birthday are off and can't be turned on. **Admin → Phone & texts** shows the call number +1 212 255 0011 and, under **Connect your Twilio account**, **Approved** with the same number (the seed's pretend connection).
6. **Connect your Twilio account** (each venue texts from its own Twilio account, [D123](decisions.md)). Signed in as Andy, in **Admin → Phone & texts**:
   - Press **Disconnect**, then **Yes, disconnect**: it reads **Not connected** and "Until your texts are live, sign-in codes and invites go by email."
   - Open **How to set up Twilio**: the six steps a venue follows in Twilio's own console.
   - As the **Account SID** type `AC` and then any 32 of 0–9 and a–f (for example `AC`, then `0123456789abcdef` twice); as the **Auth Token** type 32 zeros. Press **Check**: "Twilio didn't accept those keys · check the Account SID and Auth Token", and what you typed stays.
   - Change the Auth Token to any other 32 of 0–9 and a–f (for example `0123456789abcdef` twice) and press **Check**: a number (+1 212 555 …) and "Test messaging service" appear. Press **Connect**: **Connected · waiting for approval**, the number, "ends …" with the account's last four characters, and the token field is gone.
   - Press **Check again**: **Approved** and "Texts are going out".
   - While it's disconnected, **Admin → Team** refuses an invite with only a mobile number ("Add an email · this venue's texts aren't connected yet"), and an invite link opened on a phone says **Email me a code**. Reset the night (0.9) to get the pretend connection back.

---

## 14. Calendar

**Who:** Andy, side menu **Calendar**.

1. Tonight lists exactly **11 bookings**. Leo M. (a walk-in) is not among them.
2. **New booking** for 22 guests at 11:00 PM tonight in the VIP room: refused (Bianca L. holds it until 12:30 AM).
3. A booking tonight at 9:00 PM: refused, it's past.
4. Sat Sep 26, 9:30 PM, 6 guests, 2 hours: gets a room from Rooms 1–5 (never Room 4), $60.00 deposit, pending.
5. Open Saturday and press **Block this date**: it lists that day's bookings ("{date} is blocked"), and offers **Cancel and refund all**.

---

## 15. Staff, PINs, badges, the time clock, breaks, tips and the tip pool

### 15.1 Invites and PINs

1. **Admin → Team** (Abhishek only; Andy's Admin has no Team, Payments or Console). It lists Abhishek G. (owner), Andy C. (manager), Maya S. (bartender) and Diego R. (front desk).
2. Invite a new person; the invite email arrives at http://localhost:8025. The PIN step refuses 1234, 1111, 0000 and 2580; managers need 6 digits. The end screen says "You're set · sign in with your badge or name and PIN".
3. A PIN reset sends Maya a new link and her old PIN stops working.
4. A role change asks for the passkey again.
5. **Deactivate** Diego: he's signed out everywhere at once; his PIN is refused; his history still names him.

### 15.2 PIN lockouts

On a paired screen:

1. 5 wrong PINs for Maya: "Locked · try again in {seconds} s" for 1 minute. She can still sign in on another paired screen. The next 5 lock her for 5 minutes, then 15.
2. 10 wrong tries in a row across Maya and Diego: "PIN sign-in is paused on this screen · a manager pairs it again", and Andy's phone gets an alert. Only pairing it again fixes it.
3. Owner/manager: idle 30 minutes → "Locked after 30 minutes away · sign in again". Signing in with the authenticator app instead of a passkey gives "Admin needs a passkey".

### 15.3 Time clock and breaks

**Where:** the phone tab **Clock in and out**.

1. Maya "On since 4:00 PM (6h 41m)", Andy 6:00 PM, Diego 7:00 PM, Abhishek "Not on shift".
2. Clock in needs a duty: "Pick your duty to clock in" (Bar, Front desk, Runner, Manager). Manager is offered only to Andy and Abhishek. A second clock-in is refused.
3. Maya presses **Start break**: every bar screen reads "Maya · on break". **End break** clears it.
4. **Clock out** for Maya lists her 3 open tabs (Hana K., Jess P., Luis M.); it won't finish until each is handed to someone still on. Cash in her bank must be dropped first. **Declare** cash tips ($0.00 or $15.00).
5. Andy (passkey, not PIN) moves Diego's clock-in from 7:00 to 6:55 PM with a reason. No reason, or from a PIN session: refused.

### 15.4 Badges

Need a real NFC reader and badges. Skip on a laptop. In Admin → Team, **Pair (tap the reader)** pairs a badge.

### 15.5 Tips to enter (paper slips)

**Where:** phone tab **Tips to enter**.

1. Lists Dev S. (Visa ··3318), Tom W. (MC ··0457), Ana R. (Amex ··2204), each with a photo.
2. Ana: a $12 tip on $62.50 = $74.50, no approval.
3. A $20 tip on Ana (over 25%) goes to Andy. A tip Andy enters himself goes to Abhishek.

### 15.6 Tip pool and My tips (after closing the night, section 17)

1. Close the night reads "Not in the pool: Andy C., manager." Making Andy eligible in Admin → Team is refused.
2. Maya's **My tips** lists her Bar shift, hours and "Your share of the pool". "Gratuity" is a separate line from "Card tips" and "Cash tips".
3. Andy's page reads "Managers don't share in the tip pool. Your shifts are below."
4. Late slips show "for Fri Sep 25 · posted Sat Sep 26". Diego can't see Maya's records.

### 15.7 Training mode

See 0.10. Also check: tickets and receipts print TRAINING; a practice receipt can't be texted or emailed; a practice cash sale never opens the drawer; a practice comp doesn't change Maya's "$63 left this shift"; the board counts don't change.

---

## 16. Cash drawers

**Who:** Andy and Diego. Drawer panel on **Close the night**, or the cash panel.

1. Two drawers, the bar drawer and the front-desk drawer, each $300.00, answered for by Andy.
2. **Count the drawer**: "Count first. What the drawer should hold shows after you enter the count." The expected amount and difference show only after you enter yours (blind count).
3. Diego can count only the front-desk drawer; Andy either one. A count $25 short needs a note.
4. **Drop my cash · {amount}**: cash Diego took on his phone goes into the front-desk drawer ("Logged to Diego · front-desk drawer"); his bank reads $0.00.
5. **Paid-out** $42.00 with a photo, by Andy: goes to Abhishek's Approvals. The drawer opens only after approval.
6. **No sale** asks for the PIN again.
7. **Hand over the drawers**: "…The next manager accepts on their own phone." Accept it in Abhishek's window.
8. **Admin → Cash drawers**: switch to a drawer per person. It reads "Starts Sat Sep 26". To test trays, move the clock past 6:00 AM Saturday: "Bar · Maya S. · tray pulled"; the night won't close while a pulled tray is uncounted.

Real drawer kicks need the real drawer hardware.

---

## 17. Close the night, X and Z reports, unmatched payments, break-glass card

**Who:** Andy. Do this last, then reset.

1. Before the close, the phone Reports tab and Close the night offer **Print X report (running)**.
2. Move the clock to Sat 4:12 AM (`2026-09-26T08:12:00Z`) and reload. Open **Close the night**.
3. "**Before closing**" lists nine checks, each linking to its fix:
   - Staff still on the clock · N
   - Open waitlist entries
   - Ringing or asked-to-wait orders
   - Pending approvals · 1 (Diego's void)
   - Rooms still cleaning
   - Unsent drinks
   - The clear-out check (4:30 AM)
   - "**3 slips not entered · tips post to Sat Sep 26**" (doesn't block)
   - Both drawers counted
4. Press **Close the night** now: refused, naming each failing check.
5. **Charge the remaining tabs**: 4 cards, $152.43 in all. Tariq is skipped while his void waits.
6. Fix each check. At 4:30 AM do the clear-out check: "Clear-out check · Andy · 4:31 AM".
7. Move to 4:48 AM and close: "**Night closed · 4:48 AM**". The button changes to **Print Z report**. Printing a Z before the close is refused.
8. After the close, the 86'd items (Hoegaarden, Casamigos) are back.
9. A tab that couldn't be charged stays under "Couldn't be charged" with "Still owes…", and doesn't block the close.
10. Move to 5:10 AM and enter a slip tip: it needs approval and posts to Sat Sep 26. Fri's Z never changes.

**The Z report:** drinks split into Room checks and Bar tabs; gratuity from room checks only. Compare the figures on screen; the exact totals are checked by the automated money tests.

**Unmatched payments:** the panel "Unmatched payments · {count}". Empty, it reads "Every Stripe payment is on a check". The demo has none, so the Match flow ("The check it belongs to", **Match**, "That's more than the check still owes ({due}).") can't be tried without a developer creating one.

**Review after outage:** on Close the night. Empty: "Nothing was taken offline tonight." See section 20.

**Break-glass card:** **Print break-glass card** saves `break-glass-card.pdf`. It names "Ready for Tap to Pay: Andy, Abhishek" and says "Take cash. Write down the room or tab, the amount and the time."

---

## 18. Reports and exports

**Who:** Abhishek (some need the passkey again).

1. Side menu **Reports**: "This week · …", "Trends · 8 weeks", "Reviews from the morning text · Off".
2. "Comps, voids and refunds tonight" lists Maya's $12.00 COMP on Luis M.'s tab and Diego's $70.00 VOID on Tariq A.'s tab, with "approved by {name}".
3. Payouts: refused for Andy, works for Abhishek.
4. **Exports**: "Books for QuickBooks" and "Email CSV" ("Each asks for your passkey again."). Refused from a PIN session. Emailed copies land at http://localhost:8025.
5. **Admin → Connections → Export for QuickBooks → Download**. (Importing into a QuickBooks test company is a separate, outside check.)
6. **Export payroll** with From/To dates. Gratuity goes in wages, tips in the tips columns. After export, Friday's pool is locked. The email copy is titled "… · payroll for {date}".
7. **Sales tax**: "Sales tax · {from} to {to}", "Tax this quarter so far", **Download the quarter**. 8.875% on room time, drinks and damage fees.
8. With Reports & accounting off (Admin → Features), Close the night still prints the Z.

---

## 19. Admin, section by section

**Who:** Abhishek, side menu **Admin**. Every section saves with **Save and publish** → "Published". No PIN sign-in can open Admin settings that change money.

### 19.1 Team
People, roles, invites, badges, languages, training mode. See 15.1.

### 19.2 Features
"What's on, and what each module hides". 13 on, 3 off (Song system control, Marketing texts, Kitchen & food "Not in your plan").
- Turn off "Bar screen & tickets": "Room orders would have nowhere to ring. Turn off Ordering from the room too?". Answer no: nothing changes.
- Turning off Rooms & room clock lists what goes with it ("These turn off with it: …").
- Turning on Bar tabs & quick sale is refused while the merchant category is unchecked (go-live checklist).
- Turn off Walk-in waitlist: the phone Waitlist tab disappears. Turn it back on.

### 19.3 Hours & prices
- Mon–Fri 4:00 PM–4:00 AM, Sat–Sun 2:00 PM–4:00 AM.
- Set last call to 4:30 AM: refused, naming 4:00 AM. 3:00 AM saves.
- Add a special date (e.g. Thu Dec 24 closing 11:00 PM).
- Prices: $10 a person an hour; at least 3 guests on weeknights and 4 on Fri/Sat; first-hour minimum; VIP $250 an hour from 20 guests; damage fee $150.
- A $6.00 happy-hour Margarita is refused; $6.50 saves (Menu).

### 19.4 Printers & devices
Bar and front-desk computers, 2 NFC readers, 2 receipt printers, Bar S710, Front desk S710, 14 room tablets (13 online), the Up next TV. Pairing codes and **Revoke** (0.4). The **Router** block: "Backup internet · on", "How we read it", "Monthly failover test".

**Printers (W-02 to W-04).** Under **Printers**, each printer says how it's reached: "Cabled to Bar computer", "Cloud printer" or "Network printer · 192.168.1.50:9100".
- With the desktop app open and its virtual printer (0.11), the printer shows "Cabled to Bar computer" with a **Station** (Bar, Front desk, Kitchen) and a **Command set** (ESC/POS, or Star raster for a Star TSP100III). Set the station to **Kitchen**: with Kitchen & food on, the next food order's kitchen ticket lands in `.demo-logs/printer` instead of failing (11.3). Set it back to Bar.
- **Add a printer** → How it connects: **Network printer (on this venue's network)** asks for the **IP address** and **Port** (9100) and says "Prints while a bar computer with the app is open." An address outside the venue's network (such as 8.8.8.8) is refused. Its **Printed by** is "Any bar computer" or one computer.
- A network printer can't really print in the demo (nothing listens at its address): its test ticket fails after about 15 seconds and shows on the bar orders screen as didn't print. That's expected; the real check is on the venue's network (hardware-install.md).

### 19.5 Cash drawers
See section 16.

### 19.6 Rooms
14 rooms, Room 4 out of service. Archiving a room hides it from the board.

### 19.7 Menu
127 items in 9 sections. Renaming the button to "Marg" still prints "Margarita". Hiding an item removes it from the guest pages within a minute. With the kitchen on: Station column and package editor (section 11).

### 19.8 Phone & texts, and Texts
+1 212 255 0011. All 14 texts. The **Erase a guest** panel is here: **Erase** → "Erase {name}'s details for good?" → **Erase for good** → "Erased. Saved cards and texts are removed in the next few minutes." A guest with a future booking gets a warning; a singer who still owes money is refused.

### 19.9 Alerts & rules
A 15-minute room-ending warning turns tiles amber. There's no alarm toggle.

### 19.10 Safety
- Occupancy limit: empty, "Limit not set". Never invent one; don't save a made-up number unless you clear it afterwards.
- **Age policy**: "21 and over" (West 4's default), or "All ages until a time, then 21 and over". Pick the second with 8:00 PM:
  - The website reads "All ages until 8:00 PM, then 21 and over with a physical ID".
  - A booking that runs past 8 PM reads "21+ after 8:00 PM · bring ID".
  - The board shows "21+ from 8:00 PM · check IDs at the door and in the rooms" for half an hour around the switch (needs the clock near 8 PM, so only on a future night).
  - Without a time it stays 21 and over ("Pick the time. Until you do, it stays 21 and over.").
  - Set it back to 21 and over.

### 19.11 Help alert and incidents (Safety)
1. On a guest's own phone in Room 9, tap **Need a manager, privately?**.
2. Andy's and Abhishek's windows (with alerts on) get "Manager needed · Room 9 · {time} · …". Maya and Diego get nothing.
3. The board shows "Manager needed · 1" with no room.
4. The phone **Incidents** tab: **I'm on it**, **Add to the log**, **Close**. Bartender and front-desk sessions can't read incidents.

### 19.12 Licenses
**Add a license** with number, holder, expiry, fee, conditions and a PDF. A 25 MB or Word file is refused. Use test values only. Reminders (30 and 7 days before) need a clock jump.

### 19.13 Connections
Stripe, texts, email and Google. Google reads not connected (pushing hours to Google is blocked). Export for QuickBooks and Export payroll are here.

### 19.14 Payments (owner only)
The Stripe account, payouts and **Our plan**: "{count} rooms counted…", **Pay the invoice**. The failed-payment banners can't be forced without a developer.

### 19.15 Card fee & gratuity
"No card fee: every card pays the price shown" (West 4). Modes "Credit card surcharge" / "Cash discount". 20% room gratuity, tips 18/20/22%, tip review at 25% / $50 / 2 h, Pay my share on. A card-fee change asks for the passkey again.

### 19.16 Disputes
Maya and Diego can't open it. Nothing to dispute in the demo.

### 19.17 Bar POS
Opening hold (set $60: new tabs read "We'll hold $60 on this card…"), per-shift limit (0 sends every comp and void for approval), drink tickets (8.9).

### 19.18 Bar mode
See 9.4.

### 19.19 Kitchen
Only after 11.1. See 11.4.

### 19.20 Deposits & cancelling
First-hour deposit, 24 h, keep on late cancel, keep on no-show, 15-minute grace, $250 from 20 guests. Saving makes a new policy version shown on the booking page; older bookings keep theirs. **At a walk-in check-in** reads **Take a deposit** (West 4); the other choices are **Put a card on the tab**, **Keep the card behind the bar** (Sing Sing's, 11.1) and **Nothing** (see 2.3). It still shows with Online booking off.

### 19.21 Website
See 12.9.

### 19.22 Console (owner only): support access
See 21.2. Andy's Admin has no Console section.

---

## 20. Offline and outages

### 20.1 The pink offline banner (any browser)

1. Open the staff app. Open developer tools (Cmd + Option + I) → **Network** → change "No throttling" to **Offline**.
2. You should see "**Offline · read-only · orders queue with an offline code**", and the footer keeps the last sync time.
3. Switch back to No throttling: the banner goes.
4. The words "works offline" must appear nowhere.

### 20.2 Read-only offline view (desktop app needed)

1. Run the desktop app (0.11), paired as the bar computer, signed in as Maya.
2. Open its developer tools and set Network to **Offline**.
3. It still shows the rooms (8/3/2/1), the 5 tabs (Jess P. $32.66, Luis M. $63.15) and the menu with Hoegaarden 86'd. Every control reads "**Offline · read-only: this needs the connection**". Ringing orders keep aging and chiming.

### 20.3 Queue mode with offline codes (desktop app needed)

1. **Before going offline**, Andy opens the phone tab **Offline codes**: "{name} · code now", "Changes at {time}", **Print tonight's one-time codes**.
2. Take the desktop app offline (20.2). Enter the **Offline code** and press **Open queue mode**.
3. The banner reads "Queue mode · until {time} · rounds are queued, not charged".
4. Maya: **Queue a round on Luis M.** → **Pick your name** → **Queue round**. It reads "queued · not charged" with her name.
5. Wrong, expired or other-device codes are refused; "That printed code was already used."
6. Void, refund, no-sale and New tab are locked, each with a reason.
7. Quit and reopen the app: no queued order is lost. Queue mode ends by itself after 4 hours.

### 20.4 Replay and Review after outage (desktop app needed)

1. Go back online. The banner reads "**Confirm replayed orders (3)**" (or however many you queued). Each is held as "Replayed · asked to wait" until accepted.
2. A round rung on a phone and in the queue is charged once: accept one copy, cancel the other.
3. **Close the night → Review after outage** lists anything that failed.

### 20.5 What can't be simulated here

- The amber "**On backup internet · card readers may take up to 2 min to switch**" banner needs the real router.
- "Stripe is having trouble · card payments may fail" and "Texts are delayed" come from a background health check; there's no switch, so they need a developer.
- The four outage drills (M8-07) run on site.

---

## 21. The Console (our own staff)

The Console is for Noraymi staff, not the venue. It isn't started by the demo script.

### 21.1 Start it and sign in

1. In a new Terminal window:

   ```
   cd ~/Downloads/west4-karaoke
   pnpm --filter @west4/console dev
   ```

2. Open http://localhost:5174. It reads "Our staff only. Single sign-on, then your FIDO2 security key."
3. **Work email**: `support@demo.west4.local` (local stand-in for single sign-on). Press **Continue**.
4. "Step 2 of 2: touch your security key." Touch ID and phone passkeys are **refused**; it needs a USB security key. If you don't have one, use Chrome's pretend key:
   - Developer tools → the ⋮ menu → **More tools → WebAuthn**.
   - Tick **Enable virtual authenticator environment**.
   - Add an authenticator with protocol **ctap2**, transport **usb**, and tick **Supports user verification** (resident key can stay unticked).
   - Press **Use your security key**.
5. The first sign-in enrols the key; later ones check it.

You should land on **Venues**, with "Noraymi support · support@demo.west4.local". These are the steps the automated Console test takes (`e2e/console.spec.ts`). If sign-in fails at step 4, note the message ("The security key prompt was closed", "The security key didn't work" or "This browser can't use security keys").

### 21.2 What to check

- **Venues**: West 4 with 13 of 14 tablets online, both readers, "Backup internet · on".
- **Modules**: per venue, each module's "allowed" switch (this is where Kitchen & food is allowed for real, 11.1).
- **Rule packs**: publishing needs two approvers.
- **Pages**: paging settings.
- **Support access**: our staff ask for access ("Read only" or "Read only, plus once: {action}"). In the staff app, Abhishek's **Admin → Console** shows the request with "From {name}", "Reason", **Approve** and **Decline**. While open: "Support access is open · {name} · {minutes} min left", **End now**. During a grant, phone numbers are masked, ID scans hidden and writes fail. It ends by itself at 60 minutes.
- **Emergency actions**: **Ask for an emergency action** → "Requeue a print" with "Reason for this fix" → "Waiting for a second approver". A **different** Console account must approve; nobody approves their own. The demo has only one Console account, so the second approver needs a developer to add another.

---

## 22. The status page

Open http://localhost:3001/status.

1. "Service status" with Ordering, Payments, Printing and Texts, each "Working", "Having trouble", "Down" or "Maintenance", and "Checked {time}".
2. Stop the demo (Ctrl+C in the start window) and wait 30 seconds: the page says it can't reach us, with **Check again**, instead of a stale "Working". Restart the demo afterwards (this resets the night).

---

## 23. Spanish review

1. Press **Español** in the side menu (or set Diego's language to Español in Admin → Team and sign him in).
2. Walk every staff screen in sections 1 to 19, at desktop and phone size.
3. Check: nothing still in English, no cut-off text, no "{placeholder}" showing, and the fixed sentences read the same everywhere (for example "Ask the room to wait" and "Charge the remaining tabs").
4. The guest pages and texts have their own Spanish where the spec says so.
5. Write anything odd down; the formal sign-off sheet is `docs/gate/spanish-review.md`.

---

## 24. Accessibility quick checks

1. **Keyboard only** on the guest pages (waitlist, book, room page, bill, pay): press Tab to move, Enter to press. You can reach every button, and you can see where you are.
2. **Mac VoiceOver** (Cmd + F5) on the guest pages: buttons and fields are read with sensible names. Cmd + F5 again turns it off.
3. **Zoom** to 200% (Cmd + plus): nothing overlaps or disappears.
4. **Touch targets** on staff screens are big enough to tap with a thumb (at least 44 px; PIN keys are larger).
5. **Light and dark** guest pages are both readable (12.2).

The full screen-reader pass needs a real iPhone and Android phone (blocked, M5-16).

---

## 25. CAPTCHA and daily limits

Every public form (the waitlist page, texted codes, online booking and party enquiries) has a security check, Cloudflare Turnstile (D109), that the server confirms, and a daily limit per phone number, device and network. In the demo the check uses Cloudflare's **test keys**, which always pass, so you never solve a puzzle. Your Mac must be online: the check's script comes from Cloudflare. Resetting the night (0.9) clears the day's counts.

### 25.1 The security check on the waitlist page

**Where:** http://localhost:3001/v/west4karaoke/waitlist, phone size.

1. The form has a "Security check" box with Cloudflare's widget, reading "**Testing only, always pass**" (Cloudflare draws those words for its test key). While it loads: "Checking you're a person. This takes a moment."
2. Join with a name, a party size and a US mobile number: it works as in 2.5.
3. Offline (turn Wi-Fi off, then reload): "The security check didn't load. Check your connection and refresh the page." Turn Wi-Fi back on.

The same widget shows on **Book a room** (around the hold buttons) and on the **Private parties** enquiry form.

### 25.2 The daily limit per phone

The defaults are in Admin → Spam protection (25.3). On the waitlist, one phone number can join **3 times a day**.

1. On the waitlist page, join with `+1 212 555 0199`.
2. Press **Leave the waitlist** ("You've left the waitlist."). A number that is still waiting can't join again ("That number is already on the waitlist."), and that refusal doesn't count, so leave between joins.
3. Join and leave again, twice more (3 joins in all).
4. Join a 4th time with the same number: refused, "**You've reached today's limit for joining the waitlist from this phone or network. Ask the host at the door to add you.**"
5. Another number still works. (The same browser also stops at 5 joins a day, the per-device limit.)

The other forms' refusals:

- **Online booking:** "You've reached today's limit for online bookings from this phone or network. Call us to book."
- **Party enquiries:** "You've reached today's limit for party enquiries from this phone or network. Call us instead."
- **Texted codes** (singers): "You've reached today's limit for codes from this number or phone. Ask the bartender to add you to the queue."

### 25.3 Admin → Spam protection

**Who:** Abhishek or Andy, **Admin → Spam protection** ("Daily limits on the waitlist, texted codes, booking and enquiries"). PIN staff can't open it.

1. It lists four forms, each with "Per phone number", "Per device" and "Per network (IP address)", shown as "{n} a day":

   | Form | Per phone | Per device | Per network |
   | --- | --- | --- | --- |
   | Waitlist page (door QR) | 3 | 5 | 50 |
   | Texted codes (staff invites, singers) | 5 | 10 | 30 |
   | Online booking (a hold; the phone at Your details) | 5 | 10 | 20 |
   | Party enquiries | 3 | 5 | 10 |

2. Set the waitlist's **Per phone number** to `1` and press **Save and publish**. Join the waitlist with a new number, leave, and join again: the second join is refused with the limit message.
3. Only whole numbers from 1 to 1000 are accepted. Set it back to 3.

---

## 26. What you can't test locally

- **Real card readers** (Stripe S710), Tap to Pay on a phone, and real Stripe accounts (live drill M4-30; sandbox run M5-17).
- **Real printers**: the bar USB printer, network printers, and the kitchen printer.
- **Cash drawer kicks**, **NFC badge readers and badges**.
- **The router and LTE backup** (amber banner, failover test), and cellular signal at each pay point.
- **Real texts and emails** to real phones, the 10DLC text campaign (M8-22).
- **Google Business Profile** hours (M5-15).
- **Apple Pay / Google Pay** on the payment page.
- **Our plan billing** on Stripe Billing, and its failed-payment banners (M8-15).
- **Production watching, paging and the status page in real use** (M8-16, M8-17).
- **Restores, load tests, the security baseline** (M8-19 to M8-21), the mic power trial (M8-23).
- **The two-week staging reconciliation** (M7-19, M7-20) and the outage drills (M8-07).
- **Everything in M9** (imports of West 4's files, hardware install, domain move, training, the timed staff trial, sign-offs, live nights) and **all of S** (Sing Sing go-live).
- **Screen-reader passes** on a real iPhone and Android phone.
- **The Console's second approver**, without a second Console account.

---

## 27. Printable checklist

Tick each when it reads as this guide says. Note the section number of anything that doesn't.

**Setup**
- [ ] 0.1 Demo starts, Ready, health is ok
- [ ] 0.2 Owner signs in with passkey
- [ ] 0.3 Andy signs in, alerts on
- [ ] 0.4 Paired screen, Maya and Diego by PIN
- [ ] 0.5 Phone size works
- [ ] 0.7 Clock jump works
- [ ] 0.11 Desktop app opens, virtual printer writes a ticket

**Floor**
- [ ] 1.1 Counts 8/3/2/1, 93 inside, Limit not set
- [ ] 1.2 All 14 tiles and amounts
- [ ] 1.3 Alerts in order, Show all
- [ ] 1.4 Timeline
- [ ] 1.5 Room 9 panel: $322.00 / $158.00 / $480.00
- [ ] 2.1 Sam O. check-in, −$40.00
- [ ] 2.2 No-show only from 10:45
- [ ] 2.3 Walk-in
- [ ] 2.4 Waitlist offer and seat
- [ ] 2.5 Door QR page: 3 parties ahead, Room 2 is ready
- [ ] 3.1 Party size and rate
- [ ] 3.2 Move Room 7 to Room 11
- [ ] 3.3 Fault, comp $10.00, clock pause approval
- [ ] 3.4 Damage fee $150.00, tab $630.00
- [ ] 3.5 Mark clean, notes
- [ ] 3.6 Lost and found
- [ ] 3.7 Calls, On it

**Orders and bar**
- [ ] 4.1 Join Room 9 (host link and KX4M7)
- [ ] 4.3 Guest order and its statuses
- [ ] 4.4 Host lock, Same again
- [ ] 4.5 Room tablet
- [ ] 5.2 Accept: $158.00 → $184.00, $480.00 → $506.00
- [ ] 5.3 Ask the room to wait
- [ ] 5.4 Decline
- [ ] 5.5 Aging
- [ ] 5.7 Ticket didn't print, REPRINT 2
- [ ] 5.8 Runs, Delivered never charges
- [ ] 6.1 Comp: $63 → $50 left
- [ ] 6.2 Void approval: Tariq $86.01 → $9.80
- [ ] 7.1 86
- [ ] 7.2 Cut-off
- [ ] 7.3 ID chips
- [ ] 7.4 4 AM stop and clear-out
- [ ] 8.1–8.8 Bar POS, rounds, quick sale, tabs, split, move, gift
- [ ] 8.9 Drink tickets setting
- [ ] 9.1–9.4 Song queue, singer page, TV, songbook

**Money**
- [ ] 10.1 Room 9 $618.60 / $498.60
- [ ] 10.2 Present blocked while ringing, then #1042
- [ ] 10.3 Reader (training mode)
- [ ] 10.4 Cash change $1.40, $8.45, $48.45
- [ ] 10.5 Split $166.20
- [ ] 10.6 Pay my share $41.55
- [ ] 10.7 Card on file
- [ ] 10.8 Receipts match
- [ ] 10.9 Refund approval

**Kitchen**
- [ ] 11.1 Kitchen turned on (prerequisites shown first)
- [ ] 11.2 Food on the menu
- [ ] 11.5 Send to kitchen, Not sent / Sent
- [ ] 11.6 Reminder, Close anyway
- [ ] 11.7 Kitchen ticket didn't print, reprint at the bar
- [ ] 11.8 Guest food ordering with allergy
- [ ] 11.9 Picked up, Delivered
- [ ] 11.10 Close the kitchen, last order
- [ ] 11.11 Allergy notice everywhere
- [ ] 11.12 Packages with food
- [ ] 11.13 Meals, combos, sauces, void a meal
- [ ] 11.14 Food on reports

**Guests**
- [ ] 12.1 Website
- [ ] 12.2 Light and dark
- [ ] 12.3 Book and pay deposit (decline first)
- [ ] 12.4 Manage: size, time, running late, cancel
- [ ] 12.5 No-show keeps deposit
- [ ] 12.6 Payment link
- [ ] 12.7 Enquiry
- [ ] 12.8 Booking off → Call to book
- [ ] 12.9 Website editing
- [ ] 13 Messages, no links, STOP, reminder
- [ ] 14 Calendar: 11 bookings, refusals, Block this date

**Team and books**
- [ ] 15.1 Invites, PIN rules, deactivate
- [ ] 15.2 Lockouts
- [ ] 15.3 Time clock, breaks, clock-out checklist
- [ ] 15.5 Tips to enter
- [ ] 15.6 Tip pool, My tips
- [ ] 15.7 Training mode
- [ ] 16 Drawers: blind count, drop, paid-out, handover
- [ ] 17 Close the night: checks, close, Z report, break-glass card
- [ ] 18 Reports and exports

**Admin and operations**
- [ ] 19.1–19.22 Every Admin section opens and saves
- [ ] 19.10 Age policy
- [ ] 19.11 Help alert and incidents
- [ ] 20.1 Offline banner
- [ ] 20.2 Read-only desktop view
- [ ] 20.3 Queue mode with an offline code
- [ ] 20.4 Replay, Review after outage
- [ ] 21 Console sign-in, support access
- [ ] 22 Status page
- [ ] 23 Spanish
- [ ] 24 Accessibility
- [ ] 25 CAPTCHA and limits (when built)
