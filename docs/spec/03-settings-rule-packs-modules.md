## Settings, rule packs and modules

Each venue setting is a versioned document checked against the venue's rule pack on every save, so no screen can offer an option the law doesn't allow.

**Settings.** One append-only table, `venue_settings (venue_id, key, version, value jsonb, saved_by, saved_at)`, with one typed key per topic. "Save and publish" in Admin writes new versions of the changed keys in one transaction and sends a `settings.changed` event, so the site, board, tablets and menu PDF refresh. Old versions are the change log, and every check revision stores the versions it was priced with.

**When a change starts.** A save is live at once, except the changes the canvas starts at the next business date: the drawer model, tip-pool changes (the method, and who's eligible) and bar POS layouts. Admin shows the date each one starts ("Starts Sat Sep 26" on the demo night) and keeps tonight as it is.

**One place for each fact.** Special and closed dates are rows in the `closures` table, never a settings key. Every text's wording, and whether it's on, live only in `message_templates`. The site's words, photos and sections live only in `site_versions`, and a venue's own domain in `domains`. The time zone and the business-day cutover are columns on `venues`, set at setup, because moving them moves every business date. Training mode is per person and per device, so it lives on `memberships.training` and `devices.training` (Admin → Team → Training mode). Modules aren't a settings key either; they live only in `venue_modules`.

| Key | Holds |
| --- | --- |
| `hours` | Weekly hours and the house last call. Once the Google connection is set up, a job pushes every change, and every `closures` row, to Google Business Profile; until then Admin shows Google as not connected |
| `prices` | The room rate in one of three modes, the billing step, minimum guests, time bands in the venue's own rate mode, the VIP rate, minimum spend by room tier, day and band (off at West 4), booking limits and the damage fee |
| `deposit` | The deposit rule, including big parties and card holds |
| `pay` | Card fee, gratuity, the reader's tip screen, tip review, tip pool, the room card hold, and Pay my share: whether guests can pay their own share from their phones (on at West 4) |
| `drawer` | The drawer model (house drawers or a drawer per person), the starting bank, the count difference that needs a note, when a second person counts, the paid-out amount that needs approval, and whether a tray can be pulled and counted at close; a change starts with the next business date |
| `tabs` | The opening hold, the amount that flags a tab ($600 at West 4) and the tab cut-off, when tabs still open are charged (4:30 AM at West 4). The consent line read at New tab is built from them. The house last call is in `hours` |
| `pos` | The bar POS: the published layout per station, the reason-only limits for comps and voids (each and per shift), the idle and wipe locks, whether bar tabs tip on the reader or a slip, how room orders age and escalate, the chime and how long Mute lasts. Admin → Bar POS edits `pos` and `tabs` together ([Staff screens and the bar POS](10-staff-screens-bar-pos.md)) |
| `ordering` | Whether a new room session starts with the host lock on. Guest ordering itself is the "Ordering from the room" module, and guests can cancel only while an order is ringing or asked to wait, which is a rule, not a setting |
| `rooms` | Cleaning time between bookings, how cleaning ends, when the board flags a room still cleaning, and whether a room stays on by the minute when nobody's booked next |
| `barMode` | The song price (not set at West 4), the drink credit for "Buy a drink, get a song", free nights, songs per singer per round, singer alerts, and how many singers the Up next TV shows ([Song systems and texts](11-song-systems-texts.md)) |
| `alerts` | When a room's tile warns that its time is ending. The other alert times live with their topic: `pos.orderAging`, `rooms.cleaningFlagMin`, `tabs.flagOverCents`, `deposit.graceMin` and `safety.warnAtPct` |
| `phone` | The number guests call and the number texts come from |
| `website` | How the site words prices |
| `messages` | When the reminder and offer-expiring texts go out |
| `safety` | The occupancy limit and when the board warns (empty at West 4, and never guessed) |
| `languages` | The staff languages a venue offers: English and Spanish in phase 1 |

The money and time shapes:

```ts
type Hours = {
  weekly: { day: number; opens: string; closes: string }[];   // closes can be after midnight, e.g. "04:00"
  lastCall: string | null;           // the house last call: earlier than the rule pack's close, never later
};                                   // special and closed dates are closures rows; the time zone and cutover are on venues

type Rate =
  | { mode: "perPerson"; perPersonCents: number }              // $10 at West 4
  | { mode: "basePlusExtra"; baseCents: number; baseGuests: number; extraCents: number }
  | { mode: "flatBySize"; bySizeCents: Record<string, number> };

type Billing = {
  incrementMin: 1 | 15 | 30 | 60;    // the billing step after the first hour: by the minute (1) at West 4
  rounding: "up" | "nearest" | "down";   // how a part step is billed
};                                   // every session segment stores the step and rounding it was billed with

type PriceSettings = {
  rate: Rate;
  billing: Billing;
  minGuests: { weeknight: number; friSat: number };  // on the business date: 3 and 4 at West 4
  firstHourMinimum: boolean;
  bands: { name: string; days: number[]; fromMin: number; toMin: number; rate: Rate; billing: Billing }[];
                                                     // a band's rate is in the venue's own mode (K13); minutes from midnight
                                                     // at the start of the business date, so 12:30 AM is 1470. None at West 4
  vip: { roomIds: string[]; hourlyCents: number; fromGuests: number } | null;
                                                     // $250 from 20 guests; smaller parties pay the normal rate
  minSpend: { tier: string; days: number[]; band: string | null; cents: number }[];
                                                     // K4: per room tier, business-date weekday and band (null: all night);
                                                     // empty at West 4, so no screen shows a minimum
  booking: { minHours: number; maxHours: number; maxGuests: number; startSlots: string[] };
  damageFeeCents: number;                            // 15000 at West 4
};

type DepositRule = {
  on: boolean;
  mode: "firstHour" | "perPerson" | "flat" | "percent" | "cardHold";   // cardHold saves a card and charges nothing
  value: number;                 // cents for perPerson and flat, percent for percent
  refundHours: number;           // full refund if cancelled this far ahead of the first confirmed start
  late: "keep" | "half" | "refund";
  noShow: "keep" | "firstHour" | "nothing";   // firstHour charges up to one hour in total, deposit included
  graceMin: number;              // 15 at West 4: a booking can be marked a no-show after this
  bigParty: { fromGuests: number; deposit: { kind: "flat"; cents: number } | { kind: "pct"; pct: number };
              refundHours: number } | null;
                                 // a pct deposit is taken on the larger of room cost and the booking's minimum spend
};

type CardFee =
  | { mode: "off" }
  | { mode: "surcharge"; pct: number; noticeSentOn: string | null }   // credit only; one rate, capped at the in-person card cost
  | { mode: "discount"; pct: number };

type PaySettings = {
  cardFee: CardFee;                                  // off at West 4
  gratuity: { auto: "off" | "rooms" | "parties" | "all"; pct: number; partyMin?: number };   // 20% on rooms at West 4
  tipScreen: {
    on: boolean;
    pcts: [number, number, number];                  // 18, 20 and 22 at West 4
    fixedCents: [number, number, number];            // [100, 200, 300]: the reader offers $1, $2 and $3 below the threshold
    smartThresholdCents: number;                     // 1000: below $10 the reader shows the fixed amounts, not percents
  };                                                 // room checks carry the gratuity, so the reader skips its tip screen there
  tipReview: { overPct: number; overCents: number; lateHours: number };   // 25%, $50 and 2 hours at West 4
  pool: "hours" | "even" | "roomServer";             // a change starts with the next business date
  roomHold: { on: boolean; cents: number };   // a card hold at room check-in, for venues without deposits; off at West 4
  payShare: { on: boolean };                  // Pay my share, on at West 4: from the room page a guest pays "My items" or
                                              // "An even share (1 of N)", with their share of tax and gratuity, by Apple Pay,
                                              // Google Pay or card; the booker's card still guarantees the rest
};

type CashSettings = {
  drawer: "house" | "perPerson";        // house drawers the manager on duty answers for, or each person's own drawer or tray
  startingBankCents: number;               // $300 in the West 4 designs
  noteOverCents: number;                   // a count off by more than this needs a note; $20 in the designs
  secondCounter: "never" | "whenOff" | "always";
  paidOutApprovalCents: number;
  perPerson: { who: "bartenders" | "bartendersAndServers"; countLater: boolean };   // countLater: pull a tray, count it at close
};                                         // a change starts with the next business date. West 4 runs two house drawers (the
                                           // bar drawer and the front-desk drawer, rows in cash_drawers); cash goes into the
                                           // drawer at the screen where it's taken

type TabSettings = {
  openingHoldCents: number;                                 // 5000
  flagOverCents: number;                                    // 60000: a tab over this shows on the manager's phone
  cutOffAt: string;                                         // "04:30": tabs still open are charged at their balance
};                                                          // the consent line is a policy_versions row, built from these
```

The operating shapes:

```ts
type PosSettings = {                                        // the same shape as in Staff screens and the bar POS
  layouts: Record<string, number>;                          // station → the published pos_layouts version
  reasonOnly: { eachCents: number; perShiftCents: number }; // 2500 and 7500 at West 4; 0 sends every comp and void for approval
  idleLockMin: number;                                      // 3
  wipeLockSec: number;                                      // 10
  barTabTip: "reader" | "slip";                             // the slip stays as the fallback either way
  orderAging: { phonesSec: number; amberSec: number; pinkSec: number; callSec: number };
                                                            // 30, 120, 240, 360: the board alerts at amber, the manager on duty is told at pink
  chime: boolean;                                           // true: a backup to the colors
  muteSec: number;                                          // 60
};                                                          // tip choices come from pay.tipScreen: 18, 20, 22% at West 4

type OrderingSettings = {
  hostLockDefault: boolean;          // whether a new room session starts with the host lock on; the host can change it
};

type RoomSettings = {
  cleaningMin: number;               // the cleaning time reserved between bookings; a room can have its own
  cleaningEnds: "staff" | "timer";   // "staff" at West 4: a room stays cleaning until someone marks it clean
  cleaningFlagMin: number;           // 8 at West 4: the board flags a room still cleaning after this
  stayOnWhenFree: boolean;           // on at West 4: with nobody booked next, a room stays on by the minute until we close
};

type BarModeSettings = {             // the same shape as in Song systems and texts
  songPriceCents: number | null;   // null at West 4: "Song price · not set · songs need a drink credit"
  drinkCredit: boolean;            // "Buy a drink, get a song": each drink bought earns one song credit; on at West 4
  freeNights: number[];            // days of the week with no song price
  songsPerRound: number;           // songs per singer per round: 1 at West 4
  alerts: { beforeYou: number; upNextText: boolean };   // a push at 2 singers before you, and the "You're up next" text
  upNextCount: number;             // singers the TV shows after the one singing: 5
};

type AlertSettings = {
  roomEndingMin: number;             // 10: a tile turns amber, and "Please wrap up" or "Booked time ending" goes out,
};                                   // this long before the booked end; it turns red once the room runs over

type PhoneSettings = {
  callNumber: string;                // E.164: on the site, in texts, behind every Call button and "Call to book"
  textNumber: string;                // E.164: the Twilio number texts come from, which can be the call number itself
};

type WebsiteSettings = {
  priceWording: "plusTaxAndGratuity" | "allIn";
      // "plusTaxAndGratuity" at West 4: "$10 a person an hour, plus tax and a 20% gratuity". "allIn" shows totals that
      // include them, ready in case the lawyer says NYC's junk-fee rules need it (Open technical questions)
};

type MessageSettings = {
  reminderAt: string | null;         // local time on the day of the booking for the Reminder text ("afternoon of"); null: not set, no Reminder goes out (D87)
  offerExpiringMin: number;          // 5: "Offer expiring" goes out with 5 minutes left to claim the room
};

type SafetySettings = {
  occupancyLimit: number | null;     // the posted limit from the certificate of occupancy or place of assembly permit.
                                     // null at West 4: the board shows "Limit not set · Admin → Safety". Never guessed or defaulted
  warnAtPct: number;                 // 90: the board warns when everyone inside reaches this share of the limit
};

type LanguageSettings = {
  staff: ("en" | "es")[];            // ["en", "es"] at West 4: offered on sign-in and in Admin → Team. Each person's pick is
};                                   // memberships.locale; Korean and Chinese staff screens come in phase 2
```

The screens that disagreed now read these shapes. The VIP rate applies from 20 guests, and every screen takes the big-party deposit and refund window from the one `bigParty` rule, whose deposit is flat or a percent: West 4's rule is a flat $250 from 20 guests with the usual 24-hour refund window, and every West 4 screen shows it; the percent kind (say 25% of a $1,200 minimum with 7 days' notice) is for venues that sell buyouts. Minimum spend lives only in `prices.minSpend`: where one is set, the tile, DeskRoom and the room page show what's left ("$84 to your minimum"), and a shortfall becomes a `min_spend` line at close. It's off at West 4, so West 4's screens show nothing and Admin shows it off. Happy hours and specials are dated `price_rules`, and packages are rows checked against the rule pack.

