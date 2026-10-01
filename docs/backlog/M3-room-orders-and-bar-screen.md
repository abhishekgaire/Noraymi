# M3 · Room orders and the bar screen

The backlog for [M3 · Room orders and the bar screen](../milestones.md#m3--room-orders-and-the-bar-screen), ticket by ticket. The [spec](../spec/README.md) decides how each piece works, [screens](../screens.md) says where to build differently from the frozen canvas, and the [demo seed](../demo-seed.md) supplies the names and numbers in every check. Where a ticket had to pick something the spec doesn't say, its Notes say so and name the cautious default it builds.

## Goal

A mock Friday of room orders: they ring, print, get carried, get cut off and stop at 4 AM.

## Done when

Copied from [milestones.md](../milestones.md#m3--room-orders-and-the-bar-screen):

- A mock Friday in staging, run by two people on the demo seed: every order from a tablet and from a phone rings on Bar and the board, prints on the bar printer (one network printer and one USB), moves through the six steps with the same words on every screen, and joins the right check at Accept. Room 9's drinks read $158.00, and the ringing 2 × Margarita · Peach isn't on the tab until it's accepted.
- On a simulated clock, an order nobody accepts buzzes bar phones at 30 s, shows on the board at 2 min ("on Andy's phone" at 4) and texts Andy at 6.
- Unplugging the bar printer shows "Ticket didn't print · Reprint", and the reprint says "REPRINT 2".
- At 4:00:00 AM (simulated, on a normal night and both daylight-saving nights), every alcohol button greys out, an unaccepted alcohol order cancels itself and the room reads "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged", and every alcohol route answers `409 alcohol_closed`. At 4:30 the board asks for the clear-out check, and [Done] records "Clear-out check · Andy · 4:31 AM".
- Cutting off a room, and cutting off one guest, blocks alcohol from the room page, host orders and staff orders, shows "Cut off by Andy at 10:30 PM" on every screen for that room, and logs each refusal.
- Reason-only comps add up per person across every screen (Maya's $12 so far tonight leaves "$63 left this shift"). A void over $25 goes to Andy's inbox, the requester sees "Waiting for Andy", and Andy decides on his own phone.
- A package or price rule that breaks the promotion checks can't be saved. The menu PDF matches the menu within a minute of a save.
- Same again re-orders the room's last delivered round, and it still rings the bar.

**Depends on:** M2.

**Size:** milestones.md plans 2–3 weeks. These 25 tickets are 9 S and 16 M: about 37 to 57 working days at S = ½–1 day and M = 2–3 days.

## Suggested order

Ticket numbers follow the dependencies, so working top to bottom is always safe. Tickets on one line can run side by side once the line before is done.

1. The alcohol and promotion rules, test-first: M3-01 and M3-02.
2. The menu: M3-03, then M3-04 and M3-05.
3. Orders: M3-06, then M3-07.
4. The guest side: M3-08, M3-09, then M3-10, M3-11 and M3-12.
5. Tickets: M3-13, then M3-14. Have one network printer and one USB printer on hand.
6. The bar and the runners: M3-15, M3-16, M3-17, M3-18.
7. Comps and voids: M3-19.
8. Alcohol controls: M3-20, then M3-21, M3-22 and M3-23.
9. Accessibility and the mock Friday: M3-24, then M3-25.

Definition of done: see CLAUDE.md.

## Tickets

### M3-01 · Write the alcohol-window and clear-out rules test-first

- **Status:** done
- **Size:** S
- **Depends on:** M1-04, M1-10, M1-12
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Rule packs (The alcohol window); [Money rules](../spec/05-money-rules.md) 2 and 5; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Ringing ("from 4 to 8 AM"); [Testing and operations](../spec/13-testing-operations.md) · Tests (clock tests); [Open technical questions](../spec/14-open-questions.md)
- **Build:**
  - `alcoholWindow(venue, at)` in `packages/rules`: open until the earlier of the rule pack's `alcohol.lastSale` and the venue's `hours.lastCall`, resolved as wall-clock time in the venue's zone for that business date, never as opening time plus 14 hours. Closed from then until 8:00 AM. It returns the state and the next instant it changes, which every screen reads so all of them grey alcohol at the same moment.
  - `clearOutDue(venue, businessDate)`: the window's close plus `alcohol.drinkingUpMin` (30 minutes), 4:30 AM at West 4.
- **Acceptance:**
  - [x] On business date Fri Sep 25, 2026 the window is open at 3:59:59 AM on Sat Sep 26 and closed at 4:00:00 AM, and the clear-out check is due at 4:30 AM.
  - [x] On the fall-back night (business date Sat Oct 31, 2026) it closes at 4:00 AM EST on Nov 1; on the spring-forward night (business date Sat Mar 13, 2027) at 4:00 AM EDT on Mar 14, not at 5:00 AM as opening time plus 14 hours would give.
  - [x] With a house last call of 3:00 AM the window closes at 3:00 AM.
  - [x] From 4:00 to 8:00 AM the window stays closed.
- **Tests:** unit tests on a normal night and both daylight-saving nights, written first.
- **Notes:** Spec 03's rule-pack shape has no time for the first sale after the close, while spec 10 greys alcohol "from 4 to 8 AM"; this adds `alcohol.firstSale: "08:00"` to the pack's data, not to code (flagged for spec 03). How drinking-up time is measured is open with the lawyer and blocks the gate; the cautious default is built as pack data (`alcohol.drinkingUpFrom: "windowClose"`): from the window's close, the earlier of the county close and the house last call, so the clear-out check is never late. At West 4 both readings give 4:30 AM.
  - Built: `alcoholWindow`, `clearOutDue` and `windowClose` in `packages/rules/src/alcohol-window.ts`, tests in `alcohol-window.test.ts` (normal night, both daylight-saving nights, a 3:00 AM house last call, 4–8 AM closed across the 6:00 AM cutover). `alcohol.firstSale: "08:00"` and `alcohol.drinkingUpFrom: "windowClose"` added to the New York County pack (`packages/shared/src/rule-pack.ts`) and to spec 03's pack and alcohol-window text.
  - The venue argument takes `hours.lastCall` and the pack's alcohol block, so callers load both; `changesAt` is the next instant the state flips, `closesAt` the close of the current or last window.

### M3-02 · Write the promotion checks test-first

- **Status:** done
- **Size:** S
- **Depends on:** M1-10
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Rule packs (Promotion checks); [Data model](../spec/04-data-model.md) · `packages`, `price_rules`; [Open technical questions](../spec/14-open-questions.md)
- **Build:** `promotionChecks(thing, menu, pack)` in `packages/rules`, run on menu items, packages and dated price rules:
  - alcohol in a package comes in a fixed quantity;
  - no hourly price includes alcohol;
  - a promotional price is at least half the regular one (`promotions.multipleForOne: "eachAtLeastHalfPrice"`);
  - no alcohol item costs $0 (`promotions.freeDrinks: false`);
  - a package that relies on the private-function exception (`packages.private_function_only`) is refused until the lawyer defines the flag it needs on the booking.
  - Each refusal gives its reason in words. Comps stay allowed with a reason and are never advertised; the website hides any promotion the checks refuse (M5).
- **Acceptance:**
  - [x] A package "Open bar · 2 hours" with no fixed quantity of drinks is refused with the reason.
  - [x] An hourly price that includes drinks is refused.
  - [x] A happy-hour Margarita (regular $13.00) at $6.00 is refused and at $6.50 allowed; two Jäger Bombs (regular $12.00 each) for $12.00 are allowed, and for $11.00 refused.
  - [x] An alcohol item priced $0.00 is refused, while a comp with a reason still goes through.
  - [x] A package marked `private_function_only` is refused.
- **Tests:** a passing and a failing fixture for every check, written first.
- **Notes:** Whether the private-function exception covers a drink package is open with the lawyer; until then the checks refuse such a package, as spec 14 says for M3, and the rule lives in the pack's data (`promotions.privateFunctionException: false`) so the answer becomes a pack change (flagged). A free drink with a song is M6's question.
  - Built: `promotionChecks(thing, menu, pack)` in `packages/rules/src/promotions.ts` with `promotions.test.ts`. A thing is a `menuItem` (every variant price), a `package` (contents with a quantity or null, `hourly`, `privateFunctionOnly`), a `priceRule` (target items, how many the price buys together, `priceCents` or a whole-number `pctOff`) or a `comp` (needs a reason). Each refusal has a code (for the i18n catalogs when Admin → Menu shows it, M3-04) and an English message naming the item and, for half price, the lowest allowed price.
  - `alcohol.promotions.privateFunctionException: false` added to the New York County pack and spec 03.
  - A non-alcohol item in a package may have no fixed quantity (a soda refill); the quantity rule is for alcohol only.

### M3-03 · Build the menu tables, the menu API and 86

- **Status:** done
- **Size:** M
- **Depends on:** M1-09, M1-13, M1-14, M3-02
- **Spec:** [Data model](../spec/04-data-model.md) · Menu, orders and songs; [API](../spec/08-api.md) · Menu; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · 86 from the bar POS; [Glossary · 86](../glossary.md#orders-and-the-bar); [Demo seed · West 4 and its rules](../demo-seed.md#west-4-and-its-rules); [Rail](../screens.md#rail) note 12; [Menu](../screens.md#menu) note 3
- **Build:**
  - `menu_categories` (venue_id, name, sort, tax_category), `menu_items` (venue_id, category_id, name, button_name, description, alcohol, station, shown, out_until), `menu_variants` and `menu_options` (item_id, name, price_cents or price_delta_cents, out_until), `modifier_groups` (item_id, name, required, min_choices, max_choices), `packages` (name, price_cents, contents, private_function_only, checked_pack_version) and `price_rules` (name, kind, days, from_min, to_min, target, pct_off or price_cents, starts_on, ends_on).
  - Staff routes: `GET`, `POST` and `PATCH` on `/menu/categories`, `/menu/items`, `/menu/variants`, `/menu/options`, `/menu/modifier-groups`, `/packages` and `/price-rules`. Saving runs the promotion checks (M3-02) and refuses with the reason; a save sends `menu.changed`. The Packages & specials module gates packages and price rules.
  - 86: `POST /menu/items/{i}/out-tonight` for an item, a variant or a flavor. It greys out in its slot, marked "86'd tonight", on every staff screen and the guest menu, until someone taps it again or the night closes. Owners, managers, bartenders and the front desk covering the bar can 86 an item.
  - Public: `GET /v1/public/venues/{slug}/menu`.
  - The seed's menu: 127 lines in 9 sections (Beer, Soju, Cocktails, Shots, Spirits, Wine, Soft drinks, Bottles, Buckets), with its option groups, and Hoegaarden, Casamigos Blanco and Casamigos · bottle out tonight.
- **Acceptance:**
  - [x] The seed's 127 lines load in 9 sections; a Margarita asks for its flavor (Raspberry, Peach or Strawberry), and Tito's rings on the rocks unless changed.
  - [x] Hoegaarden, Casamigos Blanco and Casamigos · bottle show "86'd tonight" in place, on staff screens and the guest menu.
  - [x] 86'ing Bud Light greys it everywhere at once, and it comes back when someone taps it again, or at 6:00 AM.
  - [x] A runner's 86 answers `403`.
  - [x] A package that fails a promotion check isn't saved, and the answer gives the reason.
- **Tests:** API integration tests; the promotion checks on each save route.
- **Notes:** `out_until` clears when the night closes, which comes in M7; until then it's set to the end of the business date (6:00 AM), and M7's close clears it sooner (flagged). The seed has no packages or price rules, so tests bring their own. Allergen fields are phase 2.
  - Built: migration `0043_menu.sql` (seven tables, row-level security forced, audited); `packages/db/src/menu.ts` (one whitelisted insert and patch for every table, `menuTree` with 86 worked out at the venue's clock, `promoMenu`, `setOutTonight`); `apps/api/src/routes/menu.ts`; the seed loader's menu (`packages/db/src/seed.ts`); `apps/api/src/routes/menu.int.test.ts`; the principal and wall suites cover every new route.
  - Every item has at least one variant, which carries its price; the seed gives each item one "Regular" variant. A choice (`menu_options`) belongs to a modifier group (`group_id`) and can be the default (`is_default`), so Tito's rings on the rocks; a spirit's mixers are a second, optional "Mixer" group (Red Bull +$6.00 as the seed has it). Each item gets its own copy of a shared seed group. Spec 04 updated.
  - `GET /menu` (the whole tree) is added beside the seven lists, so screens read one call; spec 08 updated. Variants, options and modifier-group lists take `?item_id=`.
  - Saves run the checks on the saved state inside the transaction, and a refusal rolls it back: `400 invalid_request` with the reasons in the message and `details.refusals` (each with its code). Packages and price rules are stamped with the pack version they passed.
  - 86 is `POST /menu/items/{i}/out-tonight` with `{ out?, variant_id?, option_id? }`; `out: false` brings it back. It needs `orders.accept` (owners, managers, bartenders, front desk), so a runner gets 403. `out_until` is the next 6:00 AM cutover until M7's close clears it sooner.
  - Price-rule kinds are `happy_hour`, `special` and `hourly`; an `hourly` rule is the "hourly price" the checks refuse with alcohol in it.
  - The "86'd tonight" label is a screen string, added with the screens that show it (M3-04, M3-07, M3-09).
  - The rule pack's data changed in M3-01 to M3-03 without a version bump, since the pack isn't live anywhere yet; a local database loaded before then needs `pnpm db:reset` then `pnpm seed` to pick up `firstSale` and `privateFunctionException`.

### M3-04 · Build Admin → Menu

- **Status:** done
- **Size:** M
- **Depends on:** M1-31, M3-03
- **Spec:** [AdminDesk](../screens.md#admindesk) notes 3 and 15; [Admin by milestone](../milestones.md#admin-by-milestone) (Menu); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Admin → Bar POS (button names are edited in Admin → Menu); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Promotion checks
- **Build:** the menu editor: categories and their tax categories; items with variants and options; modifier groups (required choices and shared add-ons); the short button name (`button_name`, the bar POS grid's label, while tickets and receipts print the full name); the alcohol flag; shown or hidden; out tonight; packages; and dated price rules for happy hours and specials, in place of the canvas's free-text "Happy hour line". Every save runs the promotion checks and shows the reason for a refusal. Nothing reaches the website, the room screens or the PDF until Save.
- **Acceptance:**
  - [x] Every item has a Button name and an Alcohol column; renaming Margarita's button to "Marg" leaves tickets and receipts printing "Margarita".
  - [x] A Friday happy hour for Margaritas at $6.00 from 8 PM is refused with its reason, and $6.50 saves.
  - [x] Hiding an item takes it off the guest menu and every staff menu after Save.
  - [x] With Packages & specials off, packages and price rules are hidden in Admin and on every menu.
- **Tests:** Playwright for each part of the editor, including the refused saves.
- **Notes:** The public menu page (HTML with the PDF) is M5 and reads the same list.
  - Built: `apps/staff/src/screens/admin/Menu.tsx` (Admin → Menu, after Rooms in the section list), its English and Spanish strings (`menuAdmin.*`), and the Playwright test "Admin → Menu" in `e2e/staff.spec.ts`; `/admin/menu` joins the Spanish and clipped-text checks.
  - Each category is a table of its items: name (with its choice groups), Button name (the full name greyed when there's none), price per size, Alcohol, shown or hidden, and Tonight (86'd tonight, 86 or Back on, and Edit). Edit opens the item's editor below its row: full name, button name, category, description, alcohol, shown, sizes and prices, choice groups and their choices (extra price, the one that rings unless changed). Nothing is sent until Save; then the edits go one call at a time and a refusal shows the server's reason.
  - Packages and happy hours (Packages & specials on): a list with Shown/Hidden, an Add a package form (items with a quantity, or "As many as they like", priced by the hour, only for private functions) and an Add a happy hour or special form (kind, item, how many for the price, days, from and until, a set price or a percentage off, start and end dates). Editing an existing package or rule beyond Shown is left for when a venue needs it; a new one replaces it.
  - `GET /menu` now leaves hidden items out unless `?include_hidden=true` (Admin asks for them), so hiding an item takes it off every staff menu and the guest menu.
  - "Tickets and receipts print Margarita": tickets (M3-13) and receipts (M4) don't exist yet; the test checks the item keeps its full name with the button renamed, and those tickets print `name`.
  - 86 from Admin takes effect at once (it's the bar's 86, not a menu edit).
  - Venue words (item, category and choice-group names) are marked `data-guest-text` so the Spanish check treats them as data.

### M3-05 · Render the menu PDF on every menu change

- **Status:** done
- **Size:** S
- **Depends on:** M1-06, M2-13, M3-03
- **Spec:** [Scope and architecture](../spec/01-scope-architecture.md) · Files and PDFs; [Menu](../screens.md#menu) note 4; [Security and data retention](../spec/12-security-retention.md) 14 and How long we keep things (Files)
- **Build:** a job in the bulk pool that renders the same menu list the room page reads, from HTML to a tagged, accessible PDF, on every `menu.changed`. A burst of saves renders once (deduped). The PDF is stored as a file and kept until the next one replaces it, and a route returns a link to the current one.
- **Acceptance:**
  - [x] Within a minute of a price change saved in Admin → Menu, the PDF shows the new price.
  - [x] The PDF lists the same items and prices as the menu API, and a hidden item isn't in it.
  - [x] The PDF passes a tagged-PDF check: real text, headings and reading order.
  - [x] Ten saves in a row render one PDF.
- **Tests:** a job test that compares the PDF's text with the menu API; a PDF accessibility check in CI.
- **Notes:** The spec doesn't say whether the PDF shows tonight's 86'd items. Cautious reading: it's the menu, and 86 lasts one night, so 86 doesn't change it (flagged).
  - Built: `apps/api/src/menu/pdf.ts` (the menu as HTML, printed by Chromium through `playwright-core` with `tagged` and `outline` on), the `menu.pdf` job in the bulk pool (`apps/api/src/jobs/menu-pdf.ts`), `queueMenuPdf` and `currentMenuPdf` in `packages/db/src/menu.ts`, the links `GET /v1/venues/{v}/menu/pdf` and `GET /v1/public/venues/{slug}/menu/pdf` (a 5-minute signed link, or 404 until the first render), and `apps/api/src/jobs/menu-pdf.int.test.ts`.
  - One render per burst: a save queues the job 5 seconds out unless one is already waiting, and the job renders the menu as it stands when it runs. Each render is a new `menu_pdf` file; the one before is marked removed and its object deleted.
  - The PDF has the venue's name as its heading, one section per category in menu order, each item with its price (or each size's), description, and choices with any extra price. Packages and happy hours aren't on it yet; they join with the public menu page (M5), behind the Packages & specials module.
  - The accessibility check reads the PDF with `pdfjs-dist`: its text has every shown item and price the menu API gives, and its structure tree has the document, H1, H2, lists, list items and paragraphs, in menu order. Chromium's catalog doesn't expose a `Marked` flag that pdf.js reads, so the check is on the structure tree itself.
  - Infrastructure: the API image installs Alpine's `chromium` and `font-noto` and sets `MENU_PDF_CHROMIUM=/usr/bin/chromium`; CI's integration job installs Playwright's Chromium. `electron-winstaller` (the desktop app's Windows installer helper) is now explicitly blocked from running its install script in `pnpm-workspace.yaml`, since pnpm refused the install while it was unlisted.
  - The offers test (`apps/api/src/routes/offers.int.test.ts`, "with 5 minutes left…") fails about one run in three with or without this ticket; left as it is and flagged.

### M3-06 · Build the order pipeline, with Accept as the sale

- **Status:** done
- **Size:** M
- **Depends on:** M1-09, M2-08, M2-15, M3-03
- **Spec:** [Data model](../spec/04-data-model.md) · `orders`, `order_items`, `print_jobs`, Room orders; [Money rules](../spec/05-money-rules.md) 6; [API](../spec/08-api.md) · Orders, Live events; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Words on every staff screen; [Glossary · Order statuses](../glossary.md#order-statuses)
- **Build:**
  - `orders` with every column in the data model, and `order_items` (venue_id, order_id, variant_id, options, qty, unit_cents, name_snapshot, alcohol, notes): prices and the alcohol flag copied at order time.
  - The statuses `ringing`, `held`, `accepted`, `ready`, `on_the_way`, `delivered`, `returned` and `cancelled`, and `cancel_reason` `guest`, `staff`, `declined`, `alcohol_closed` or `cut_off`. Each step is its own call that checks the step before it: `POST /orders/{o}/accept`, `/hold`, `/ready`, `/claim`, `/deliver`, `/return`, `/resolve`, `/cancel` and `/decline`.
  - Accept is the sale: the order's lines join the check at that moment (`item` lines with the item's tax category and `source_id` the order item), `accepted_by` is whoever is signed in, and a `print_jobs` row is made for the station's printer. `print_jobs` (venue_id, device_id, order_id or check_id, kind, payload, status, job_token, reprint_of, reprint_n, created_at, confirmed_at) is printed by M3-13 and M3-14.
  - Held ("Ask the room to wait") keeps the order in Waiting, still aging and still needing Accept. Ready, claim and Deliver answer `409` on an order that isn't accepted. Deliver never charges.
  - Cancel works only while an order is ringing or held: for the guest who placed it, the host, or staff for the guest. Decline needs a reason the guest sees. There's no Decline after the alcohol window closes (M3-22).
  - Return takes the runner's reason (`no_id`, `too_drunk`, `nobody_there` or `other`) and tells the manager on duty. Resolve takes `void_not_made` or `void_made` (a VOID line with its `made` flag) or `remake` (back to accepted with a new ticket, nothing charged again).
  - `GET /orders?status=`: `ringing,held` is the bar's Waiting list and `ready,on_the_way` every phone's Runs. The events `order.ringing`, `order.held`, `order.accepted`, `order.cancelled`, `order.ready`, `order.claimed`, `order.delivered` and `order.returned`.
- **Acceptance:**
  - [x] Accepting o1 (2 × Margarita · Peach) puts it on Room 9's check at that moment: drinks go from $158.00 to $184.00 and the tab so far from $480.00 to $506.00, and a ticket job is made.
  - [x] Asking the room to wait on o2 (Room 5, 4 × Bud Light) keeps it in Waiting and aging, and Ready, claim and Deliver on it answer `409`.
  - [x] The guest can cancel o1 while it's ringing or held, and not once it's accepted; nothing is charged.
  - [x] A decline with no reason is refused; with "Out of peach" the guest sees "The bar couldn't take this order · nothing charged" and the reason.
  - [x] Resolving a return as `void_made` writes a VOID line with `made` true; `remake` makes a new ticket job and no new line.
  - [x] A price change after an order is placed doesn't change that order.
- **Tests:** a state-machine test that tries every step from every status; integration tests for each route and event.
- **Notes:** The spec doesn't say whether a void that resolves a returned order counts against the reason-only limit (money-cases A2, the seed's o4). Cautious default built here: it counts like any void, so o4's $36.00 void waits for approval (flagged). An order accepted after the check is presented or paid is M4's (`409 ordering_closed`, and a new check after payment).
  - Built: the state machine `orderStep` in `packages/rules/src/orders.ts` (every step from every status tested, 82 cases); migration `0044_orders.sql` (`orders`, `order_items`, `print_jobs`, row-level security forced, audited); `packages/db/src/orders.ts` (reads, `insertOrder`, the guarded `moveOrder`, `insertPrintJob`); `apps/api/src/orders/pipeline.ts` (each step, Accept as the sale, the void executor for approvals); `apps/api/src/routes/orders.ts`; the guest and staff words for every status in both catalogs with `guestOrderWords` and `staffOrderWordsKey` in `packages/shared/src/orders.ts`; the seed's seven orders (o1 and o2 ringing, o3 and o4 ready with printed tickets, three delivered), each accepted one's check lines pointing at its order items (`source_id`); `apps/api/src/routes/orders.int.test.ts`.
  - A step from the wrong status, or one someone else took first, answers `409 version_conflict` with the order's status in `details` (spec 08 updated). Each write only lands while the order still has the status the step started from, so two bartenders can't both accept.
  - Accept writes one `item` line per order item ("Margarita · Peach", the price with any choice's extra), `source_id` the order item, `added_by` the person, then one ticket job per station (unassigned to a printer until M3-13 routes it), `order.accepted` on the room's channel and `check.updated`.
  - Columns beyond the data model's list, added to spec 04: `orders.placed_at`, `business_date`, `version`, `returned_note`; `order_items.item_id`, `tax_category`, `station` (copied at order time like the price); `print_jobs.station`.
  - Cancel takes `for: "guest"` (the guest, the host, or staff asking for them) or `"staff"`; the guest's own route is M3-09 and calls the same step. Decline and Accept after 4 AM and the cut-offs are M3-20 to M3-22; an order on a presented or paid check is M4's.
  - Return pushes "Room 9: couldn't serve · No ID" to the manager on duty. Resolve `void_not_made` or `void_made` writes a VOID line for each of the order's item lines (reversing it, with `made`), and counts against the reason-only limit like any void (the cautious default in the ticket): o4's $36.00 waits for approval, and the approver's phone runs the `void` executor. `remake` goes back to accepted with a new ticket marked as a remake and nothing charged again.
  - The steps need `orders.accept` (the bar's: accept, hold, ready, cancel, decline, resolve) or `runs.carry` (a runner's: claim, deliver, return). Orders sit under the core module, since staff orders run whatever room ordering's state.
  - The seed gives the earlier delivered orders' delivery time only, so it stands in for when they were placed and accepted.

### M3-07 · Add drinks to a room from the staff screens, with unsent drinks saved

- **Status:** done
- **Size:** M
- **Depends on:** M2-31, M3-06
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Adding drinks to a room from a staff screen, rules 3 and 8; [API](../spec/08-api.md) · Orders (`POST /checks/{c}/orders`), Bar POS (`GET` and `PUT /drafts/{key}`); [Data model](../spec/04-data-model.md) · `order_drafts`; [Room](../screens.md#room) note 3; [DeskRoom](../screens.md#deskroom) note 4
- **Build:**
  - The room tab on desktop (DeskRoom) and phone (Room) adds drinks through the same menu search as the bar POS, with variants, required choices, 86 and the alcohol window. A drink rings with its usual options already set; a choice with no sensible default turns the line amber, and the send button names what's missing. No generic quick-add chips such as "+ Cocktail $12".
  - `POST /checks/{c}/orders` creates a staff order (`source` `staff`, `placed_by`) that's accepted as it's placed, so its lines go on the room's check and a ticket prints at the bar; then it runs Being made, Ready and a runner like any room order.
  - Unsent drinks are saved as they're rung: `order_drafts` (venue_id, membership_id, check_id, device_id, lines, version, updated_at) through `GET` and `PUT /drafts/{key}` with its version, and `draft.updated` so a person's unsent drinks follow them to their other screens. A draft is never part of a check and clears when it's sent.
- **Acceptance:**
  - [x] From DeskRoom, Maya adds 2 × Margarita to Room 9: the line stays amber until she picks Peach, and Send names the missing flavor.
  - [x] Send puts the drinks on Room 9's check at once and prints a ticket, and the order then shows Being made and runs like any room order.
  - [x] Hoegaarden shows "86'd tonight" and can't be added.
  - [x] Maya's unsent drinks survive a reload and follow her to the Room phone, and never show on the check.
- **Tests:** Playwright on desktop and phone sizes; an API test for the draft's version check.
- **Notes:** The bar POS, its quick sale and "Open in the bar POS" come in M6, which reuses `order_drafts` for tabs and quick sale (the seed's draft, Diego's Red Bull, sits on Tariq A.'s check and loads in M3-25). Clearing drafts at the night close is M7.
  - Built: migration `0045_order_drafts.sql` (one draft per person per tab, or the quick sale, unique even with no check); `packages/db/src/drafts.ts` and `orderableVariant` in `packages/db/src/menu.ts`; `apps/api/src/orders/place.ts` (a staff order, checked against the menu as it is now, accepted as placed); `apps/api/src/routes/drafts.ts` (`POST /checks/{c}/orders`, `GET` and `PUT /drafts/{key}`); `apps/staff/src/screens/AddDrinks.tsx` on DeskRoom and the Room phone, below the running tab; strings in both languages; `apps/api/src/routes/drafts.int.test.ts` and the Playwright test "Adding drinks to Room 9".
  - A staff order line is `{ variant_id, qty, option_ids, notes }`. The server refuses a drink that isn't shown, one that's 86'd (item, size or choice), a missing required choice ("Pick flavor for Margarita", `details.reason: "choice_missing"`) and too many choices, all as `400` with a reason; a check that isn't open answers `409 ordering_closed`. A retried send with the same `client_order_id` answers the first order. The order is accepted by whoever sent it, so its lines go on the check and a ticket job is made, and the sender's draft for that tab empties.
  - A draft's key is a check id or `quick`, per person (their membership). A PUT carries the version it read; a stale one answers `409 version_conflict` with the lines and version there now, and the screen takes those. Each save sends `draft.updated` to that person alone. The seed's draft (Diego's Red Bull on Tariq A.'s tab) still loads in M3-25.
  - On screen: search the menu, tap a drink to ring it with each choice's default already set (a spirit on the rocks), tap again for two; a line whose required choice has no default is amber and Send reads "Pick flavor for Margarita" until it's chosen; 86'd drinks show "86'd tonight", greyed and disabled. The room's open orders show under it in the glossary's words. The panel sits outside the "Running tab" region, so the tab shows only what's on the check.
  - The Playwright test checks the phone layout by reloading the same signed-in screen at 390 px wide; a second device signing in as Maya isn't part of the test (a bar computer session lives in its own tab), and the API test shows the draft is keyed by the person, not the device.
  - The alcohol window and cut-offs on this route come with M3-20; the panel doesn't grey alcohol after 4 AM yet (M3-22).

### M3-08 · Join a room with its code, on a session token that rotates

- **Status:** todo
- **Size:** M
- **Depends on:** M1-08, M2-07, M2-11, M2-18
- **Spec:** [N3 Join a room](../screens.md#n3-join-a-room); [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what (Guest in a room); [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Joining a room; [API](../spec/08-api.md) · Guest room; [Security and data retention](../spec/12-security-retention.md) 9; [Order](../screens.md#order) notes 7 and 8
- **Build:**
  - `room_guests` (venue_id, session_id, token_hash, name, is_host, joined_at, left_at, alcohol_cut_off_at, alcohol_cut_off_by, alcohol_cut_off_reason).
  - `POST /v1/public/venues/{slug}/rooms/{room}/join` trades the room's 5-character code once for a 128-bit session token in an httpOnly cookie. The Room code text's link joins whoever opens it as the host, whose token adds cancelling and the host lock; everyone who scans the wall QR and types the code joins as a friend. `resolve_room_session` (a definer function) finds the venue.
  - A wrong code says so; ten wrong codes for one room rotate its code and alert staff (the board and the manager on duty's phone). A room with no session says it's closed.
  - `token_version` rotates on a room move, a host lock or a new code: joined phones get the new code over the room channel and join again, and the old code stops working. After a move they show "You've moved to Room 11 · new code …".
  - `GET /v1/public/room-session`. Token routes answer with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and stay out of CDN logs.
- **Acceptance:**
  - [ ] Marcus T.'s Room code link joins him as Room 9's host, and a friend who scans the wall QR and types KX4M7 joins as a friend.
  - [ ] A wrong code says so, and the tenth wrong code for Room 9 rotates its code and alerts the board and Andy's phone.
  - [ ] The page for Room 11, which has no session, says the room is closed.
  - [ ] After Rob & Kim move to Room 11, their old code stops working and their joined phones show "You've moved to Room 11 · new code …".
  - [ ] The cookie is httpOnly with 128 bits, and the join route answers with no-referrer and no-store.
- **Tests:** API integration tests; Playwright on a phone for each state.
- **Notes:** The glossary fixes no words for a wrong code or a closed room; they go in the catalog for the founder to confirm (flagged). The API says the token rotates on a host lock and that "joined phones get the new code and join again"; this reads that as a new code pushed to joined phones (flagged).

### M3-09 · Build the room page: the menu, ordering and live status in the guest's words

- **Status:** todo
- **Size:** M
- **Depends on:** M3-06, M3-08
- **Spec:** [Order](../screens.md#order) notes 1, 2 and 13; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Words on every staff screen (the guest's phone column); [API](../spec/08-api.md) · Guest room (`orders`, `orders/{o}/cancel`); [Glossary · Order statuses](../glossary.md#order-statuses)
- **Build:**
  - The room page in the guest web: the menu from the public menu route, with 86'd items greyed in place and marked "86'd tonight"; required choices asked before adding ("Which one? The bar gets it on the ticket."); the cart ("Your order · not sent yet"); and `POST /v1/public/room-session/orders` with a `client_order_id`, so a retry can't order twice.
  - Each order's status comes from the server, never a timer, in the guest's words: "Sent to the bar · you can still cancel", "The bar needs a few minutes", "Being made · on your tab", "On its way to Room 9" and "Delivered"; and the side messages "Your server will come by", "The bar couldn't take this order · nothing charged" with the reason, "Cancelled · nothing charged", "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged" and "Your server has paused alcohol for this room".
  - Cancel shows only while an order is ringing or asked to wait, for the guest who placed it or the host (`POST /v1/public/room-session/orders/{o}/cancel`).
  - Live through the room channel.
- **Acceptance:**
  - [ ] Ordering 2 × Margarita · Peach from a Room 9 phone shows "Sent to the bar · you can still cancel", and the order rings on the bar orders screen and the board.
  - [ ] As the bar asks the room to wait, accepts, marks it ready, and a runner claims it and delivers it, the phone shows each of the guest's words in turn.
  - [ ] Cancel shows while the order rings and while it's asked to wait, and is gone once it's accepted.
  - [ ] Hoegaarden shows "86'd tonight" and can't be added.
- **Tests:** Playwright on a phone size, driving the bar's side through the API.
- **Notes:** "Your bill", Pay my share and confirming the card on file are M4; the private help link is M8.

### M3-10 · Add the running bill, Call staff and the host lock to the room page

- **Status:** todo
- **Size:** S
- **Depends on:** M2-20, M3-09
- **Spec:** [Order](../screens.md#order) notes 11, 12 and 13; [API](../spec/08-api.md) · Guest room (`room-session/bill`, `calls`, `lock`); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `OrderingSettings`; [Glossary · Host lock, Stay on by the minute](../glossary.md#rooms-time-and-bookings)
- **Build:**
  - "Tonight so far" from `GET /v1/public/room-session/bill`: room time with its minutes, the drinks on the tab and the tab so far, before tax and gratuity, with the per-minute rate and the deposit that comes off at settle-up.
  - The stay line: "Stay on by the minute until we close at 4 AM" when nobody's booked next, and the wrap-up message when a party is.
  - Call staff: `POST /v1/public/room-session/calls` with another mic, TV, check or other; the guest reads "Staff get it on their phones".
  - The host lock (`POST /v1/public/room-session/lock`, host only): friends can see the menu but can't send orders, and read that Marcus has locked ordering. A new session starts locked or not per `ordering.hostLockDefault`.
- **Acceptance:**
  - [ ] Room 9's page reads room time, 161 min, $322.00; drinks on your tab $158.00; tab so far $480.00, before tax and gratuity, at $2.00 a minute for 12, with the $120 deposit coming off when they settle up; the ringing margaritas aren't in it.
  - [ ] Room 9 reads "Stay on by the minute until we close at 4 AM", and Room 3's page shows the wrap-up message for Jae & co. at 11:00 PM.
  - [ ] A call for another mic reaches the board and every staff phone's Calls list, and the guest reads "Staff get it on their phones".
  - [ ] With Marcus's host lock on, a friend's order is refused and their page says Marcus has locked ordering.
- **Tests:** Playwright on a phone size; API tests for the lock.
- **Notes:** Order note 11 replaces "Room 9 lights up on the bar screen with your reason". Minimum spend ("$84 to your minimum") is M4 and off at West 4.

### M3-11 · Add Same again to the room page

- **Status:** todo
- **Size:** S
- **Depends on:** M3-09
- **Spec:** [N7 Same again](../screens.md#n7-same-again); [Data model](../spec/04-data-model.md) · Same again; [API](../spec/08-api.md) · Guest room (`room-session/same-again`); [Order](../screens.md#order) note 6
- **Build:** `GET /v1/public/room-session/same-again` lists the session's delivered orders, newest first, each with its items and total before tax, priced from today's menu and leaving out anything 86'd, outside the alcohol window or blocked by a cut-off (M3-20, M3-21). One tap places a new order with `same_again_of` set, which rings the bar and needs Accept like any other.
- **Acceptance:**
  - [ ] After o3 is delivered, Room 3's page lists "2 × Margarita · Peach, 1 × Margarita · Strawberry" for $39.00 under Same again.
  - [ ] One tap orders it again: it reads "Sent to the bar · you can still cancel" and rings on the bar orders screen as a new order with `same_again_of`.
  - [ ] A round with an item that's 86'd tonight is offered without it, and says so.
- **Tests:** API tests; Playwright on a phone size.
- **Notes:** None.

### M3-12 · Run the room tablets in kiosk mode

- **Status:** todo
- **Size:** S
- **Depends on:** M1-15, M3-10
- **Spec:** [N4 Room tablet (kiosk)](../screens.md#n4-room-tablet-kiosk); [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what (Room tablet); [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Room tablets; [Security and data retention](../spec/12-security-retention.md) 14
- **Build:**
  - Each tablet is a `room_tablet` device paired to one room (M1-15), running the room page in managed kiosk mode (Guided Access or device management on iPad, lock-task mode on Android). It sees only its room's current session, through the filtered room channel, and has no PIN pad and no help link.
  - Between sessions it shows "Room available" and takes no orders. In a session it shows the clock, the running total from the server (fetched again every minute), the menu and Call staff.
  - Each tablet gets its own `room_guests` row for each session, named for the tablet and never the host, so its orders carry a room guest like a phone's and the host lock applies to it.
  - Every tablet action also works from a phone or through staff.
- **Acceptance:**
  - [ ] Room 11's tablet shows "Room available" and can't order.
  - [ ] Room 9's tablet shows the clock and $480.00 so far, and an order from it rings on the bar orders screen.
  - [ ] Room 4's tablet is off, and Admin reads 13 of 14 tablets online.
  - [ ] No tablet screen shows a PIN pad or the private help link.
- **Tests:** Playwright on a tablet size as a paired device; a room-channel filter test.
- **Notes:** The data model gives a tablet's orders no `room_guest_id`; a room guest row for each tablet is the cautious fit, so the host lock and cut-offs cover the tablet too (flagged). Setting up kiosk mode on the 14 tablets is part of M9's install.

### M3-13 · Print tickets to network printers, with failures and reprints

- **Status:** todo
- **Size:** M
- **Depends on:** M1-15, M1-34, M3-06
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Tickets, Supported hardware; [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what (Printer); [Data model](../spec/04-data-model.md) · `print_jobs`; [API](../spec/08-api.md) · Orders (`/print-jobs/{j}/reprint`), Live events (`print_job.failed`); [Admin by milestone](../milestones.md#admin-by-milestone) (Printers & devices); [Bar](../screens.md#bar) note 4
- **Build:**
  - Star CloudPRNT and Epson Server Direct Print. Each printer is a `printer` device with its own credential (the printer principal); it asks the API for jobs every 5 seconds or less and confirms each one it prints. The job id is the CloudPRNT `jobToken`, so a lost confirmation can be worked out.
  - The ticket: the full item names (never button names), options, quantities, the room, the time, who accepted it and the ID status.
  - A job still unconfirmed after three polls raises `print_job.failed`, and the bar orders screen and the board show "Ticket didn't print · Reprint". `POST /print-jobs/{j}/reprint` makes a new job with `reprint_of` and `reprint_n`, which prints "REPRINT 2", then "REPRINT 3" and so on.
  - Admin → Printers & devices gets printers: add one, pick its station, print a test ticket.
- **Acceptance:**
  - [ ] Accepting an order prints its ticket on the bar's network printer within 5 seconds, and the printer's confirmation marks the job confirmed.
  - [ ] With the bar printer unplugged, "Ticket didn't print · Reprint" shows after three polls, and the reprint says "REPRINT 2"; a second reprint says "REPRINT 3".
  - [ ] A printer fetches only its own jobs.
  - [ ] A CloudPRNT printer and a Server Direct Print printer both pass the same tests.
- **Tests:** protocol tests against recorded printer requests; a Playwright test of the failure line and the reprint.
- **Notes:** Print payloads are kept 30 days (the retention job is M8). Receipts on these printers come in M4, and "TRAINING" on practice tickets in M7.

### M3-14 · Print to USB printers through the desktop app's print host

- **Status:** todo
- **Size:** M
- **Depends on:** M1-28, M3-13
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Tickets (USB printers print through a desktop-app host); [Scope and architecture](../spec/01-scope-architecture.md) · Desktop app, Printers
- **Build:** the desktop app on the bar and front-desk computers hosts their USB printers. It takes their jobs over its signed channel, prints raw ESC/POS, and confirms each job. A USB printer is a `printer` device reported through its host's heartbeats. Unconfirmed jobs take M3-13's failure and reprint path.
- **Acceptance:**
  - [ ] With a USB printer on the bar computer, accepting an order prints its ticket and confirms the job.
  - [ ] With the USB printer unplugged, "Ticket didn't print · Reprint" shows, and the reprint says "REPRINT 2".
  - [ ] The bar computer's heartbeat reports its USB printer's state.
- **Tests:** an integration test with a virtual USB printer; a check on a real USB printer on the staging bar computer.
- **Notes:** The cash drawer on the same printer's kick port comes in M4.

### M3-15 · Build the bar orders screen

- **Status:** todo
- **Size:** M
- **Depends on:** M1-21, M3-06, M3-13
- **Spec:** [Bar](../screens.md#bar); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Room orders at the bar; [Glossary · Order statuses](../glossary.md#order-statuses); [Demo seed · Room orders](../demo-seed.md#room-orders)
- **Build:**
  - Five columns. Waiting for you: ringing and asked-to-wait orders, oldest first, still aging, with [Accept · print ticket], [Ask the room to wait] and [Decline…]. Being made: "Accepted by Maya · 10:33 · on Room 9's tab · ticket printed", with [Ready]. Ready for a runner: each with its age since Ready. Delivered tonight: only orders a runner marked Delivered, with the time and the runner. Returned: "Couldn't serve: reason · Andy", with [Void · not made], [Void · made (waste)] and [Remake], plus declined and cancelled orders with their reason.
  - Each order's ID status ("ID ✓ 3 of 4 · the runner checks the last ID"); new orders show cyan; the out-tonight list and 86 from here; "Ticket didn't print · Reprint".
  - The desktop side menu, the W4 button back, the signed-in person and Lock; every Accept is stamped with whoever is signed in.
  - The footer's one sentence: "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup."
  - Besides its live events, the screen checks for ringing orders every 15 seconds. It exists only while Bar screen & tickets is on.
- **Acceptance:**
  - [ ] At 10:41 PM it shows o1 "Ringing · 0:43" and o2 "Ringing · 2:11" in amber under Waiting for you, and o3 "Ready for a runner · 4:00" and o4 "Ready for a runner · 1:35" with "ID ✓ 3 of 4 · the runner checks the last ID".
  - [ ] Maya's badge tap, then Accept on o1, stamps "Accepted by Maya" and moves it to Being made with a printed ticket.
  - [ ] No button offers Ready or Delivered on an order that isn't accepted.
  - [ ] With Bar screen & tickets off, the screen and its menu entry are gone.
- **Tests:** Playwright against the seed at 900 × 640 and 1280 × 800.
- **Notes:** [Bar](../screens.md#bar) notes 1–6, 8 and 9 now; note 7 (the outage banners) is M8. Room 5 is Leo M. · 4 with "ID ✓ 4 of 4", and Room 3 is Priya R. (note 6).

### M3-16 · Age and escalate room orders on the bar screens, phones and the board

- **Status:** todo
- **Size:** M
- **Depends on:** M1-22, M1-28, M2-09, M2-15, M2-29, M3-15
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Room orders at the bar; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · rule 7, Room orders at the bar (Escalation); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `PosSettings.orderAging`; [Glossary · The escalation sentence](../glossary.md#the-escalation-sentence); [Board](../screens.md#board) note 5; [Bar](../screens.md#bar) note 4
- **Build:**
  - Aging from `pos.orderAging` on West 4's defaults (30, 120, 240 and 360 seconds; `chime` on; `muteSec` 60) until Admin → Bar POS arrives in M6. A ringing or asked-to-wait order ages on screen: cyan when new, amber at 2 minutes, pink at 4.
  - A job for each order raises `order.escalated`: at 30 seconds every bar-role phone buzzes; at 2 minutes the board shows its alert ("Room 5's order has been ringing 2:11 (4 × Bud Light)" with [Show]); at 4 minutes the manager on duty's phone gets a push and the alert reads "on Andy's phone"; at 6 minutes a text goes to the manager on duty and the alert reads "texted Andy". Accept, a cancel or a decline stops it.
  - The chime as a backup: the desktop app plays it even when its window isn't in front, and while the screen is locked (the locked device's ring channel from M1-15). Mute silences the chime for 60 seconds.
  - The board's menu badge "Bar orders · N" counts every ringing and asked-to-wait order.
- **Acceptance:**
  - [ ] On the simulated clock, an order placed at 10:41:00 PM that nobody accepts buzzes bar phones at 10:41:30, shows on the board at 10:43:00, reads "on Andy's phone" at 10:45:00 as his phone buzzes, and texts Andy at 10:47:00, when the board reads "texted Andy".
  - [ ] An asked-to-wait order keeps aging and escalating, and accepting it stops everything.
  - [ ] At 10:41 PM the board's badge reads "Bar orders · 2".
  - [ ] Mute stops the chime for 60 seconds while the colors keep changing.
  - [ ] With the bar computer locked, a new order still shows and chimes there.
- **Tests:** job tests on the simulated clock; a desktop-app test that the chime plays with the window in the background.
- **Notes:** "Bar-role phones" isn't defined further; until M7's duty says who's on the bar, this buzzes bartenders' phones and the front desk's while its covering-the-bar switch is on (flagged). "A text or call at 6": this sends a text, since the spec names no calling service, and the staff alert isn't one of the 14 guest texts (flagged).

### M3-17 · Alert when no bar device is connected

- **Status:** todo
- **Size:** S
- **Depends on:** M1-16, M1-22, M2-29
- **Spec:** [N32 No bar device connected](../screens.md#n32-no-bar-device-connected); [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Room orders at the bar; [Board](../screens.md#board) note 17; [Bar](../screens.md#bar) note 9
- **Build:** the server tracks which bar computers have a live connection. If none does during opening hours (M1-12), every bar-role phone buzzes at once and the board shows the alert; it clears when one connects.
- **Acceptance:**
  - [ ] Disconnecting the bar computer at 10:41 PM buzzes Maya's phone at once and puts the alert on the board.
  - [ ] Disconnecting it at 5:00 AM, after the close, raises nothing.
  - [ ] Reconnecting clears the alert everywhere.
- **Tests:** integration tests on the simulated clock.
- **Notes:** The board alert is the flows review's ask and isn't decided in the fix brief (N32), but M3's Ships lists it. Its words aren't fixed, so "No bar device connected" (N32's title) goes in the catalog for the founder to confirm (flagged).

### M3-18 · Carry runs on every staff phone, and take returns

- **Status:** todo
- **Size:** M
- **Depends on:** M1-22, M2-12, M3-06
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Words on every staff screen (Runs), The board and staff phones (Runs); [Staff](../screens.md#staff) notes 1 and 18; [Data model](../spec/04-data-model.md) · `alcohol_refusals`, `id_checks`; [Glossary · Return (Couldn't serve)](../glossary.md#orders-and-the-bar)
- **Build:**
  - Runs on every staff phone (`GET /orders?status=ready,on_the_way`): Ready for a runner with its age; [I've got it] records `claimed_by` and `claimed_at` ("On its way · Andy"); then [Delivered] ("Delivered · 10:52 · Andy") or [Couldn't serve…] with a reason: "No ID for someone who ordered", "Someone looks too drunk", "Nobody in the room" or Other. A push when a run is ready.
  - A return goes to the bar's Returned column and to the manager on duty's phone (`order.returned`). "Someone looks too drunk" offers the manager "Cut off Room 9?" for the order's room; a runner can't cut off. A return for no ID or for too drunk is logged in `alcohol_refusals`.
  - Runs shows each order's ID status, and the runner can record an ID checked at the room (`POST /sessions/{s}/id-checks` with the `order_id`).
  - The Runs tab becomes the runner's home, in place of M1's stub.
- **Acceptance:**
  - [ ] On Andy's phone, I've got it on o3 (Room 3) shows "On its way · Andy" everywhere, and Delivered shows "Delivered · 10:52 · Andy" at 10:52 PM on the simulated clock, adding nothing to Room 3's check.
  - [ ] A runner returning o4 (Room 1) with "No ID for someone who ordered" puts "Couldn't serve: No ID for someone who ordered · Andy" under Returned, Andy's phone gets it, and a refusal is logged.
  - [ ] A "Someone looks too drunk" return offers Andy "Cut off Room 1?", and a runner's phone offers no cut-off.
  - [ ] The runner records Room 1's last ID, and its chip reads "ID ✓ 4 of 4".
- **Tests:** Playwright on a phone size; API tests for returns and refusals.
- **Notes:** The spec doesn't say who gets the push when a run is ready; every role carries runs, so it goes to every signed-in staff phone (flagged).

### M3-19 · Build the fix panel for comps and voids on every screen

- **Status:** todo
- **Size:** M
- **Depends on:** M2-14, M2-15, M2-31, M3-06
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Changing a sent drink; [Tenancy and access](../spec/02-tenancy-access.md) · The reason-only limit, Approvals; [Money rules](../spec/05-money-rules.md) 7; [API](../spec/08-api.md) · Checks (`/lines/{l}/comp`, `/lines/{l}/void`); [Room](../screens.md#room) note 1; [DeskRoom](../screens.md#deskroom) note 1; [Rail](../screens.md#rail) note 4
- **Build:**
  - One fix panel on every screen that changes a sent line: DeskRoom, the Room phone and the board's panel now, the bar POS in M6. It shows made or not made, a reason, and "$X left this shift". A void is labeled VOID and a comp COMP.
  - `POST /checks/{c}/lines/{l}/comp` and `/void` write a negative line pointing at the original (`reverses_id`), with its reason, its `made` flag and `added_by`, when it's within the reason-only limit (M2-14) counted per person across every screen. Over either limit they answer `202 approval_pending` (kind `comp` or `void`), and the line shows "Waiting for Andy" (a manager's own requests go to Abhishek); approval writes the line with `approved_by`.
  - Unsent drinks aren't on the check, so taking one off is just an edit. Once a check is paid, a correction is a refund (M4).
  - Every comp and void, within the limit or approved, is there for the nightly exceptions report (M7).
- **Acceptance:**
  - [ ] Maya's panel reads "$63 left this shift" on DeskRoom and on the Room phone alike, from her $12.00 comp tonight.
  - [ ] Maya comps a $13.00 drink on Room 9 with a reason: no approval, and both screens then read "$50 left this shift".
  - [ ] Diego's void of a $26.00 line shows "Waiting for Andy" and lands in Andy's inbox; Andy decides on his own phone, and the VOID line appears only once he approves.
  - [ ] Andy's own void of more than $25.00 goes to Abhishek.
- **Tests:** the `reason_only_limits` group again, through the API; an end-to-end test across two screens.
- **Notes:** Moving a line to another tab belongs to the same panel on the bar POS and comes with tabs in M6. The seed's pending void (Diego's, on Tariq A.'s check) loads in M3-25. Practice checks leave the totals from M7.

### M3-20 · Check the alcohol window and cut-offs on every route that creates an alcohol line

- **Status:** todo
- **Size:** M
- **Depends on:** M3-01, M3-07, M3-09, M3-11
- **Spec:** [Money rules](../spec/05-money-rules.md) 5; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Rule packs (The alcohol window); [Data model](../spec/04-data-model.md) · `alcohol_refusals`; [API](../spec/08-api.md) · Conventions (`alcohol_closed`, `cut_off`); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Ringing; [Order](../screens.md#order) note 3
- **Build:**
  - One server check: an alcohol line may be created only while the alcohol window is open and neither the room nor the guest it's for is cut off (tabs join in M6). Every M3 route that creates one runs it: room orders from guests and from the host, staff orders, Same again and packages; Accept runs it again. M6 adds quick sale, tabs, gift orders, Repeat round and moves.
  - A refusal answers `409 alcohol_closed` or `409 cut_off` and is logged in `alcohol_refusals` (venue_id, session_id or check_id, room_guest_id, order_id, reason, item, refused_by, at).
  - Guest screens hide alcohol while it's refused, and staff screens grey out every alcohol button with the reason in words. The window's state and its next change come with the menu and the board, so every screen changes at the same moment.
- **Acceptance:**
  - [ ] With the window closed, an alcohol order from a guest, one from the host, a staff order from DeskRoom and a Same again all answer `409 alcohol_closed`, and each writes a refusal.
  - [ ] An order of only a Red Bull still goes through.
  - [ ] The guest menu hides alcohol, and DeskRoom greys it with the reason in words.
- **Tests:** an API test that calls every alcohol route with the window closed, and again with a cut-off.
- **Notes:** An item is alcohol by `menu_items.alcohol`, copied onto `order_items.alcohol` when it's ordered.

### M3-21 · Cut off a room or one guest

- **Status:** todo
- **Size:** M
- **Depends on:** M2-29, M2-31, M3-08, M3-20
- **Spec:** [N16 No more alcohol (cut off)](../screens.md#n16-no-more-alcohol-cut-off); [Money rules](../spec/05-money-rules.md) 5 (Cut-offs); [API](../spec/08-api.md) · Board and sessions (`/cut-off`, `/guests/{g}/cut-off`); [Data model](../spec/04-data-model.md) · `room_sessions`, `room_guests`; [Board](../screens.md#board) note 12; [DeskRoom](../screens.md#deskroom) note 7; [Room](../screens.md#room) note 4
- **Build:**
  - "No more alcohol for this room" on the board's tile panel, DeskRoom and the Room phone (`POST /sessions/{s}/cut-off`, setting `alcohol_cut_off_at`, `alcohol_cut_off_by` and `alcohol_cut_off_reason`), and one guest's cut-off (`POST /sessions/{s}/guests/{g}/cut-off`). Each records who, why and when, and logs a refusal.
  - A room cut-off stops room, host, staff and gift orders for that room; a guest cut-off stops that guest's own orders while the rest of the room still orders. Their alcohol orders still ringing or asked to wait are cancelled with `cut_off`; an order that also has other items keeps ringing with just those.
  - Every screen for that room shows "Cut off by Andy at 10:30 PM" and greys out alcohol; the guest's phone hides alcohol and shows "Your server has paused alcohol for this room"; the bar screens show "Cancelled · cut off by Andy"; Same again leaves alcohol out. Singing is still fine, and a runner can't cut off.
- **Acceptance:**
  - [ ] Andy cuts off Room 9 at 10:41 PM on a fresh load: the room page, the host, a staff order from DeskRoom and Room 9's tablet are all refused alcohol, and every screen for Room 9 shows "Cut off by Andy at 10:41 PM" (the form the done-when writes as 10:30 PM, Hana K.'s time in the seed).
  - [ ] o1, the 2 × Margarita · Peach still ringing for Room 9, is cancelled as "Cancelled · cut off by Andy", and Room 9's phones read "Your server has paused alcohol for this room".
  - [ ] Cutting off one Room 9 guest refuses that guest's alcohol order and lets another guest's through.
  - [ ] Each refusal is logged, and a runner's cut-off answers `403`.
- **Tests:** an API test over every alcohol route; Playwright for the control on the board, DeskRoom and the Room phone.
- **Notes:** The spec has no way to lift a cut-off, so none is built (flagged). A tab's cut-off (Hana K.'s) is M6. Mixed orders split as at 4 AM (M3-22).

### M3-22 · Stop alcohol at 4:00 AM on every screen, and cancel what nobody accepted

- **Status:** todo
- **Size:** M
- **Depends on:** M1-06, M3-20
- **Spec:** [Money rules](../spec/05-money-rules.md) 5 (The 4 AM stop); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Words on every staff screen, Room orders at the bar; [Order](../screens.md#order) note 3; [Bar](../screens.md#bar) note 5; [Testing and operations](../spec/13-testing-operations.md) · Tests (clock tests)
- **Build:**
  - A job at the window's close each business date (the scheduler works the instant out per date on the wall clock) cancels every alcohol order still ringing or asked to wait, with `cancel_reason` `alcohol_closed` and nothing charged. An order that also has other items keeps ringing with just those: its alcohol items move to an order of their own, which is cancelled.
  - The room's screens read "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged", and the bar screens list the order under "Cancelled at 4:00 AM". There's no Decline button after 4 AM, and the decline route refuses.
  - From 4:00 to 8:00 AM every alcohol button greys out on every screen with the reason in words, and every alcohol route answers `409 alcohol_closed` (M3-20).
- **Acceptance:**
  - [ ] At 4:00:00 AM on the simulated clock, on a normal night and on both daylight-saving nights (business dates Sat Oct 31, 2026 and Sat Mar 13, 2027), every alcohol button greys out and an unaccepted alcohol order cancels itself.
  - [ ] The room then reads "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged", and the bar orders screen lists the order under "Cancelled at 4:00 AM", with no Decline button.
  - [ ] An order of a Margarita and a Red Bull still ringing at 4:00 AM keeps ringing with the Red Bull alone.
  - [ ] Every alcohol route answers `409 alcohol_closed` from 4:00 AM.
- **Tests:** spec 13's clock tests at 4:00:00 AM on all three nights, end to end.
- **Notes:** The data model has no cancel for one item, so splitting the alcohol items into their own cancelled order keeps both on the record (flagged). The Rail's "Demo: it's 4:02 AM" is a canvas control and isn't built; staging moves the simulated clock instead.

### M3-23 · Raise the clear-out check at 4:30 AM

- **Status:** todo
- **Size:** S
- **Depends on:** M1-06, M2-29, M3-01
- **Spec:** [N17 Clear-out check](../screens.md#n17-clear-out-check); [Money rules](../spec/05-money-rules.md) 5 (Clear-out check); [Data model](../spec/04-data-model.md) · `clear_out_checks`; [API](../spec/08-api.md) · Night close (`POST /nights/{date}/clear-out`), Live events (`clear_out.due`); [Board](../screens.md#board) note 13
- **Build:** `clear_out_checks` (venue_id, business_date, due_at, done_by, done_at, note), one per business date. A job raises it at the close plus the drinking-up time (M3-01; 4:30 AM at West 4) with `clear_out.due` to the board, Close the night (M7) and the manager on duty's phone. The board asks "Walk every room and the bar · no drinks left out" with [Done]. `POST /nights/{date}/clear-out` records who and when, and the board then shows "Clear-out check · Andy · 4:31 AM".
- **Acceptance:**
  - [ ] At 4:30 AM on the simulated clock the board asks "Walk every room and the bar · no drinks left out", and Andy's phone gets it.
  - [ ] Andy's [Done] at 4:31 AM records "Clear-out check · Andy · 4:31 AM".
  - [ ] Business date Fri Sep 25 has one clear-out check, however often the job runs.
- **Tests:** job and API tests on the simulated clock, on a normal night and both daylight-saving nights.
- **Notes:** Close the night refuses to close before the check is done; it enforces that in M7. When drinking-up time starts is open with the lawyer (see M3-01).

### M3-24 · Run accessibility checks in CI for the room page and the tablets

- **Status:** todo
- **Size:** S
- **Depends on:** M3-09, M3-10, M3-11, M3-12
- **Spec:** [Security and data retention](../spec/12-security-retention.md) 14; [M3 · Ships](../milestones.md#m3--room-orders-and-the-bar-screen) (Accessibility checks); [N3 Join a room](../screens.md#n3-join-a-room); [N4 Room tablet (kiosk)](../screens.md#n4-room-tablet-kiosk)
- **Build:** automated WCAG 2.2 AA checks (axe through Playwright) in CI on the join step, the room page in each state (the menu, a required choice, the cart, every order status and side message, the running bill, Same again, Call staff, the host lock, a closed room, a cut-off room and the 4 AM message) and the tablet ("Room available" and in a session). Status changes are announced to screen readers, text meets 4.5:1 contrast, and every tablet action can also be done from a phone or through staff. A violation fails the build.
- **Acceptance:**
  - [ ] CI runs the checks on every pull request and fails on any WCAG 2.2 AA violation.
  - [ ] An order's status change is announced to a screen reader.
  - [ ] The waitlist page from M2 goes through the same checks.
- **Tests:** the checks themselves, with one planted violation that has to fail them.
- **Notes:** A person's screen-reader pass on ordering and the waitlist page comes in M5.

### M3-25 · Load the M3 part of the demo seed and run the mock Friday

- **Status:** todo
- **Size:** M
- **Depends on:** M3-14, M3-16, M3-17, M3-18, M3-19, M3-21, M3-22, M3-23, M3-24
- **Spec:** [Demo seed · Room orders](../demo-seed.md#room-orders), [Things to try](../demo-seed.md#things-to-try), [Loading the seed](../demo-seed.md#loading-the-seed); [Testing and operations](../spec/13-testing-operations.md) · Tests (end-to-end browser tests); [west4-friday.json](../../seed/west4-friday.json)
- **Build:**
  - The M3 part of the loader: `menu`, `orders` (o1 to o4, and the earlier e0 to e2, with their ages), `order_drafts` (Diego's Red Bull on Tariq A.'s check), `approvals` (Diego's pending $70.00 void of the Large bucket, routed to Andy) and a check of `reason_only_used_tonight` against the computed totals (Maya $12.00, Diego $0.00).
  - End-to-end tests for the seed's `accept_o1`, `ask_room5_wait`, `accept_o2`, `runner_o3`, `runner_returns_o4`, `reason_only` and the room-order half of `alcohol_stop`, each from a fresh load.
  - A scripted mock Friday for two people in staging: orders from a tablet and from phones, a network printer and a USB printer, all six steps.
- **Acceptance:**
  - [ ] In the mock Friday, every order from a tablet and from a phone rings on the bar orders screen and the board, prints on the bar printer (one network printer and one USB), moves through the six steps with the same words on every screen, and joins the right check at Accept.
  - [ ] Room 9's drinks read $158.00, and the ringing 2 × Margarita · Peach isn't on the tab until it's accepted.
  - [ ] Andy's phone reads "Approvals · 1" for Diego's void; approving it writes the VOID line on Tariq A.'s check, whose drinks go from $79.00 to $9.00.
  - [ ] The seven scenarios pass as their `expect` text in the seed says; in `runner_returns_o4`, the $36.00 void waits for approval (M3-06).
- **Tests:** the scenario tests in CI on every pull request; the mock Friday as a written script, run by hand in staging.
- **Notes:** Tariq A.'s tab screen, with "Waiting for Andy" on it, comes with the bar POS in M6.

## Coverage

Every item milestones.md lists for M3, and the tickets that build it.

| Item | What milestones.md says | Tickets |
| --- | --- | --- |
| Ships · The menu | The editor (items, variants, options, modifier groups, button names, the alcohol flag, tax categories, out tonight), categories, packages and dated price rules, the promotion checks on every save, and the menu PDF job | M3-02, M3-03, M3-04, M3-05 |
| Ships · Room tablets and the room page | Kiosk mode with "Room available"; joining with the room code, the menu, ordering, live status, call staff, the host lock, the running bill and Same again | M3-08, M3-09, M3-10, M3-11, M3-12 |
| Ships · The order pipeline | The eight statuses, Accept as the sale, Ask the room to wait, Decline with a reason, guest cancel only while ringing or asked to wait | M3-06, M3-07 |
| Ships · The bar orders screen | Bar and the board's room-order alerts, aging and escalating, Mute, and the alert when no bar device is connected | M3-15, M3-16, M3-17 |
| Ships · Tickets | CloudPRNT and Server Direct Print, USB through the desktop print host, "Ticket didn't print · Reprint" and "REPRINT 2" | M3-06, M3-13, M3-14 |
| Ships · Runs | I've got it, Delivered and Couldn't serve on every phone; Void · not made, Void · made (waste) or Remake after a return | M3-18, M3-06 |
| Ships · Comps and voids | One fix panel on every screen, COMP or VOID, the reason-only limit per person across screens, approvals above it | M3-19 |
| Ships · Alcohol controls | The alcohol window and the house last call; room and guest cut-offs logged in `alcohol_refusals`; the 4:00 AM stop; the 4:30 AM clear-out check | M3-01, M3-20, M3-21, M3-22, M3-23 |
| Ships · Accessibility checks | WCAG 2.2 AA checks in CI for the room page and tablets | M3-24 |
| Ships · Canvas boards | Bar, Order, Board, DeskRoom, Room, Staff and AdminDesk | M3-15, M3-09, M3-16, M3-21, M3-23, M3-07, M3-19, M3-18, M3-04, M3-13 |
| Admin · Printers & devices | Printers (M3 part) | M3-13 |
| Admin · Menu | Items, options, button names, the alcohol flag, tax categories, out tonight, packages and specials | M3-04 |
| GA-M6 | A hard 4 AM stop on every channel, the 4:30 AM clear-out check, cut-offs on the wall clock through daylight saving | M3-01, M3-20, M3-22, M3-23 |
| GA-M7 | Cut-offs for rooms and guests close in M3: refusing at delivery, the refusal log, alcohol never accepted automatically | M3-06, M3-18, M3-20, M3-21 |
| GA-S2 | Specials and packages with liquor-law checks | M3-02, M3-03, M3-04 |
| GA-S3 | The running bill on the room page (M3 part) | M3-10 |
| Done when · 1 | The mock Friday: tablet and phone orders ring, print on a network and a USB printer, move through the six steps and join the right check; Room 9's $158.00 | M3-25, M3-06, M3-09, M3-12, M3-13, M3-14, M3-15 |
| Done when · 2 | Bar phones at 30 s, the board at 2 min, "on Andy's phone" at 4, a text to Andy at 6 | M3-16 |
| Done when · 3 | "Ticket didn't print · Reprint" and "REPRINT 2" | M3-13, M3-14 |
| Done when · 4 | The 4:00:00 AM stop on all three nights, `409 alcohol_closed`, and the 4:30 clear-out check | M3-01, M3-20, M3-22, M3-23 |
| Done when · 5 | Cutting off a room and one guest blocks every channel, shows "Cut off by Andy at 10:30 PM" and logs refusals | M3-20, M3-21 |
| Done when · 6 | Reason-only totals per person across screens ("$63 left this shift"); a void over $25 waits for Andy on his own phone | M3-19, M2-14, M2-15 |
| Done when · 7 | A package or price rule that fails the checks can't be saved; the PDF follows a save within a minute | M3-02, M3-04, M3-05 |
| Done when · 8 | Same again re-orders the last delivered round and rings the bar | M3-11 |
