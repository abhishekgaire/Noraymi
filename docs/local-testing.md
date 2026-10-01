# Testing West 4 on your own computer

This guide walks you through running the whole app on your Mac and trying every screen that exists so far (milestones M1 and M2). You don't need to know how to program. Each step says what to type, what it does, and what you should see.

## The idea in one paragraph

The app is several programs that talk to each other. The **database** keeps everything (rooms, bookings, people). The **API** is the brain: every screen asks it for data and sends it changes. The **staff app** is what staff see in a browser. The **guest site** is what guests see on their phones. A **worker** sends emails and texts in the background. On your Mac, none of this reaches the internet: texts and emails are caught locally so you can read them, and no real money moves.

Everything runs on a pretend Friday night: **Fri Sep 25, 2026, 10:41 PM**, the "demo seed". The app's clock starts at 10:41 PM and ticks forward like a real clock, but the date never comes from your computer's calendar.

## 1. Before the first time (once)

1. **Open Docker Desktop** (the whale icon in Applications) and wait until it says it's running. Docker runs the database, the file store and the local email inbox.
2. **Open Terminal** (Applications → Utilities → Terminal).
3. Go to the project folder and get everything ready:

   ```
   cd ~/Downloads/west4-karaoke
   nvm use
   corepack enable
   pnpm install
   ```

   - `cd` moves Terminal into the project folder.
   - `nvm use` picks the right version of Node.js, the engine the app runs on.
   - `corepack enable` turns on pnpm, the tool that installs the app's building blocks.
   - `pnpm install` downloads those building blocks. It takes a minute the first time.

## 2. Start everything (every time)

In Terminal, in the project folder:

```
scripts/demo-start.sh
```

This one command:

- starts the database, file store and email inbox in Docker;
- starts the API, the worker, the staff app and the guest site, using safe demo settings (your `.env` file isn't read, so no real Twilio or Stripe keys are used);
- loads a fresh demo night and sets the clock to 10:41 PM;
- prints two **invite links**, one for Abhishek (owner) and one for Andy (manager).

When you see **Ready**, leave this Terminal window open; the app runs as long as it's open. To stop everything, click that window and press **Ctrl+C**.

If it says a port is "already in use", something is still running from before. Close the other Terminal window that runs it, or restart your Mac, and try again.

**The addresses you'll use (open them in Chrome):**

| What | Address |
| --- | --- |
| Staff app | http://localhost:5173 |
| Guest waitlist page (the "door QR") | http://localhost:3001/v/west4karaoke/waitlist |
| Local email inbox | http://localhost:8025 |

## 3. Sign in as the owner (Abhishek)

Owners and managers sign in with a **passkey**: Touch ID on your Mac, no password. The demo people come with placeholder passkeys, so the start script removes them and gives you an invite link to make your own.

1. Copy the line `Invite for abhishek@demo.west4.local: http://localhost:5173/invite/…` from Terminal and open it in Chrome.
2. It says "Join West 4 Boho Karaoke · you're joining as Owner". Type **any US mobile number**, for example `+1 212 555 0123`, and press **Text me a code**.
3. The text never goes to a real phone. To see the code, open a **second** Terminal window and type:

   ```
   cd ~/Downloads/west4-karaoke
   scripts/demo-codes.sh
   ```

   It lists the newest codes the app "sent". Use the one marked `text to +12125550123`.
4. Type the code and press **Confirm**.
5. Choose a 6-digit PIN (common ones like 123456 are refused) and press **Set my PIN**.
6. Press **Add a passkey** and touch the Touch ID key when Chrome asks.
7. Press **Go to sign-in**, type `abhishek@demo.west4.local`, press **Continue with a passkey**, and touch Touch ID again. You land on **Tonight**.

Do the same with Andy's link (`andy@demo.west4.local`) in another Chrome profile or an Incognito window to be the manager at the same time.

Every time you run `scripts/demo-start.sh` (or `scripts/demo-local.sh`, see section 7), the night resets and you make a fresh passkey through a new link.

### The other staff (they use PINs, not passkeys)

| Person | Role | Demo PIN |
| --- | --- | --- |
| Abhishek G. | Owner | 915204 |
| Andy C. | Manager | 730915 |
| Maya S. | Bartender | 4071 |
| Diego R. | Front desk | 6358 |

Staff sign in with their name and PIN on a **paired** shared computer (the bar or front-desk computer). To make a browser window act as the front-desk computer:

1. As Abhishek, open **Admin → Printers & devices** and make a pairing code for a front-desk computer.
2. In an Incognito window, open http://localhost:5173/sign-in, press **Pair this screen**, and type the code.
3. The screen now shows staff tiles. Tap **Diego R.** and type `6358`.

## 4. See it as a phone

Most screens change shape on a phone. In Chrome, press **Cmd + Option + I** to open the developer tools, then **Cmd + Shift + M** for the device toolbar, and pick an iPhone size at the top. The bottom of the screen becomes the phone's tabs: Tonight, Rooms, Calls, Waitlist, Messages, Approvals, Alerts and Admin (which tabs you see depends on who's signed in).