**Training mode** is switched per person (`memberships.training`) or per device (`devices.training`) in Admin → Team → Training mode, and is off for everyone at West 4. While it's on, every screen shows a permanent "TRAINING · not real money" band, practice checks are numbered T-… from their own counter, and they pay only through Stripe's sandbox, never the live account ([Security and data retention](12-security-retention.md) 15).

**Rule packs.** A rule pack is versioned data for one place, picked from the venue's address at setup. Money math and settings screens read limits only from here, never from code.

```ts
const newYorkCounty: RulePack = {
  id: "us-ny-new-york-county",
  version: "2026.09",
  timeZone: "America/New_York",
  alcohol: {
    lastSale: "04:00", firstSale: "08:00",       // wall-clock times, resolved for each business date
    drinkingUpMin: 30, drinkingUpFrom: "windowClose",   // how drinking-up is measured is open with the lawyer; this is the cautious default
    promotions: { freeDrinks: false, multipleForOne: "eachAtLeastHalfPrice", hourlyAlcohol: false, privateFunctionException: false },   // false until the lawyer answers
  },
  salesTax: { rate: 0.08875, jurisdictionCode: "…", surchargeTaxable: true,      // the code and the surcharge rule come from the accountant
              taxedCategories: ["room_time", "drink", "damage"] },              // what the rate taxes (Money rules 8); fee stays untaxed
                                                                                // until the accountant answers. Added in version 2026.10
  wages: { region: "nyc", minimumCents: 1700, tippedCashCents: 1135, tipCreditCents: 565 },
  cardFee: {
    surcharge: { creditOnly: true, cap: "inPersonCardCost", networkCapPct: 3, noticeDays: 30, showCreditPrice: true },
    discount: { allowed: true },
  },
  gratuity: { label: "Gratuity", staffOnly: true, managersShare: false, eligibility: "dutiesWorked" },
  cash: { mustAccept: true },
  idScan: { fields: ["name", "dateOfBirth", "idNumber", "expiration"], keepDays: 7 },   // until the lawyer answers
  texting: { marketingFrom: "08:00", marketingTo: "21:00", clock: "recipient" },
  retention: { tipRecordsYears: 6, guestChecksYears: 3, incidentsYears: 3 },
};
```

