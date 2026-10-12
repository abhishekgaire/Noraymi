# Sing Sing Karaoke Astoria · the venue

What Sing Sing's own public website says about the venue, read on Oct 11, 2026 from https://singsingastoria.com/ (the page and the site's own script that draws it; no logins, no other sites). **Confirm every line with the manager before go-live**: the site can be out of date, and some of it is the site's default text rather than a setting the manager chose. Nothing here is in the demo seed or the code; Sing Sing's Admin gets these values from its manager at setup.

## What the site states

| Fact | What the site says | Where it goes in Admin |
| --- | --- | --- |
| Name | Sing Sing Karaoke Astoria | The venue's name |
| Address | 25-30 Broadway, Astoria, NY 11106 (on Broadway between Crescent St and 29th St, Astoria, Queens) | The venue's address |
| Phone | (929) 739-7310 | Admin → Phone & texts, call number (to confirm: the texting number is our own Twilio number) |
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
- **Last call, the drinks' cash discount rate, which beers are on draft and the pour size.** Not stated; see [menu.md](menu.md) and [Open technical questions](../../spec/14-open-questions.md).
- **The largest party that can book online.** The site has its own setting for it; the value isn't public.

## Settings to set at onboarding

Sing Sing isn't a venue in the database yet. These are its own choices, already made, for its owner to enter in [Set up your venue](../../spec/17-onboarding.md) when S-01 creates it (editable later in Admin) (West 4's demo seed keeps its own):

| Setting | Sing Sing's choice | Where in Admin | Decided |
| --- | --- | --- | --- |
| Deposits for online bookings | Off (`deposit.on` false): online bookings pay nothing up front, as the site says. The site's card for groups over 5 is to confirm with the manager before go-live | Admin → Deposits & cancelling | Founder, Oct 11, 2026 |
| What a walk-in check-in takes | **Keep the card behind the bar** (`deposit.walkIn` "cardBehindBar", D116): once the party is seated, staff keep the guest's physical card and type the name on it and its last 4 digits onto the room's check; no reader, nothing charged; close-out ends with "Give the card back". Sing Sing physically holds guests' cards on a tab (the founder, Oct 11), so this replaces the earlier "Put a card on the tab" (`cardOnTab`) | Admin → Deposits & cancelling → At a walk-in check-in | D112, D116, Oct 11, 2026 |
| Age policy | All ages until 8 PM, then 21 and over (`safety.allAgesUntil` "20:00") | Admin → Safety | D108 |

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
| 3 · Card payments | Connect with Stripe: the business, its EIN, a representative and the bank account, typed by the owner in Stripe's own pages | — | Still to give |
| 4 · Rooms and prices | 6 rooms | The founder | Given |
| 4 · Rooms and prices | Each room's name, size and capacity; how room time is charged, the rate, the billing step, minimum guests; the happy-hour band (daily 12:00 PM – 7:00 PM on the site, its rates not stated); a VIP rate if any | — | Still to give |
| 5 · Hours | Mon–Wed 12:00 PM – 12:00 AM; Thu 12:00 PM – 1:00 AM; Fri and Sat 12:00 PM – 3:00 AM; Sun 12:00 PM – 12:00 AM | The site, to confirm | Given |
| 5 · Hours | Last call; the kitchen's opening and last-order times | — | Still to give |
| 5 · Hours | Age policy: all ages until 8 PM, then 21 and over (`safety.allAgesUntil` "20:00") | D108 | Given |
| 6 · Deposits and check-in | No deposit online (`deposit.on` false) | The founder, Oct 11 | Given |
| 6 · Deposits and check-in | At a walk-in check-in: Keep the card behind the bar | D116 | Given |
| 6 · Deposits and check-in | No-show after 15 minutes late | The site, to confirm | Given |
| 6 · Deposits and check-in | Free-cancel hours, the late-cancel and no-show fee, the card asked of groups over 5, the largest party that books online | — | Still to give |
| 7 · Money at the counter | The cash discount rate and whether food prices include the card fee; the automatic gratuity; whether the reader asks for a tip, and its choices; house drawers or a drawer per person, and the starting bank | — | Still to give (each keeps its default until saved; a card reader can't be registered until the tip screen answer is saved) |
| 8 · Menu | The menu from the spreadsheet: [`import/`](import/) (`mapping.json`, `items.csv`, `choices.csv`, 179 menu lines), checked as a dry run, then Looks right | [menu.md](menu.md), the founder, Oct 9 | Given |
| 8 · Menu | The drinks' pour sizes and which beers are on draft; what a combo includes; the extra-sauce price; the kitchen's allergy notice | — | Still to give |
| 9 · Team and contacts | Each manager's and staff member's name, phone and role; the first and second on-call responders and their hours; the breach contact and backup | — | Still to give |
| 10 · Licenses | The liquor license (needed before Ready to open); the food service permit and the Food Protection Certificate holders; the music licenses (ASCAP, BMI, SESAC, GMR) | S-06 | Still to give |
| 11 · Texts, website and your old system | Register for texts (needs the EIN, typed once, and our team's texting number first: S-05) | — | Still to give |
| 11 · Texts, website and your old system | Website: singsingastoria.com exists; whether its site and domain move later is the owner's answer | The site | Still to give |
| 11 · Texts, website and your old system | The old system's export files (bookings, deposits, guests, team) | — | Still to give |
| 12 · Devices and checks | Card readers, receipt printers with their drawers, badge readers (S-07's hardware); the merchant category check once Stripe is connected; each manager's Stripe Dashboard login and Tap to Pay phone | S-07 | Still to give |

When every Given row says Entered, Admin → Setup's checklist should list only the Still to give rows that are required (Stripe, rooms and prices, a manager with a PIN, on-call and breach contacts, the liquor license, a reader, a receipt printer with a drawer, the merchant category); that list is what the manager still owes. Finish setup waits for them; the first live night still follows the go-live runbook (S-12).