## 5. A tour: what to try, screen by screen

Everything below starts from a fresh night at 10:41 PM.

### Tonight (the board)

The board is the heart of the staff app.

- **Alerts band** at the top, most urgent first: pink "Room 7 is 11 min past its time, and The Parks (8) are booked into Room 7 at 11:00", pink "Room 9 called for another mic", amber Room 3, lime "Room 11 is free all night, and Amara B. (7) has waited 26 min", and grey alerts for rooms that need a wipe and for Sam O. running late.
- **Headcount**: "93 inside · 77 in rooms · 16 waiting", and "Limit not set · Admin → Safety" (the app never invents a limit). Press **+** and **−** on the door counter.
- **Room tiles**, one per room, in the glossary's words: "In room · 19 min left", "Staying · 41 min past", "Needed now · 11 min past", "Needs a wipe · left 10:33 PM (8 min)", "Open · free all night", "Out of service". Room 9 shows "Room time so far $322.00" and "Tab so far $480.00".

Things to try:

1. **Move a room.** On Room 7's pink alert press **Move a room…**. Only Room 11 is offered ("free all night"); the others are greyed with a reason. Pick Room 11 and you'll see "Moved to Room 11 · new code …". Room 7 now needs a wipe.
2. **Offer a room to the waitlist.** Press **Offer Room 11 · 10 min to claim**. The waitlist drawer opens with a countdown, "Room 11 · 9:58 to claim". Press **Seat**, type 7 IDs checked, and check them in.
3. **Check in Sam O.** In "Arriving", Sam O. reads "10:30 PM · Room 2". Press **Check in**: "3 guests · Fridays bill at least 4" and "Deposit applied −$40.00".
4. **A party grows.** On Room 9, press **+**: "13 guests" and "$130.00 an hour".
5. **Report a fault.** On Room 5, press **Report a fault**, type "Mic 2 cuts out", tick **Comp 15 min of room time** and log it: "Comp of $10.00 added".
6. **Damage fee.** On Room 9, press **Damage fee**, add any photo and a reason: a $150.00 line with the photo's thumbnail.
7. **Mark clean.** On Room 6 ("Needs a wipe"), press **Mark clean**.
8. **Room details.** On any room in use, press **Tab & close out →** for the room screen: the clock and rate ("161 min · $2.00 a minute"), the running tab, the deposit, notes and calls.
9. **Lost and found**, at the bottom: log a "Green scarf" found in Room 9, then mark it claimed.

### Moving the clock

The clock starts at 10:41 PM and ticks forward. To jump to another time, use a second Terminal window:

```
curl -X POST http://127.0.0.1:3000/v1/ops/clock -H 'content-type: application/json' -d '{"server_time":"2026-09-26T02:45:00Z"}'
```