A new version needs two people on our side to approve it in the Console, is signed, and takes effect at a business-date boundary on its effective date. Admin shows every venue using the pack what changes and when, before it applies, and each check revision stores the version it was priced with.

- **The alcohol window.** `alcohol_window(venue, at)` is open until the earlier of the pack's last sale and the venue's `lastCall`, resolved as wall-clock time in the venue's time zone for that business date. It is never worked out as opening time plus 14 hours, which is an hour off on daylight-saving nights. It stays closed until the pack's `firstSale` on the calendar day it closed (8:00 AM in New York, "from 4 to 8 AM" in Staff screens). The clear-out check is due at the window's close plus `drinkingUpMin` (4:30 AM at West 4). Money rules say what it stops.
- **Promotion checks.** Saving a package, special or menu item runs the pack's checks: alcohol in a package comes in a fixed quantity, no hourly price includes alcohol, a promotional price is at least half the regular one, and no alcohol item costs $0. Comps stay allowed with a reason and are never advertised, and the website hides any promotion the checks refuse until the lawyer clears it. A package that relies on the private-function exception needs a lawyer-defined flag on the booking.
- **Still with the lawyer:** drinking-up timing, keeping and sharing ID scans, debit under a cash discount, whether NYC's junk-fee rules cover the automatic gratuity, and the promotion questions, all in [Open technical questions](14-open-questions.md).

