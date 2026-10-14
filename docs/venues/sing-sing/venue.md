# Sing Sing Karaoke Astoria · the venue

What Sing Sing's own public website says about the venue, read on Oct 11, 2026 from https://singsingastoria.com/ (the page and the site's own script that draws it; no logins, no other sites). **Confirm every line with the manager before go-live**: the site can be out of date, and some of it is the site's default text rather than a setting the manager chose. Nothing here is in the demo seed or the code; Sing Sing's Admin gets these values from its manager at setup.

## What the site states

| Fact | What the site says | Where it goes in Admin |
| --- | --- | --- |
| Name | Sing Sing Karaoke Astoria | The venue's name |
| Address | 25-30 Broadway, Astoria, NY 11106 (on Broadway between Crescent St and 29th St, Astoria, Queens) | The venue's address |
| Phone | (929) 739-7310 | Admin → Phone & texts, call number. The texting number is the one Sing Sing buys in its own Twilio account and connects there (D123) |
| Email | admin@singsingastoria.com | Not a setting by itself; the owner names the booking inbox (`contacts.bookingEmails`) in onboarding step 1 (D115) |
| Getting there | N or W train to Broadway, about a 3-minute walk west along Broadway | Website text, if the manager wants it |
| Opening hours | Monday to Wednesday 12:00 PM – 12:00 AM; Thursday 12:00 PM – 1:00 AM; Friday and Saturday 12:00 PM – 3:00 AM; Sunday 12:00 PM – 12:00 AM | Admin → Hours (`hours.weekly`); last call isn't stated |
| Happy hour | "Daily 12:00 PM – 7:00 PM", with drink deals and discounted per-person room rates (the site's pop-up; its prices aren't stated) | A price band in Admin → Prices, once the manager gives the rates |
| Age | All ages before 8 PM; 21+ with a physical ID after 8 PM | Admin → Safety: set the age policy to all ages until 8 PM (`safety.allAgesUntil` "20:00", D108). It words the website, the Book page and bookings that run past 8 PM, and the board's alert at 8 PM; the ID checks for alcohol don't change |
| Walk-ins | Always welcome at the cocktail bar for drinks and food | — |
| Rooms | Advance booking recommended on weekends. Online bookings pay nothing up front: "Pay upon arrival", "$0 due today"; guests are asked to arrive 15 minutes early | Admin → Deposits (see below) |
| Card holds | Groups over 5 are asked for a card, $10 a person, to hold the room; parties of 1 to 5 book without one. Free cancellation up to a set number of hours before the start, then a late-cancel or no-show fee (the site's text gives 2 hours' notice; the hours and the fee amount are the site's own settings, not readable from outside) | Admin → Deposits: `cardHold` mode with a big-party rule from 6 guests; the hours and the fee are the manager's to give |
| No-show | A booking is a no-show 15 minutes or more past its time | Admin → Deposits, `graceMin` 15 (to confirm) |
| Songs | "50,000+ songs" | — |

## What the site doesn't say

- **Kitchen hours and a kitchen last-order time.** Not stated anywhere. `kitchen.lastOrder` stays empty (food can be ordered while room ordering is open) until the manager sets it in Admin → Kitchen.
- **Room rates and room sizes.** The site's staff screens list sample suites (Small 2–4, Medium 5–8, Large 9–14, a VIP suite 15–25), but those are inside the site's own admin tool, not public statements, and Sing Sing has 6 rooms ([spec 16](../../spec/16-kitchen.md)). Take the rooms and their prices from the manager.
- **Last call, which beers are on draft and the pour size.** Not stated; see [menu.md](menu.md) and [Open technical questions](../../spec/14-open-questions.md).
- **The largest party that can book online.** The site has its own setting for it; the value isn't public.

## Settings to set at onboarding

Sing Sing isn't a venue in the database yet. These are its own choices, already made, for its owner to enter in [Set up your venue](../../spec/17-onboarding.md) when S-01 creates it (editable later in Admin) (West 4's demo seed keeps its own):

