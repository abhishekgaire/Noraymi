# Sing Sing Karaoke Astoria · the venue

What Sing Sing's own public website says about the venue, read on Oct 11, 2026 from https://singsingastoria.com/ (the page and the site's own script that draws it; no logins, no other sites). **Confirm every line with the manager before go-live**: the site can be out of date, and some of it is the site's default text rather than a setting the manager chose. Nothing here is in the demo seed or the code; Sing Sing's Admin gets these values from its manager at setup.

## What the site states

| Fact | What the site says | Where it goes in Admin |
| --- | --- | --- |
| Name | Sing Sing Karaoke Astoria | The venue's name |
| Address | 25-30 Broadway, Astoria, NY 11106 (on Broadway between Crescent St and 29th St, Astoria, Queens) | The venue's address |
| Phone | (929) 739-7310 | Admin → Phone & texts, call number (to confirm: the texting number is our own Twilio number) |
| Email | admin@singsingastoria.com | Not a setting; the manager decides which inbox gets booking emails |
| Getting there | N or W train to Broadway, about a 3-minute walk west along Broadway | Website text, if the manager wants it |
| Opening hours | Monday to Wednesday 12:00 PM – 12:00 AM; Thursday 12:00 PM – 1:00 AM; Friday and Saturday 12:00 PM – 3:00 AM; Sunday 12:00 PM – 12:00 AM | Admin → Hours (`hours.weekly`); last call isn't stated |
| Happy hour | "Daily 12:00 PM – 7:00 PM", with drink deals and discounted per-person room rates (the site's pop-up; its prices aren't stated) | A price band in Admin → Prices, once the manager gives the rates |
| Age | All ages before 8 PM; 21+ with a physical ID after 8 PM | House policy for staff and the website text; the ID checks for alcohol don't change |
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