**Modules.** `venue_modules (venue_id, module_id, allowed, state)`: the Console's module allow-list sets `allowed` from the plan and add-ons, and the venue's Admin → Features moves `state` between on, stopping and off. Stopping takes no new bookings, tabs or waitlist entries but still lets existing ones be viewed, closed, cancelled and refunded. Off is refused while the module has open sessions or tabs. The API enforces this on every route with `404 module_off`, except guest routes for existing bookings (manage, cancel and refund status), which always work. Turning a module off hides its screens and website sections but never deletes data. The four core modules are always on: Payments & checks, Alcohol controls & rule pack, Admin & settings, and Devices & printers. Dependencies follow the blueprint:

| Module | Needs |
| --- | --- |
| Online booking & deposits, Packages & specials, Song system control, Event sales | Rooms & room clock |
| Ordering from the room | Rooms & room clock, and Bar screen & tickets |
| Bar mode | Bar tabs & quick sale |
| Marketing texts | Guest texts |

A module can be on only while what it needs is on. Turning one off that others need lists them ("These turn off with it: …") and turns them off too after a confirm. Turning off Bar screen & tickets while Ordering from the room is on asks: **"Room orders would have nowhere to ring. Turn off Ordering from the room too?"**

**What each module hides.** Admin → Features shows this table, and every screen reads it, so a module that's off disappears from staff menus, phone tabs, the website and texts at once. Guest links for existing bookings, waitlist spots, receipts and payments keep working whatever is off.