| Setting | Sing Sing's choice | Where in Admin | Decided |
| --- | --- | --- | --- |
| Deposits for online bookings | Off (`deposit.on` false): online bookings pay nothing up front, as the site says. The site's card for groups over 5 is to confirm with the manager before go-live | Admin → Deposits & cancelling | Founder, Oct 11, 2026 |
| What a walk-in check-in takes | **Keep the card behind the bar** (`deposit.walkIn` "cardBehindBar", D116): once the party is seated, staff keep the guest's physical card and type the name on it and its last 4 digits onto the room's check; no reader, nothing charged; close-out ends with "Give the card back". Sing Sing physically holds guests' cards on a tab (the founder, Oct 11), so this replaces the earlier "Put a card on the tab" (`cardOnTab`) | Admin → Deposits & cancelling → At a walk-in check-in | D112, D116, Oct 11, 2026 |
| Age policy | All ages until 8 PM, then 21 and over (`safety.allAgesUntil` "20:00") | Admin → Safety | D108 |
| Kitchen allergy notice | EN: "Allergen information for menu items is available. Ask an employee for details." ES (our translation, **confirmed by the founder for Sing Sing, Oct 13, 2026**): "La información sobre alérgenos de los platos del menú está disponible. Pregunte a un empleado para más detalles." The venue's own wording, so Kitchen & food doesn't wait on the lawyer | Admin → Kitchen | Founder for Sing Sing, Oct 13, 2026 (D125) |
| Approvals | **Manager's PIN at the register** (`approvals.mode` "pin"): Sing Sing starts on its bar computers, so a manager types their PIN on the register that asks | Admin → Features → Choices | Founder, Oct 13, 2026 (D126) |

### Choose your features (step 2)

Sing Sing's own choices in Set up your venue's **Choose your features** ([D124](../../decisions.md)), editable later in Admin → Features. Reports & accounting, Bar tabs & quick sale and the rest of the register are always on and aren't listed.

| Feature | Sing Sing's choice | Decided |
| --- | --- | --- |
| Rooms & room clock | On | Founder, Oct 13, 2026 |
| Bar screen & tickets | On | Founder, Oct 13, 2026 |
| Kitchen & food | On (with the allergy notice above and the kitchen network printer) | Founder, Oct 13, 2026 |
| Website | On | Founder, Oct 13, 2026 |
| Online booking | On | Founder, Oct 13, 2026 |
| Ordering from the room | On | Founder, Oct 13, 2026 |
| Keep the card behind the bar for walk-ins | On | Founder, Oct 13, 2026 |
| Cash discount | On at **3.38%** (cash pays 3.38% less, which is the card price less a 3.5% card markup: $13.45 → $13.00), as Sing Sing's register shows today ("Cash Disc (3.38%)"); menu prices, drinks and food, include the card fee | Founder, Oct 13, 2026 (D125); the register photos, Oct 14 (D130) |
| Paid on outside card machine | On, beside Stripe's readers (both on), so it can start on its own machine and move to readers | Founder, Oct 13, 2026 (D126) |
| Deposits on bookings | Off | Founder, Oct 13, 2026 |
| Bar mode | Off | Founder, Oct 13, 2026 |
| Song system control | Off | Founder, Oct 13, 2026 |
| Marketing texts | Off | Founder, Oct 13, 2026 |
| Room tablets | Off (bar computers only, D126; can be turned on later) | Founder, Oct 13, 2026 |
| Walk-in waitlist, Packages & specials, Guest texts, Team, time clock & tips, Safety & ID records, Guests pay their own share | The plan's default (on) until the owner chooses | Still to give |
| Texting (Choices) | On (each text's own switch at its default) until the owner chooses | Still to give |
| Drinks rung at the bar print a ticket (Choices) | Off (the default) until the owner chooses | Still to give |

## Entering Sing Sing through Set up your venue

The runbook for S-01's last part (O-14): once our Console has made Sing Sing and its owner has joined from the invite, the owner (the founder or Sing Sing's manager, signed in with a passkey) enters these values in [Set up your venue](../../spec/17-onboarding.md), step by step, on staging first. **Given** means the value is in this folder and goes in as written once the manager confirms it; **Still to give** means nobody has given it yet: leave the field empty (the screen shows its "not set" hint) and it stays on the checklist for the manager. Never fill a gap with a guess or with West 4's value. Mark each row **Entered** with the date when it's saved on staging, and again on production.