The time is in UTC: 02:45 UTC is 10:45 PM in New York. At 10:45 PM, **Mark no-show** appears on Sam O. (the 15-minute grace is over). Reload the page after moving the clock.

### Waitlist and the guest page

1. On a phone-sized window, open http://localhost:3001/v/west4karaoke/waitlist (the page behind the door QR code).
2. Join as a party of 4 with any US number. The page reads **3 parties ahead**.
3. Move the clock to 10:45 PM, press **Mark no-show** on Sam O. on the board, then in the board's **Waitlist · 4** drawer press **Offer a room** on your party. Reload the guest page: **Room 2 is ready · 10:00 to claim it**.

### Messages

Open **Messages** in the side menu. Sam O.'s "running 15 late" is unread. Open it, press **Reply "no problem"**, and the reply "No problem. We'll hold your room until 10:45 PM." appears. Try replying with a link, such as "west4karaoke.com/book": it's refused, because staff replies can't carry links or promotions.

### Calls and Approvals

- **Calls** (a phone tab): Room 9's "Another mic, please". Press **On it** and it disappears everywhere.
- **Approvals** need the approver's own phone. As Andy, open **Alerts** and press **Turn on alerts**; that makes this browser Andy's phone. Then a request from Diego (for example a clock pause through Report a fault) lands in Andy's **Approvals** tab.

### Calendar

Open **Calendar**: tonight's 11 bookings, and the days ahead. Try **New booking** for 22 guests at 11:00 PM tonight: refused, because Bianca L. holds the VIP room. Try 9:00 PM: refused, it has passed. Open Saturday and press **Block this date** to see which bookings it affects.

### Admin (owner and manager)

Open **Admin** in the side menu:

- **Team**: people, roles, languages.
- **Features**: the modules that are on and off.
- **Hours & prices**: opening hours, last call, and now the prices: $10 a person an hour, at least 4 guests on Friday and Saturday, the VIP room at $250 an hour from 20 guests, the $150 damage fee.
- **Printers & devices**: pair a computer.
- **Rooms**: the 14 rooms.
- **Phone & texts** and **Texts**: the 14 automatic texts.
- **Alerts & rules**: when a tile turns amber.
- **Safety**: the occupancy limit, empty until you enter your real one.

Change something, press **Save and publish**, and the board follows.

### Spanish

Press **Español** in the side menu: every staff screen switches. Press **English** to switch back.

## 6. Reading emails and texts

- **Emails** (passkey codes) land in the local inbox at http://localhost:8025.
- **Texts** never leave your Mac. `scripts/demo-codes.sh` shows the latest codes. Every text the app writes, such as Room ready, Running late or Room code, is in the Messages screen of the staff app.

## 7. Starting over

To reset the night to 10:41 PM without restarting the apps, open a second Terminal window and run:

```
cd ~/Downloads/west4-karaoke
scripts/demo-local.sh
```

It reloads the demo night and prints new invite links. Your old passkeys are removed, so make a new one with the new link.

## 8. What isn't built yet

M2 covers rooms, the board, check-in, the waitlist, texts and the calendar. These come next:

- **M3:** drinks, ordering from the room, the bar, voids and comps on drinks, cut-offs.
- **M4:** presenting the check, paying, receipts.
- **M5:** the public website, online booking and deposits.
- **M2-27** (the CAPTCHA and daily limits on the waitlist page) waits for your choice of provider and limits.

## 9. If something goes wrong

| What you see | What to do |
| --- | --- |
| "Port … is already in use" | An earlier run is still going. Close its Terminal window, or restart the Mac. |
| A page says it can't reach the server | Check the Terminal running `demo-start.sh` is still open and says Ready. |
| Touch ID doesn't appear | Use Chrome, and make sure you're on `localhost`, not `127.0.0.1`. |
| "That link was already used" | Run `scripts/demo-local.sh` for new invite links. |
| Something looks wrong on a screen | The logs are in the `.demo-logs` folder: `api.log`, `staff.log`, `guest.log` and `worker.log`. |