| Module | Staff app (desktop and bar POS) | Staff phone | Website and room page | Texts |
| --- | --- | --- | --- | --- |
| Rooms & room clock | Tonight (the board), DeskRoom, Calendar, the Rooms list on the bar POS | Tonight, Rooms, Calendar | The Rooms section; room tablets | Booking confirmed, Reminder, Room code, Please wrap up, Booked time ending, Running late reply |
| Online booking & deposits | Admin → Deposits & cancelling reads "Online booking is off" | — | The Book section and new bookings on the manage page; the hero's "Book a room" becomes "Call to book" | Payment link, and Deposit refund for new bookings |
| Walk-in waitlist | The board's waitlist drawer | Waitlist | The door QR and the waitlist page | Room ready, Offer expiring |
| Ordering from the room | — (room orders stop arriving) | — | The menu, ordering and Same again on the room page and tablets | — |
| Bar screen & tickets | Bar orders, the room-order cards on the bar POS, tickets | Runs | — | — |
| Bar tabs & quick sale | New tab, bar tabs and Quick sale on the bar POS | Tips to enter | — | — |
| Bar mode | Song queue (the KJ screen) and "Song queue · N" on the bar POS; the Up next TV | — | "Sing at the bar" and the singer's queue page | You're up next |
| Packages & specials | Packages on the staff menus | — | Packages and happy-hour lines on the menu page and PDF | — |
| Song system control | Admin → Song system (phase 1 runs every system as `none`) | — | — | — |
| Guest texts | Messages; "Text" buttons become "Call" | Messages | — | All 12 service texts |
| Marketing texts | — | — | The booking page's marketing opt-in | Review ask, Birthday |
| Team, time clock & tips | The time clock and the tip pool at Close the night | Clock in and out, My tips | — | — |
| Safety & ID records | The board's "Manager needed" pin and headcount, the door counter, ID scans (the "IDs checked" count stays) | The incident log | The help link on the room page | — |
| Reports & accounting | Reports and exports (the Z report stays, under Payments & checks) | Reports | — | — |
| Website | — | — | The public pages: home, rooms, menu and PDF, parties and enquiries, songs | — |

Kitchen & food, Event sales, Guests, loyalty & gift cards, and Multiple locations are phase 2 or later, so no phase 1 screen shows them.

Beta and rollout switches are separate from modules: `venue_flags (venue_id, flag, on, set_by)`, read by the API and the screens, with our own test venue first in line.

**Plan billing** runs on Stripe Billing in our own platform account, with one `venue_subscriptions (venue_id, plan, stripe_subscription_id, room_quantity, status)` row per venue. The per-room fee counts every room that isn't archived, so a room switched off for the night still counts. Add-ons become subscription items once they have prices. Billing events from our own account arrive on their own webhook endpoint. A failed plan payment shows a banner, then makes Admin read-only after 14 days; the board, rooms, bar and payments never switch off during opening hours.