| Step | Value | Source | State |
| --- | --- | --- | --- |
| 1 · Your venue | Name: Sing Sing Karaoke Astoria | The site | Given |
| 1 · Your venue | Address: 25-30 Broadway, Astoria, NY 11106 (confirms New York's rule pack and time zone) | The site | Given |
| 1 · Your venue | Number guests call: (929) 739-7310 | The site, to confirm | Given |
| 1 · Your venue | Legal name (the company on the liquor license and with Stripe) | — | Still to give |
| 1 · Your venue | Booking inbox: admin@singsingastoria.com is the site's address; the owner confirms it's the one bookings go to | The site, to confirm | Given |
| 2 · Your plan | Rooms + Kitchen (6 private rooms and a kitchen) | [spec 16](../../spec/16-kitchen.md), the founder | Given |
| 2 · Choose your features | As the table "Choose your features (step 2)" above; Approvals: Manager's PIN at the register | The founder, Oct 13 (D124, D126) | Given (the rows marked Still to give there stay the owner's) |
| 3 · Card payments | Connect with Stripe: the business, its EIN, a representative and the bank account, typed by the owner in Stripe's own pages | — | Still to give |
| 4 · Rooms and prices | 6 rooms | The founder | Given |
| 4 · Rooms and prices | Minimum guests billed: 3, every day of the week (tick Same minimum every day, then 3) | The founder, Oct 14 (D128) | Given |
| 4 · Rooms and prices | Each room's name, size and capacity; how room time is charged, the rate, the billing step; the happy-hour band (daily 12:00 PM – 7:00 PM on the site, its rates not stated); a VIP rate if any | — | Still to give |
| 5 · Hours | Mon–Wed 12:00 PM – 12:00 AM; Thu 12:00 PM – 1:00 AM; Fri and Sat 12:00 PM – 3:00 AM; Sun 12:00 PM – 12:00 AM | The site, to confirm | Given |
| 5 · Hours | Last call; the kitchen's opening and last-order times | — | Still to give |
| 5 · Hours | Age policy: all ages until 8 PM, then 21 and over (`safety.allAgesUntil` "20:00") | D108 | Given |
| 6 · Deposits and check-in | No deposit online (`deposit.on` false) | The founder, Oct 11 | Given |
| 6 · Deposits and check-in | At a walk-in check-in: Keep the card behind the bar | D116 | Given |
| 6 · Deposits and check-in | No-show after 15 minutes late | The site, to confirm | Given |
| 6 · Deposits and check-in | Free-cancel hours, the late-cancel and no-show fee, the card asked of groups over 5, the largest party that books online | — | Still to give |
| 7 · Money at the counter | The cash discount rate and whether food prices include the card fee; the automatic gratuity; whether the reader asks for a tip, and its choices; house drawers or a drawer per person, and the starting bank | — | Still to give (each keeps its default until saved; a card reader can't be registered until the tip screen answer is saved) |
| 8 · Menu | The menu from the spreadsheet: [`import/`](import/) (`mapping.json`, `items.csv`, `choices.csv`, 179 menu lines), checked as a dry run, then Looks right | [menu.md](menu.md), the founder, Oct 9 | Given |
| 8 · Menu | The drinks' pour sizes and which beers are on draft; what a combo includes; the extra-sauce price | — | Still to give |
| 8 · Menu | The kitchen's allergy notice: the venue's wording above, English and Spanish (the Spanish for the venue to confirm) | The founder for Sing Sing, Oct 13 (D125) | Given |
| 9 · Team and contacts | Each manager's and staff member's name, phone and role; the first and second on-call responders and their hours; the breach contact and backup | — | Still to give |
| 10 · Licenses | The liquor license (needed before Ready to open); the food service permit and the Food Protection Certificate holders; the music licenses (ASCAP, BMI, SESAC, GMR) | S-06 | Still to give |
| 11 · Texts, website and your old system | Connect your Twilio account: Sing Sing's own Twilio account, number, brand and service campaign, set up by its owner or manager (S-05, D123) | — | Still to give |
| 11 · Texts, website and your old system | Website: singsingastoria.com exists; whether its site and domain move later is the owner's answer | The site | Still to give |
| 11 · Texts, website and your old system | The old system's export files (bookings, deposits, guests, team) | — | Still to give |
| 12 · Devices and checks | Bar computers only to start (D126): the desktop app on each bar computer (Windows, D127), a receipt printer with its drawer on each, a kitchen network printer; no staff phones, room tablets, badge readers or Up next TV (each can be added later). Card readers: Stripe readers and the venue's own outside card machine, both on (F-10); with the outside machine on, setup needs no Stripe reader before opening (D129), so one can be registered whenever it arrives | The founder, Oct 13 (D126); [hardware-install.md](../../runbooks/hardware-install.md) | Given |
| 12 · Devices and checks | **Given (founder, Oct 13, 2026):** 2 bar computers, one used most of the time; the Epson TM-T88V with the bar drawer; the Rongta RP326 kitchen printer cabled to a bar computer; a Star TSP143IIIW (Wi-Fi) as the alternative (see [Hardware](#hardware) below; S-07). Still to give: the merchant category check once Stripe is connected; each manager's Stripe Dashboard login (a Tap to Pay phone only if the manager wants one) | S-07, D127 | Still to give |

When every Given row says Entered, Admin → Setup's checklist should list only the Still to give rows that are required (Stripe, rooms and prices, a manager with a PIN, on-call and breach contacts, the liquor license, a reader, a receipt printer with a drawer, the merchant category); that list is what the manager still owes. Finish setup waits for them; the first live night still follows the go-live runbook (S-12).

## Hardware

What the founder told us on Oct 13, 2026 ([D126](../../decisions.md), [D127](../../decisions.md)). Sing Sing runs everything on its bar computers; there are no room tablets, badge readers, staff phones or Up next TV to install (each can be added later).

| What | Where | How it connects | In Admin → Printers & devices |
| --- | --- | --- | --- |
| **2** bar computers running **Windows** 10 or 11, each with the desktop app ("West 4 Staff"); one is used most of the time | The bar | The venue's network | Paired as "Bar computer" (the main one) and "Bar computer 2". Cable the kitchen printer to the main one, which is on whenever the bar is open |
| **Epson TM-T88V** (model M244A) receipt printer, the **cash drawer** on its DK (drawer) port | The bar, one per bar computer that takes cash | USB to the bar computer, with Epson's TM-T88V driver (APD) | Shows up as "Cabled to Bar computer"; station Bar; command set ESC/POS; link the bar drawer to it |
| **Rongta RP326** thermal printer: **today's kitchen printer** | The kitchen | A long cable to a bar computer (USB most likely; if it's serial, through a USB-to-serial adapter, and its Windows queue named in `WEST4_WINDOWS_PRINTERS`) | Shows up as "Cabled to Bar computer"; set its station to **Kitchen**; command set ESC/POS |
| **Star TSP100III** (TSP143III): the alternative, at the bar or in the kitchen | Bar or kitchen | **USB** to a bar computer like the Rongta (the TSP143IIIU, with Star's futurePRNT driver), or on the network: the **LAN** model (TSP143IIILAN) or the **Wi-Fi** model (TSP143IIIW), with a fixed IP address, as a Network printer | Command set **Star raster** (it prints only Star's raster commands, and has no CloudPRNT; the app draws the ticket as a picture). Sing Sing's is the **Wi-Fi model, TSP143IIIW** (founder, Oct 13, 2026): it can go in the kitchen as a Network printer, with a fixed IP address on the shop's router |
| Card payments | The bar | The **outside card machine** (the venue's own, F-10), and Stripe readers only if the owner adds them later | Nothing to pair for the outside machine |

- **The kitchen prints only while the bar computer it's cabled to is on and has the app open.** If that computer is off, asleep or offline, every kitchen ticket shows "Kitchen ticket didn't print · Reprint" on the bar's screens within about 20 seconds; Reprint sends it to the kitchen again, or **Print at the bar instead** prints it on the Epson. Keep that computer on through the night (the app keeps the screen awake).
- **A Rongta RP326 on the network** (only if Sing Sing buys the Ethernet version, such as the RP326-USE): it can then sit in the kitchen with no cable to a computer, as a Network printer with a fixed IP address reserved in the router ([hardware-install.md](../../runbooks/hardware-install.md#a-network-printer-in-the-kitchen-w-04)). A USB-only RP326 can't be reached over the network.
- **The Star TSP100III and West 4.** West 4's own docs and seed name no Star model, but if West 4 ever uses a TSP100III it has the same limit: Star raster only, no CloudPRNT, so it is set to Star raster as here, never added as a cloud printer.
- **Checking it:** `pnpm --filter @west4/api devices:check -- --venue <Sing Sing's slug> --set bar-computers` (the bar computers with the desktop app online, the bar printer and drawer online, the kitchen printer online while Kitchen & food is on, and a card reader only when the outside card machine is off), then the [real-Windows check list](../../runbooks/hardware-install.md#check-on-a-real-windows-bar-computer).

## Today's register (the founder's photos, Oct 14, 2026)

What Sing Sing runs now (VenueTap POS v1.1.53 on the bar computer), for reference; nothing here is copied from it ([integrations are partnerships only](../../../CLAUDE.md)).

- **Screens:** Karaoke (rooms), Bar Sales (named bar tabs and a "Cash Bar" quick sale), Dine In, Quick Serve (takeout), Reservation (a calendar), Clock In / Clock Out, Open Drawer, Tip Adjust, Manual Ticket (past-dated tickets), and Settings (modules, company info, store hours, staff and their access, which actions ask for a PIN, items, rooms, inventory, sales reports, batch and Z report, printers, PAX card terminals, devices, QR ordering, an audit of voids and removals, logs). Staff sign in with a 4-digit PIN.
- **Starting a room:** number of guests (3 by default), a name or note, count up (per minute, no end) or count down (a prepaid block), an estimated length (60 minutes by default), a time alarm and a package tick box. Ours is the walk-in dialog (D128).
- **A bar check of $3.00:** sales tax $0.27, city tax $0.00, gratuity $0.60 (20% before tax), total $3.87; the adjustments are Discount, Gratuity, Tax, **Cash Disc (3.38%)**, Void and Refund (D130).
- **At the bar:** an Epson receipt printer with the drawer, a **PAX** card terminal (the outside card machine), a Grubhub tablet for delivery orders, an HDMI matrix switcher, and a second screen running the bar's song queue program (Song Queue Manager 3.1). A paper "Tip Log Book" sits beside it.
- **Still to confirm with the manager:** the room screen numbers rooms up to at least 14, while this file says 6 rooms; and whether the 20% gratuity on a bar check is added to every check automatically.
