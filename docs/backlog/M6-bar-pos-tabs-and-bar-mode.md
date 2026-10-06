# M6 · Bar POS, tabs and bar mode

Sep 29, 2026 · the backlog for milestone M6 of the [phase 1 milestones](../milestones.md#m6--bar-pos-tabs-and-bar-mode). One ticket is one Claude Code session of 1 to 3 days. Build what the [spec](../spec/README.md) says; where a canvas board differs, [screens](../screens.md) says what to build instead, and the [demo seed](../demo-seed.md) gives every name and number the tests check.

**Goal (usable when done):** The bar runs on card tabs with growing holds, and singers queue from their phones.

**Depends on:** M4 (the readers and the payment core) and M3 (orders and cut-offs).

**Size:** 3–4 weeks in milestones.md. The 28 tickets below are 4 S and 24 M: about 50 to 76 working days (S ≤ 1 day, M 2–3 days). See [Open points](#open-points).

Definition of done: see CLAUDE.md.

## Done when

Copied from [milestones.md](../milestones.md#m6--bar-pos-tabs-and-bar-mode):

- The timed tasks in Staff screens and the bar POS meet their targets in staging (a walk-up beer in cash under 8 s, another round under 3 s, taking over the terminal under 2 s).
- Every tab path passes on the connected sandbox: a declined raise, a timeout, a cut-off (alcohol greyed out, alcohol moves onto the tab refused), a walkout charged at 4:30 AM, a reopened tab that shows "Paid $272.19 · no hold" and no "Close to card", and $32.66 split into $16.33 + $16.33 that survives leaving the pay panel.
- Moving Jess P.'s tab into Room 9 moves every line as a transfer ("Moved from Jess P.'s bar tab"), releases her hold once the room has a payment method, and refuses alcohol when the room is cut off.
- Diego's void of 1 × Large bucket · 10 beers ($70) on Tariq A.'s tab waits for Andy, and Tariq A.'s tab shows "Waiting for Andy" until he decides.
- The seed's queue plays out: Luis M. is singing, Jess P. is next, Ben T.'s phone reads "2 singers before you" and then gets "You're up next" by push and by text, and Sofia R. shows "Needs a drink credit". The TV never shows a phone number.
- A songbook CSV loads and is searchable from the queue page.
- A gift order to a cut-off tab, or after 4 AM, is refused with the reason.

## Suggested order

The IDs run in build order. Tickets on the same line can run side by side once the line before is done.

1. The bar POS: M6-01 → M6-02 → M6-03, M6-04 → M6-05.
2. Tabs: M6-06 → M6-07 → M6-08 → M6-09, M6-10, M6-11 → M6-12, M6-13; M6-14, M6-15.
3. Closing tabs: M6-16 → M6-17.
4. Bar mode: M6-18 → M6-19 → M6-20, M6-21, M6-22, M6-23, M6-24.
5. Admin, seed and proof: M6-25, M6-26 → M6-27 → M6-28.

M6 needs only M4 and M3, so it can run before or after M5. Build M6-27's seed loading a piece at a time as each feature lands, so staging always shows the seed's bar.

## Every ticket

These come from the spec and apply to every ticket below, on top of the definition of done:

- The bar POS follows the rules every staff screen follows ([Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md)): nothing moves, the usual is one tap, exceptions in words, undo instead of "are you sure?", nothing waits for a manager, wet-proof targets, and a tap that answers in the same frame.
- Every card step shows the card states from [Payment flows](../spec/07-payment-flows.md#what-staff-see-during-a-card-payment), and every card call goes through M4's state machine, keys and reconciler; nothing calls Stripe inside a database transaction.
- Every route that creates an alcohol line runs M3's one alcohol check (the window and every cut-off) and logs a refusal in `alcohol_refusals`.
- Money routes take an `Idempotency-Key`; every new route, job and webhook joins M1's principal suite and venue-wall suite.
- Every amount comes from `packages/rules` in integer cents.
- Every staff string is in the English and Spanish catalogs, with the [glossary's](../glossary.md#other-exact-sentences) words exactly.
- "Now" and the business date come from the venue's clock; clock tests run on a normal night and on both daylight-saving nights (Nov 1, 2026 and Mar 14, 2027).

## Tickets

### M6-01 · Publish bar POS layouts that start at the next business date

- **Status:** done
- **Size:** M
- **Depends on:** M3 (the menu with `button_name`); M1 (settings, Admin)
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (rule 2, The bar POS screen, Admin → Bar POS: Layout); [Data model](../spec/04-data-model.md) (`pos_layouts`); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`pos.layouts`, When a change starts); [API](../spec/08-api.md) (`GET /pos/layouts`, `POST /pos/layouts`, `/pos/layouts/{l}/publish`); [screens: N33](../screens.md#n33-admin--bar-pos)
- **Build:**
  - `pos_layouts` (station, version, sections of 25 slots each holding an item id or nothing, published_by, published_at, starts_on), with ten sections in fixed places: Favorites, Beer, Soju, Cocktails, Shots, Spirits, Wine, Soft drinks, Bottles, Buckets.
  - `POST /pos/layouts` saves a draft, and `/pos/layouts/{l}/publish` publishes a new version that starts at the next business date ("Starts Sat Sep 26"), sets `pos.layouts` for the station, and leaves tonight as it is.
  - Admin → Bar POS → Layout: a 25-slot grid for each section, per station, showing each item's `button_name`. West 4 has one station, the bar.
  - West 4's first published layout comes from the Rail board's fixed positions (its `PAGES`), since the seed has none.
- **Acceptance:**
  - [x] Publishing on Fri Sep 25 at 10:41 PM shows "Starts Sat Sep 26", and the bar POS keeps tonight's layout until the 6:00 AM cutover.
  - [x] An item added to a section takes an empty slot, and no other item moves.
  - [x] A layout that names another venue's item is refused.
- **Tests:** unit tests for the business-date start; integration; end-to-end on the editor.
- **Notes:** The seed has no `pos_layouts`; the Rail board's layout becomes West 4's first version.
  - Built: migration 0076 (`pos_layouts`: station, version, draft or published, sections, published by and at, starts_on; one draft per station). The sections are fixed in `packages/shared/src/pos.ts`: favorites, beer, soju, cocktails, shots, spirits, wine, soft, bottles, buckets, 25 slots each. `addToSection` puts a new item in the first open slot and moves nothing else.
  - Publishing gives the draft the station's next version, starting at `nextBusinessDate()` (tested on a normal night and both daylight-saving nights), and saves `pos.layouts` through Save and publish, whose M1 rule already starts a layouts change at the next business date. So `GET /pos/layouts` keeps showing version 1 as tonight's until 6:00 AM.
  - `GET /pos/layouts` is for anyone with `pos.use` (the bar POS reads it in M6-02); saving and publishing are Admin, passkey only. A slot naming an item that isn't on this venue's menu is refused (`unknown_item`).
  - Seed: `seed-pos-layout.ts` holds the Rail board's `PAGES` by the seed's item ids; the loader publishes it as version 1 for the bar and sets `pos.layouts` to `{ bar: 1 }`.
  - Admin → Bar POS (`/admin/bar-pos`) has the Layout part only; the rest of that section (reason-only limits, locks, tip path, order aging, tab settings) is M6-25.

### M6-02 · Build the bar POS screen around the fixed grid

- **Status:** done
- **Size:** M
- **Depends on:** M6-01; M3 (room-order cards, 86, the desktop side menu); M1 (the desktop app shell)
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (rules 1, 2, 4, 7, 9, 10 and 12; The bar POS screen; 86 from the bar POS; Room orders at the bar; Adding drinks to a room from a staff screen); [screens: Rail](../screens.md#rail) (notes 1, 10, 11, 12, 14, 15 and 19); [glossary](../glossary.md#say-this-not-that)
- **Build:**
  - The Rail screen in the desktop app, the bar computer's home for bartenders. Top bar: who's signed in; room orders as cards with their age and Accept · print ticket, Ask the room to wait and Decline… (no Decline after 4 AM); "Song queue · 6" in bar mode; the clock and online state; Wipe screen and Lock. The side menu from the W4 button. Left: New tab, a find box (name, room or the card's last four), All, Mine and Rooms, Quick sale, bar tabs in the order opened, then rooms, and Closed tonight. Center: ten sections of 25 fixed slots, a search across the whole menu, and 86. Right: the tab's name and card; chips for ID ✓, the hold and its headroom, and a cut-off; the round being rung; what's already on the tab; Repeat round and Undo; the total; Send, Close and Move tab to a room.
  - A tab row carries a badge only when it needs attention: "Hold · $6 left", "Hold raise declined", "Partly paid · $16.33 of $32.66", "Cut off", "Waiting for Andy", "2 not sent" and "Paid $272.19 · no hold", each fed by the ticket that builds it.
  - 86: tap 86, then an item or one of its variants or flavors; it grays out in its slot, marked "86'd tonight", on every staff screen and on the guest menu, until someone taps it again or the night closes.
  - Rooms on the Rail ring drinks onto the room's check as staff orders accepted as they're placed, so the ticket prints at the bar.
  - Menu buttons at least 115 × 100 px and main actions 52 to 64 px tall; nothing needs a swipe or a long press.
- **Acceptance:**
  - [x] Maya's bar POS lists five tabs in the order opened (Hana K., Jess P., Luis M., Tariq A., Seat 6 · blue jacket), then Room 9, Room 12 and the VIP room with the seed's numbers (Room 12 opened 9:00 PM with $235.67 of room time; the VIP room $295.83).
  - [x] The two ringing room orders (Room 9 at 0:43 and Room 5 at 2:11, amber) show across the top with Accept; accepting o2 prints a ticket and takes Room 5's tab to $72.00.
  - [x] 86 on Hoegaarden grays it out in its slot on the bar POS and on the guest menu, and nothing shifts.
  - [x] The screen says "Ask the room to wait", "Back to the sale" and "their phones explain", and never "Hold" for a room order.
- **Tests:** Playwright on the desktop layout with the seed; visual regression on the grid; the language test.
- **Notes:** The canvas has no side menu and no way to 86 ([Rail note 12](../screens.md#rail)), shows older room numbers ([Rail note 14](../screens.md#rail)) and Room 5 as 4 of 5 IDs; build "ID ✓ 4 of 4" ([Rail note 15](../screens.md#rail)).
  - Built: the Rail at `/bar` (`apps/staff/src/screens/Rail.tsx`), the bar computer's home. Top: who's signed in, the ringing and held room orders oldest first (aged new, amber at 2:00, pink at 4:00) with Accept · print ticket, Ask the room to wait and Decline… (no Decline for alcohol once the window closes; the decline form says "Their phones explain why."), and the venue's clock. Left: the find box, All · Mine · Rooms, the bar tabs in the order opened, every open room in the order opened (with opened time, minutes and room time), and Closed tonight. Center: the ten sections of tonight's layout (M6-01), a menu search and 86. Right: the tab or room, its chips, what's on it, the total, and the round, rung from the grid.
  - Migration 0077 creates `tabs` from the data model, plus `name` (the bar's name for the tab, "Jess P."; `label` keeps where it sits, "Seat 3"), flagged. The seed loader now loads the five tabs on their bar checks (M6-27's seed, a piece at a time). `GET /tabs?state=` lists open tabs and tonight's closed ones with each check's totals, a fix waiting for a manager and the caller's unsent count. `GET /board` now also gives each session's `started_at`.
  - Rounds reuse M3-07's AddDrinks (drafts on the server, usual options, Send as a staff order accepted as it's placed), now without a session for a tab and with the Rail's grid ringing into it. Repeat round and Undo are M6-03; New tab M6-06; Quick sale M6-05; Close and Move M6-08 and M6-13; Wipe screen and Lock M6-04. The hold badges ("Hold · $6 left", "Hold raise declined", "Partly paid …", "Paid $272.19 · no hold") come with the tickets that build them.
  - 86 from the Rail: tap 86, then an item; an item with sizes or flavors asks which (or all). It calls M3's out-tonight route, so it greys on every staff screen and the guest menu.
  - Visual regression: there's no screenshot baseline set-up, and baselines taken on macOS wouldn't match CI's Linux, so the e2e test checks the grid's geometry instead (25 slots, five across, each at least 115 × 100 px, nothing shifting after 86). Flagged in case pixel screenshots are wanted in CI.
  - Room orders across the top are oldest first, so Room 5 (2:11, amber) comes before Room 9 (0:43).

### M6-03 · Ring a round: usual options, repeat round, undo and drafts on the server

- **Status:** done
- **Size:** M
- **Depends on:** M6-02; M3 (`POST /checks/{c}/orders`, the alcohol check)
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (rules 3, 5, 8 and 10; Ringing); [Data model](../spec/04-data-model.md) (`order_drafts`); [API](../spec/08-api.md) (`GET` and `PUT /drafts/{key}`, `POST /tabs/{t}/repeat-round`, `draft.updated`)
- **Build:**
  - A drink rings with its usual options already set (spirits on the rocks), and tapping it again makes two; − and + on a line; options show under the line, never in a pop-up. A choice with no sensible default (a margarita's flavor) turns the line amber, stays open while other drinks are rung, and the send button names what's missing.
  - Unsent drinks are saved on the server as they're rung (`order_drafts`, per person and per tab or `quick`, `PUT /drafts/{key}` carrying its version), and `draft.updated` brings them to the person's other screens. Drafts are never part of a check, and they clear when sent and at the night close.
  - Undo, step by step, on unsent drinks, with no "are you sure?".
  - Repeat round (`POST /tabs/{t}/repeat-round`) copies the last round, leaves out anything 86'd, outside the alcohol window or blocked by a cut-off, and says so.
  - Send prints the ticket and puts the round on the tab through the hold-raise check (M6-07); Send & close sends and opens payment in one tap; while the network is slow the round shows as sending, never a frozen screen.
  - The check says when someone else has drinks not sent on it ("2 not sent").
- **Acceptance:**
  - [x] Another round on Jess P.'s tab takes 2 taps (Repeat round, Send) and under 3 seconds.
  - [x] Diego's unsent Red Bull ($6.00) on Tariq A.'s tab follows him to the other terminal, isn't on the check, and Maya sees "1 not sent" on Tariq's row.
  - [x] A margarita with no flavor holds Send back, and the button names the missing flavor.
  - [x] Repeat round on a round with a Hoegaarden leaves it out and says so.
  - [ ] Sends are confirmed within 300 ms at the 95th percentile in staging.
- **Tests:** unit tests for draft versions and conflicts; integration; end-to-end with a latency budget.
- **Notes:** A round that has to wait for a hold raise (M6-07) takes Stripe's time, so it shows as sending; the 300 ms target covers the rest.
  - Built: `POST /v1/venues/{v}/tabs/{t}/repeat-round` copies the tab's last round (its last order that wasn't cancelled) into the caller's unsent drinks with its options, merges it with anything already rung, sends `draft.updated` to the person, and lists what it left out: 86'd tonight, alcohol after the 4 AM stop, or alcohol on a cut-off tab. Nothing is sent until Send.
  - The seed's tab lines have no orders behind them, so for a tab with no orders the last round is the drinks put on it at the latest time, matched to the menu by name, with their usual options (Jess P.: 2 × Modelo and a Jäger Bomb).
  - The bar POS: Repeat round on a tab, Undo step by step on unsent drinks (no "are you sure?"), and Send shows "Sending…" while it's in flight. The tab row's "N not sent" now counts other people's unsent drinks on the tab (Maya sees Diego's "1 not sent" on Tariq A.); the caller's own are in the round.
  - Tax is worked out once on the whole tab, so a second identical round takes Jess P. from $32.66 to $65.33, not $65.32.
  - Not here: Send & close (it opens payment, which is M6-08), the hold-raise check on Send (M6-07), and clearing drafts at the night close (M7-12). Draft versions and conflicts were built and tested in M3-07; this ticket uses them unchanged.
  - Not checked: "under 300 ms at the 95th percentile in staging" needs staging; locally the two taps and the new total take well under 3 seconds (checked in the e2e test).

### M6-04 · Share the terminal: badge takeover, idle and wipe locks, "Maya · on break"

- **Status:** done
- **Size:** M
- **Depends on:** M6-02; M1 (badges, PINs, the desktop app shell)
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Sharing a terminal, rule 9, the Top bar, Shifts); [Tenancy and access](../spec/02-tenancy-access.md) (Badges, PINs, Roles); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`pos.idleLockMin`, `pos.wipeLockSec`)
- **Build:**
  - A badge tap takes over the bar POS at once, loading that person's own drafts and tabs; badge or name and PIN, with name and PIN as the fallback. Each person's unsent drinks stay theirs, so two bartenders can work one tab without mixing rounds, and each has their own quick sale.
  - The idle lock after `pos.idleLockMin` (3 minutes); Wipe screen turns touch off for `pos.wipeLockSec` (10 seconds); Lock.
  - The top bar shows "Maya · on break" while her break punch is open.
  - Refunds, cash counts and no-sale ask for the PIN again.
  - The front desk uses the bar POS when covering the bar, unless Admin → Team switches it off for that role.
- **Acceptance:**
  - [x] Maya takes over from Diego with a badge tap in under 2 seconds in staging, with her three tabs, and none of Diego's drafts show as hers.
  - [x] Three idle minutes lock the screen, and Wipe screen ignores touches for 10 seconds.
  - [x] With an open break punch for Maya, the top bar reads "Maya · on break".
  - [x] With the front desk's bar POS permission off, Diego's sign-in shows no Bar POS.
- **Tests:** timed end-to-end in the desktop app; permission tests.
- **Notes:** The break punch itself ships with the time clock in M7; this ticket reads it and is tested against a seeded punch (see [Open points](#open-points)).
  - Built: on the bar POS, a badge tap while someone is signed in ends their session and signs the badge's owner in through M1-25's `POST /v1/auth/badge`; the screen reloads as the new person (their tabs under Mine, their own unsent drinks; other people's show as "N not sent"). A refused badge leaves the screen locked. The top bar has Wipe screen (an overlay that takes every touch for `pos.wipeLockSec`); Lock is the app's own, in its menu; `pos.idleLockMin` without a touch or a key locks the screen.
  - `GET /v1/venues/{v}/pos/terminal` (anyone with `pos.use`) gives the two lock settings and `on_break`: the caller's last punch is an open `break_start`. The top bar then reads "Maya · on break".
  - Migration 0078 creates `time_punches` from the data model so the bar can read a break; the time clock that writes punches is M7-01. Tested against seeded punches.
  - Unchanged from M1: name and PIN as the fallback on the sign-in screen, the PIN asked again for refunds, cash counts and no-sale, and the front desk's bar POS switch in Admin → Team (the menu hides Bar POS when `pos.use` is off for the role; checked end to end).
  - The end-to-end test runs in the browser with a stand-in for the desktop app's badge reader (the same bridge the app exposes) and a real SUN tap message for Maya's demo badge, timed under 2 seconds; the idle and wipe timers run on Playwright's clock. The 2-second target in staging still needs checking on the bar computer.

### M6-05 · Sell at the bar with Quick sale

- **Status:** done
- **Size:** M
- **Depends on:** M6-03; M4-11, M4-13, M4-19
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Paying at the bar: Cash and Receipt; Tabs, card first); [Stripe setup](../spec/06-stripe-setup.md) step 4 (`process_config[tipping][amount_eligible]`); [Data model](../spec/04-data-model.md) (`checks.kind` quick); [Song systems and texts](../spec/11-song-systems-texts.md) (Credits); [milestones: GA-M11](../milestones.md#must-fix-items-and-where-they-close) (cash always taken)
- **Build:**
  - Quick sale: a `quick` check per sale, each person's own. Its pay panel takes a tap, with `process_config[tipping][amount_eligible]` set to the drinks before tax so the reader offers 18, 20 and 22%, or $1, $2 and $3 under $10; or cash, with one tap on what the guest handed over (Exact, the next $5, $10 and $20, $50, $100, or Other), the bar drawer opening, the change in large type, "Wrong amount? Fix the change" and "Logged to Maya · bar drawer".
  - The receipt: Text (the guest types their number on the reader through `collect_inputs`), Print or No receipt. Ringing the next drink starts the next sale without choosing.
  - "Back to the sale"; a failed tap voids the check and keeps its number; cash is always offered.
  - A round rung on Quick sale can move onto a new tab unsent, when the card is taken after.
  - In bar mode, a drink bought without a tab earns a singer a credit when the bartender picks the singer on the sale.
- **Acceptance:**
  - [x] A walk-up Bud Light paid in cash takes 3 taps (the beer, Pay, the bill handed over) and under 8 seconds; the bar drawer opens and the log reads "Logged to Maya · bar drawer".
  - [x] A $9.00 quick sale on the reader offers $1, $2 and $3; a $30.00 one offers $5.40, $6.00 and $6.60.
  - [x] A declined tap voids the check, keeps its number, and offers cash.
  - [ ] Picking Kira on a drink bought at the bar gives her one credit.
- **Tests:** the money-cases group `tips` (the `tip_choices` cases); a timed end-to-end; a sandbox tap on a simulated reader.
- **Notes:** The canvas says "Back to the tab" on a quick sale ([Rail note 11](../screens.md#rail)).
  - Built: `POST /v1/venues/{v}/quick-sales` makes a walk-up sale's own `quick` check (its number taken first, in its own transaction), puts the person's rung drinks on it as a staff order accepted at once (the ticket prints), finalizes it and empties their quick draft; a retried Pay with the same `client_order_id` answers the same sale. `GET …/quick-sales/{c}` shows it with the reader's tip choices; `POST …/quick-sales/{c}/void` is Back to the sale.
  - The reader: a bar or quick sale's tap now sends `process_config[tipping][amount_eligible]` (or `collect_config` with the card fee on) with the drinks before tax, so the reader's choices work on them. `tipChoices()` in `packages/rules` gives the same choices for the screen, tested with the seed's `tip_choices` cases ($9.00: $1, $2, $3; $30.00: $5.40, $6.00, $6.60).
  - The bar POS opens on Quick sale. Pay replaces Send there; the pay panel offers the tap (M4-11) and cash with one tap on what the guest handed over (the cash panel's new `oneTap`, so a walk-up beer is three taps), then the change, "Logged to Maya · bar drawer" and the receipt (M4-19). Ringing the next drink starts the next sale.
  - A declined tap: M4's pay panel shows Declined and the cash panel stays. "Back to the sale" then voids the unpaid check (it keeps its number) and puts its drinks back in the person's quick sale, refused while money is taken or held, or a tap is still on the reader. Read as: the declined *sale* is voided on the way back, not the moment the card declines (flagged).
  - Fixed on the way: a drink rung a moment before Send or Pay could be saved to the draft after the sale had cleared it. Saves now run in order, and Send and Pay wait for the last one.
  - Not here: moving a quick-sale round onto a new tab comes with opening tabs (M6-06); picking a singer for a drink credit needs the singer queue (M6-18), so that acceptance line is checked there.

### M6-06 · Open a tab card first, with the consent line and one tab per card

- **Status:** done
- **Size:** M
- **Depends on:** M6-02; M4-02, M4-05, M4-29 (the merchant category check before bar tabs turn on)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#bar-tab-with-a-growing-hold) (the state diagram, The consent line, steps 1 and 2); [Data model](../spec/04-data-model.md) (`tabs`, `policy_versions`); [API](../spec/08-api.md) (`POST /tabs`, `GET /tabs?state=`); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Tabs, card first); [screens: N23](../screens.md#n23-new-bar-tab-consent-line-and-slip), [Rail note 13](../screens.md#rail); [milestones: GA-M11](../milestones.md#must-fix-items-and-where-they-close)
- **Build:**
  - `tabs` with its seven states (open, tipping, awaiting_tip, captured, walkout_captured, capture_failed, closed) and the moves the Payment flows diagram allows, enforced in one function, plus the partial unique index on `card_fingerprint` while a tab is open.
  - New tab puts the bar reader to work and shows the consent line, built from the `tabs` settings and saved as a `policy_versions` row: "We'll hold $50 on this card and add to it as you order. We charge your tab when you close out, or at 4:30 AM if it's still open. Add your tip on the reader." [Read to guest ✓] records `consent_read_by` and `consent_text_version`.
  - `POST /tabs`: a PaymentIntent with `payment_method_types[]=card_present`, `capture_method=manual`, `payment_method_options[card_present][request_incremental_authorization_support]=true`, and `setup_future_usage=off_session` with a Customer, for the opening hold ($50.00); the reader collects the card first with `collect_payment_method`, `collect_config[skip_tipping]=true` and `collect_config[allow_redisplay]=limited`; the API checks the card's fingerprint against the venue's open tabs before `confirm_payment_intent`, and a match cancels the PaymentIntent unconfirmed, places no second hold, and opens that tab instead.
  - After it succeeds: store `incremental_authorization_supported`, overcapture support, `amount_authorized`, `capture_before`, and the saved card (`generated_card`) if Stripe returned one.
  - The label: a dip or swipe brings the name; for a tap or a phone, the bartender types a first name or taps a label such as Seat 3 or By the stage. The brand and last four always show and can be searched.
  - The tab slip prints the same consent line.
  - Quick-sale drinks rung before the card was taken move onto the new tab unsent.
  - No new tabs offline: New tab grays out, with the reason, while the bar computer isn't online.
  - In parties mode, New tab asks for the party size.
- **Acceptance:**
  - [x] Opening a tab for a tapped phone takes 4 taps (New tab, Read to guest ✓, a label, Open) and under 20 seconds, reading the line included; Stripe shows a $50.00 authorization with incremental support.
  - [x] Tapping Jess P.'s Visa ··4417 at New tab opens her tab, and Stripe shows no second hold.
  - [x] Every tab stores who read the line and its version, and its slip prints the same words.
  - [x] With the bar computer offline, New tab is grayed out with the reason.
- **Tests:** sandbox integration on simulated readers; the repeat-tap test; property tests of the tab state machine; a timed end-to-end.
- **Notes:** Open question: does a card that's collected but not confirmed carry its fingerprint (Stripe, M6)? Cautious default: check before confirming when the fingerprint is there; when it isn't, confirm, check straight after, and on a match cancel the new PaymentIntent at once (releasing its hold) and open the existing tab. A phone and the plastic card behind it read as two cards, so this catches repeat taps, not every duplicate. Closes GA-M11's "the 4:30 AM charge told when a tab opens" and "no new tabs offline".
  - Built: `tabs` moves go through `moveTab()` (apps/api/src/tabs/state.ts), which allows only the diagram's moves (`canMoveTab` in packages/shared, with seeded random-walk property tests); the partial unique index on the fingerprint while `open` or `tipping` came with M6-02. Migration 0079 adds the `tab_consent` policy kind, `tabs.consent_text_version` as a foreign key, and `tab_openings`, where a tab waits while the reader collects the card (added to the data model).
  - The consent line is built from the `tabs` settings (`tabConsentLine`, "$50" and "4:30 AM" at West 4) by `GET /tabs/consent`, which saves a new `policy_versions` row only when the words change; `POST /tabs` refuses a stale version. The slip's lines (`tabSlip`, apps/api/src/tabs/slip.ts) print the tab's own version of the line, wrapped to 32 columns; printing the slip itself comes with M6-09.
  - `POST /tabs` takes the check number first, then the run (M4-05) makes a Customer and a $50.00 manual-capture PaymentIntent with incremental support and `setup_future_usage=off_session`, and the bar reader collects with `skip_tipping` and `allow_redisplay=limited`. Once collected (webhook, poll or `check-status`), the fingerprint is checked under a lock before `confirm_payment_intent`; a match cancels the PaymentIntent unconfirmed and opens that tab. On the hold, the payment stores incremental and overcapture support, `capture_before` and the saved card; the tab gets its card ("Visa ··4242"), hold, consent version and reader, and the opener's Quick sale round moves onto it unsent.
  - The ticket's cautious default is built: with no fingerprint before confirm, the card is checked on the hold, and a match releases the new hold at once (`tab.release_hold` job). The fake Stripe now gives card fingerprints, brands, a dip's cardholder name and the hold terms.
  - The bar POS: New tab (greyed out with "No new tabs while the bar computer is offline." while the screen is offline), the consent line, Read to guest ✓, then a first name or a label (Seat 1–8, Standing, By the stage, Window, from the canvas, minus labels on open tabs) and Open while the guest taps; a card with an open tab jumps to it ("Jess P.'s tab is already open on this card…"). Parties mode (`pay.gratuity.auto` = parties) asks the party size before Read to guest ✓.
  - Flagged: the spec says New tab puts the reader to work; here it starts at Read to guest ✓, one tap later, so the consent is always recorded before a card can be read (still 4 taps). Labels are stored in the bartender's language ("Asiento 3"). The seed's five tabs have no fingerprints yet, so Jess P.'s ··4417 is matched in the tests by setting hers; M6-27 opens the seed's tabs through this flow on the sandbox.

### M6-07 · Grow the hold, and handle a declined raise

- **Status:** done
- **Size:** M
- **Depends on:** M6-03, M6-06; M4-05; M2 (approvals)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#bar-tab-with-a-growing-hold) steps 3 and 4; [Money rules](../spec/05-money-rules.md) rule 12; [Stripe setup](../spec/06-stripe-setup.md) step 5; [Data model](../spec/04-data-model.md) (`approvals` kind `over_hold`, `payments.increments_used`); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`tabs.flagOverCents`)
- **Build:**
  - When a send, a move onto the tab or a song line (M6-19) would take the tab near its hold, call `increment_authorization` with a new total first, keyed `<payment_id>:increment:<attempt_no>` with the target amount named in the key. Steps are sized to finish within 8 of Stripe's 10 attempts, declines included, keeping 2 for closing. Growing works only while the reader and the API are online.
  - A declined raise (`card_declined`): the old hold stays good, the tab's badge reads "Hold raise declined" (`tab.hold_declined`), and new drinks on it answer `202 approval_pending` (kind `over_hold`) until a manager OKs them or another card is added.
  - A card that can't grow: orders are capped at the hold plus the overcapture allowance, minus a 25% tip reserve, and the bar screen says so ("Hold · $6 left").
  - The check shows the headroom in dollars; a tab over `tabs.flagOverCents` ($600) shows on the manager on duty's phone.
  - A timed-out raise is an unknown attempt, handled as M4's unknown rules say.
- **Acceptance:**
  - [x] Luis M.'s hold grows from $50.00 to $80.00 as his rounds are sent, with `increments_used` at 1.
  - [x] A declined raise on Jess P.'s tab shows "Hold raise declined"; her next round waits for Andy ("Waiting for Andy"), and her $50.00 hold still stands.
  - [x] A raise that times out shows "Checking with Stripe · don't retry" and ends in one known state, with nothing sent twice.
  - [x] A card without incremental support caps the tab, and the chip shows what's left on the hold.
  - [x] A tab passing $600.00 shows on Andy's phone.
- **Tests:** sandbox integration on simulated readers with incremental support; a declined increment through the fault-injection client; unit tests for step sizing (never past 8 of 10 before close).
- **Notes:** Spec gaps: what "near the hold" is, and how steps are sized, aren't set. Cautious default: raise when the tab's balance after the send, plus a 25% tip reserve on its drinks, would pass the hold, to the larger of that amount and 1.5 × the current hold, rounded up to the next $10. That reproduces Luis M.'s $50.00 → $80.00. Flagged for the founder.
  - Built: `packages/rules/src/hold.ts` (the 25% tip reserve, the step to max(need, 1.5 × hold) up to the next $10, the cap at the hold plus the overcapture allowance of 50% or $50, and the budget of 8 of Stripe's 10 attempts), with unit tests that grow tabs by every round size and never pass 8. Migration 0080 adds `tabs.hold_declined_at` and `tabs.flagged_over_at` (added to the data model).
  - A send onto an open tab with a placed hold (`sendRound`, apps/api/src/tabs/hold.ts) places the round inside a savepoint to see what the tab would need. If it fits, it stays; if the card can grow, it's rolled back, an `increment` attempt is written (key `<payment_id>:increment:<attempt_no>:<target>`, `increments_used` + 1 for every attempt, declines and unclear ones included), the payment run calls `increment_authorization` outside any transaction, and the send is tried once more. Luis M.'s first round (a small bucket) takes $50.00 to $80.00; his shots then fit, `increments_used` 1.
  - A declined raise (`card_declined`) keeps the old hold, sets the tab's "Hold raise declined", and every round on it (even one that fits) answers `202 approval_pending` (kind `over_hold`, routed to the manager on duty, "Waiting for Andy" on the tab row); the drinks leave the draft with the request, and Andy's OK places them as the person who rang them, with the alcohol checks run again (a closed tab or a refused round expires the request). Clearing the mark when another card is added comes with M6-11's card change.
  - A card that can't grow (or has used its 8 attempts) is capped: a round past the cap is refused (`hold_cap`, "This card's hold can't grow…"), and the tab row shows "Hold · $6 left". The check shows "Hold · $X left" for every held tab.
  - An unclear raise is an unknown attempt: the send answers `202 payment_unknown` ("Checking with Stripe · don't retry") and the round stays unsent; another Send asks nothing of Stripe. The poller and the reconciler read the PaymentIntent: a hold at the target settles it, and one still unclear after 2 minutes ends as `not_raised` with the old hold standing. A raise never cancels the hold (`cancelPayment` and the poller now know increments).
  - A tab whose total passes `tabs.flagOverCents` is pushed once to the manager on duty ("Tariq A.'s bar tab passed $600.00: it's at …", opening Tonight).
  - Fake Stripe: `increment_authorization` as Stripe runs it (held PaymentIntents whose card allows it, a higher amount, 10 at most), and a fake-only `card_present[incremental]=false` for a card that can't grow. Declines and timeouts come through the fault-injection client.
  - Read as: the round that triggers a declined raise itself goes to the manager; a non-decline failure of a raise answers `stripe_error` ("hold_not_raised") with the round left unsent. A refused round at approval time isn't logged in `alcohol_refusals` (it expires). Moves onto a tab (M6-13) and song lines (M6-19) should call `sendRound`'s hold check when they're built. The seed's five tabs have no hold payments yet, so they send as before (M6-27).

### M6-08 · Close a tab with the tip on the reader

- **Status:** todo
- **Size:** M
- **Depends on:** M6-07; M4-07, M4-19
- **Spec:** [Payment flows](../spec/07-payment-flows.md#bar-tab-with-a-growing-hold) step 5; [Stripe setup](../spec/06-stripe-setup.md) step 4 (`collect_inputs`); [Money rules](../spec/05-money-rules.md) rules 9 and 10; [API](../spec/08-api.md) (`POST /tabs/{t}/close`); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Close to the held card, Receipt); [milestones: GA-M11](../milestones.md#must-fix-items-and-where-they-close)
- **Build:**
  - `POST /tabs/{t}/close` with the tip path (reader, slip or none) finalizes the tab's check: items plus tax, plus a gratuity only where the venue adds one to bar tabs, in which case the reader skips the tip and the receipt reads "Gratuity included".
  - The reader path: the tab moves to `tipping`, and `collect_inputs` on the bar reader asks for the tip: a selection of the venue's three percentages of the drinks before tax, each shown with its amount ($1, $2 and $3 on a tab under $10), then Custom, which asks for a number, and No tip. The API captures the total plus the tip in one call (`capture` with `amount_to_capture`, keyed by the amount) and records the tip with `set_tip()`.
  - Stripe lets bars capture up to 50% more than the hold, or $50 more, whichever is greater; above that the close raises the hold first and then captures; anything still over goes on the saved card, or the tab becomes `capture_failed` for a manager.
  - Cancel on the reader puts the tab back to `open`; a tip screen left untouched for 2 minutes moves to the slip (M6-09).
  - The receipt: Text (the guest types their number on the reader), Print or No receipt.
  - The tip the guest picked on the reader (the choice, amount, time and reader) is kept with the payment as dispute evidence.
  - With the card fee on, a surcharge can't rise with a growing hold, so such a venue closes its tabs with a fresh tap (M4-25's surcharge path).
- **Acceptance:**
  - [ ] Closing Jess P.'s $32.66 to her card offers $5.40, $6.00 and $6.60, Custom and No tip; picking $6.00 captures $38.66 in one call, and the tab is `captured`.
  - [ ] Closing a tab with a tip takes 2 taps on the tab (Close tab, Close to the card) and under 20 seconds with the guest.
  - [ ] Luis M.'s $63.15 with a 22% tip ($12.76) captures $75.91 on his $80.00 hold with no raise; a total over $130.00 (his hold plus $50) raises first.
  - [ ] A capture that times out ends as one capture after the reconciler, never two.
  - [ ] Tariq A.'s tab after Andy approves the void ($9.80) offers $1, $2 and $3.
  - [ ] With the reader offline at close, the slip is offered.
- **Tests:** the money-cases groups `tips` (`tip_choices_t1` to `tip_choices_t5`, `tip_choices_t5_after_void`, `tip_choices_999_fixed`, `tip_choices_1001_percent`) and `bar_tabs`; sandbox captures with overcapture on simulated readers; chaos (killed between the capture's success and our record).
- **Notes:** Open question: does a tip picked through `collect_inputs`, with no signed slip, hold up in a dispute like a signed receipt (Stripe, M6)? Cautious default: keep the reader's answer as evidence, and keep the slip path one setting away (`pos.barTabTip`). A tab of exactly $10.00 follows Stripe's smart tip threshold (money-cases ambiguity A3). Whether a surcharge can follow a growing hold is open with Stripe (not the gate; the fee is off at West 4).

### M6-09 · Fall back to the paper slip, and enter tips from Tips to enter

- **Status:** todo
- **Size:** M
- **Depends on:** M6-08; M2 (files, approvals); M4-19
- **Spec:** [Payment flows](../spec/07-payment-flows.md#bar-tab-with-a-growing-hold) steps 5 and 7; [Data model](../spec/04-data-model.md) (`approvals` kind `tip_review`, `payments.adjusts_business_date`); [API](../spec/08-api.md) (`GET /tabs?state=awaiting_tip`, `POST /tabs/{t}/tip`); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`pay.tipReview`, `pos.barTabTip`); [screens: N26](../screens.md#n26-tips-to-enter), [Staff note 11](../screens.md#staff)
- **Build:**
  - Printing the paper slip (for a reader that's offline, a guest who asks for one, or a tip screen untouched for 2 minutes) moves the tab to `awaiting_tip`; the hold stays; `tab.awaiting_tip` goes out.
  - Tips to enter on staff phones (`GET /tabs?state=awaiting_tip`): each slip with its card and total. Entering the tip from the signed slip takes a photo of the slip (`POST /files`) and captures the total plus the tip (`POST /tabs/{t}/tip`).
  - A tip over 25% or $50, or entered more than 2 hours late, answers `202 approval_pending` (kind `tip_review`), routed to the manager on duty, or to the owner if that manager entered the slip.
  - A tip entered after the Z report posts to the next business date, with `adjusts_business_date` pointing at its night.
  - With `pos.barTabTip` set to slip, closing prints the slip first; the slip is the fallback either way.
- **Acceptance:**
  - [ ] Tips to enter lists Dev S. (Visa ··3318), Tom W. (Mastercard ··0457) and Ana R. (Amex ··2204), each with its photo, and never Jess P.'s Visa ··4417.
  - [ ] Ana R.'s $12.00 tip on $62.50 captures $74.50 with no approval; a $20.00 tip goes to Andy; one entered 2 h 1 min after signing goes to Andy; one Andy entered himself goes to Abhishek.
  - [ ] A $50.01 tip on a $300.00 tab goes to Andy.
  - [ ] No tip can be entered without the slip's photo.
- **Tests:** the money-cases group `tips` (`tip_review_normal`, `tip_review_over_25pct`, `tip_review_over_50_dollars`, `tip_review_entered_late`); approval routing tests; end-to-end on Andy's phone.
- **Notes:** A tip's 25% is taken of the tab total (money-cases ambiguity A4). The canvas puts Visa ··4417 on a slip ([Staff note 11](../screens.md#staff)). Close the night's "3 slips not entered · tips post to Sat Sep 26" is M7's.

### M6-10 · Split a tab and keep its paid shares

- **Status:** todo
- **Size:** M
- **Depends on:** M6-08; M4-14
- **Spec:** [Payment flows](../spec/07-payment-flows.md#bar-tab-with-a-growing-hold) step 8; [Money rules](../spec/05-money-rules.md) rules 1 and 13; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Paying at the bar: Split); [screens: Rail note 2](../screens.md#rail)
- **Build:**
  - Split evenly 2, 3 or 4 ways on the tab (M4's `check_splits` and `split_shares`), share by share on the reader, with the first share on the held card; shares in cents by largest remainder, the first share taking any extra cent; any share can be paid in cash.
  - The split lives on the server, so it survives leaving the pay panel and switching tabs; the tab list shows "Partly paid · $16.33 of $32.66"; the next charge is always the rest; "Stop splitting · charge the rest to …" ends it, keeping the paid shares.
  - The tab stays `open`, and its check `partly_paid`, until the last share is paid.
  - The held card's share is captured last, with its tip asked on the reader when its turn comes, so the hold keeps guaranteeing the rest until the other shares are paid.
- **Acceptance:**
  - [ ] Jess P.'s $32.66 splits into $16.33 + $16.33; after one share is paid in cash, leaving the pay panel and coming back still shows "Partly paid · $16.33 of $32.66".
  - [ ] $32.67 splits into $16.34 + $16.33, and Luis M.'s $63.15 in four is $15.79, $15.79, $15.79 and $15.78.
  - [ ] "Stop splitting · charge the rest to Visa ··4417" after one paid share captures the rest on her held card.
  - [ ] A guest who walks out mid-split still leaves the hold to charge the rest at 4:30 AM.
- **Tests:** the money-cases group `splits`; sandbox integration; end-to-end (leave the panel, switch tabs, come back).
- **Notes:** The canvas forgets a paid share and splits $32.66 into $16.32 and $16.34 ([Rail note 2](../screens.md#rail)). The spec doesn't order the shares; capturing the held card's share last is our reading of "no hold canceled until its replacement has succeeded" ([Payment flows](../spec/07-payment-flows.md)); flagged.

### M6-11 · Pay a tab with another card or cash

- **Status:** todo
- **Size:** M
- **Depends on:** M6-08; M4-13
- **Spec:** [Payment flows](../spec/07-payment-flows.md#paying-with-a-different-card) and [Bar tab step 7](../spec/07-payment-flows.md#bar-tab-with-a-growing-hold); [Money rules](../spec/05-money-rules.md) rule 12; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Another card, Cash); [milestones: GA-M11](../milestones.md#must-fix-items-and-where-they-close)
- **Build:**
  - Another card: a new PaymentIntent for the tab's balance as a new attempt, with the tip on the reader; only after it succeeds does the API move the hold's allocation to it, in the same transaction, and cancel the old hold (`POST /v1/payment_intents/{id}/cancel`). If the new card is declined, the old hold still guarantees the tab.
  - Cash, always offered: the cash payment takes over the hold's allocation, then the hold is canceled, and the tab closes as `closed`.
  - Settling a check any other way cancels its open card holds.
- **Acceptance:**
  - [ ] Hana K. pays $43.55 with another card: the new card is charged, then her $50.00 hold on Visa ··5120 is released, and Stripe shows the old PaymentIntent canceled after the new one succeeded.
  - [ ] A declined new card leaves the $50.00 hold in place.
  - [ ] Seat 6 pays $13.07 in cash: the bar drawer opens, the hold is canceled, and the tab closes.
  - [ ] Killed after the new card succeeds but before the hold is canceled, the reconciler cancels the old hold and nothing is charged twice.
- **Tests:** sandbox integration; chaos; end-to-end.
- **Notes:** Closes GA-M11's "cash always taken" on the bar POS.

### M6-12 · Reopen a settled tab and charge the saved card

- **Status:** todo
- **Size:** M
- **Depends on:** M6-08, M6-11; M4-21, M4-22; M2 (approvals)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#bar-tab-with-a-growing-hold) step 9; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Closed tonight); [API](../spec/08-api.md) (`POST /tabs/{t}/reopen`, `/charge-saved-card`); [screens: Rail notes 3 and 18](../screens.md#rail), [N22](../screens.md#n22-refund-from-check)
- **Build:**
  - Closed tonight lists every settled tab (captured, walkout_captured or closed) until the night closes, and Reopen (`POST /tabs/{t}/reopen`) brings one back with what was paid kept as paid.
  - A reopened tab whose hold was captured has no hold: its chip reads "Paid $272.19 · no hold", and it never offers "Close to card". New drinks are paid by a new tap, by cash, or by Charge the saved card (`POST /tabs/{t}/charge-saved-card`: the card saved from the first tap, charged off-session), which needs the guest's Yes on the bar reader (`collect_inputs`) or a manager's OK (`202`, kind `card_on_file`). With $0 due, no pay buttons show.
  - Managers refund from Closed tonight through Refund from check (M4).
- **Acceptance:**
  - [ ] A tab captured at $272.19 and reopened shows "Paid $272.19 · no hold" and no "Close to card", and with nothing added it shows no pay buttons.
  - [ ] A new $9.00 Modelo on it can be paid by Charge the saved card once the guest taps Yes on the reader, or once Andy approves.
  - [ ] Andy's refund of a line from Closed tonight waits for Abhishek.
- **Tests:** sandbox integration (the generated card charged off-session); end-to-end.
- **Notes:** The seed has no tab at $272.19; the test builds one from Moët & Chandon · bottle and Large bucket · 10 beers ($250.00 plus $22.19 of tax, No tip). The canvas reopens with a hold chip and "Close to Mastercard" ([Rail note 3](../screens.md#rail)). A wallet tap may leave no saved card, and then Charge the saved card doesn't show.

### M6-13 · Move a tab into a room, and move lines between tabs

- **Status:** todo
- **Size:** M
- **Depends on:** M6-07; M4-07, M4-09; M3 (the alcohol check, room cut-offs)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#moving-a-tab-into-a-room); [Money rules](../spec/05-money-rules.md) rules 5, 9 and 12; [API](../spec/08-api.md) (`POST /tabs/{t}/move-to-room`, `POST /checks/{c}/lines/{l}/move`); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Move tab to a room, Changing a sent drink); [screens: Rail notes 7 and 8](../screens.md#rail)
- **Build:**
  - Move tab to a room lists the rooms in use; every line moves as a transfer in one transaction, a `transfer_out` line on the tab and a `transfer_in` line on the room's check that reads "Moved from Jess P.'s bar tab"; the tab closes as "Moved to Room 9" (`moved_to_check_id`). Moved drinks are items of the room check and carry its gratuity.
  - A move runs the same checks as a send: alcohol can't move onto a cut-off room (`409 cut_off`, with the reason, logged), and where rooms carry holds the room's hold is raised first.
  - The tab's hold is canceled once the room has a payment method: the booking's saved card (at once for Room 9), the room's own hold, or a card tapped for the room (`process_setup_intent` on the reader saves it without charging, with the consent read out and stored as for a tab). Until then its allocation follows the moved lines onto the room's check, up to the hold, and the room tab shows the hold with the tab's name.
  - Moving one drink to another tab (the fix panel's Move) needs no approval, logs on both tabs, runs the hold-raise check, and the list of tabs grays out cut-off tabs for alcohol, with the reason.
- **Acceptance:**
  - [ ] Moving Jess P.'s tab into Room 9 moves 2 × Modelo and the Jäger Bomb as "Moved from Jess P.'s bar tab" lines, closes her tab as "Moved to Room 9", and releases her $50.00 hold at once, since Marcus's Amex ··1005 is saved.
  - [ ] Room 9 then presents (with o1 cancelled) at a $510.00 subtotal, $45.26 tax, $102.00 gratuity and $657.26 in all, with $537.26 left.
  - [ ] With Room 9 cut off, the move is refused with the cut-off's reason and logged.
  - [ ] Moving 2 × Modelo onto Hana K.'s tab is refused, and the tab list grays her tab out for alcohol with the reason.
  - [ ] Moving Seat 6's tab into Room 5, a walk-in with no saved card, keeps its hold on the room's check until a card is tapped for Room 5.
- **Tests:** `packages/rules` unit tests for the moved lines' tax and gratuity; sandbox (`process_setup_intent` on a simulated reader); end-to-end.
- **Notes:** The canvas moves single lines and leaves a $0 tab holding $50 ([Rail note 7](../screens.md#rail)), and lets 2 × Modelo move onto Hana K.'s cut-off tab ([Rail note 8](../screens.md#rail)). Spec gap: moving a whole tab with some alcohol onto a cut-off room isn't spelled out; cautious default: refuse the whole move with the reason. A room's own hold (`pay.roomHold`) is off at West 4 and in no milestone ([Open points](#open-points)).

### M6-14 · Cut off a tab, and gray out alcohol on the bar POS

- **Status:** todo
- **Size:** S
- **Depends on:** M6-02; M3 (the alcohol check, room and guest cut-offs, the 4 AM stop)
- **Spec:** [Money rules](../spec/05-money-rules.md) rule 5; [Data model](../spec/04-data-model.md) (`tabs.cut_off_at`, `alcohol_refusals`); [API](../spec/08-api.md) (`POST /tabs/{t}/cut-off`); [Tenancy and access](../spec/02-tenancy-access.md) (Roles); [screens: N16](../screens.md#n16-no-more-alcohol-cut-off), [Rail note 9](../screens.md#rail); [milestones: GA-M7](../milestones.md#must-fix-items-and-where-they-close)
- **Build:**
  - `POST /tabs/{t}/cut-off` with a reason records who, when and why on the tab and logs a refusal in `alcohol_refusals`; every screen for that tab shows "Cut off by Andy at 10:30 PM" and grays out alcohol; sends, repeat rounds, moves and gift orders of alcohol onto it answer `409 cut_off`; singing is still fine.
  - Outside the alcohol window (4:00 to 8:00 AM at West 4), every alcohol button on the bar POS grays out with the reason in words; after 4 AM the room-order cards offer no Decline and list "Cancelled at 4:00 AM".
  - Owners, managers, bartenders and the front desk can cut off; a runner can't.
- **Acceptance:**
  - [ ] Hana K.'s tab shows "Cut off by Andy at 10:30 PM" on the bar POS and on every screen for it; her alcohol is grayed out; her song (position 5) still starts.
  - [ ] At 4:02 AM (simulated), every alcohol button on the bar POS is grayed out with the reason, and no room-order card offers Decline.
  - [ ] A runner's cut-off is refused.
- **Tests:** clock tests at 4:00:00 AM on a normal night and both daylight-saving nights; role tests; the end-to-end scenarios `cut_off_hana` and `alcohol_stop`.
- **Notes:** Closes GA-M7, with M3's room and guest cut-offs.

### M6-15 · Fix a sent drink on the bar POS and show who it's waiting for

- **Status:** todo
- **Size:** S
- **Depends on:** M6-02; M3 (the fix panel, reason-only limits, void approvals)
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Changing a sent drink, rule 6); [Money rules](../spec/05-money-rules.md) rule 7; [Tenancy and access](../spec/02-tenancy-access.md) (The reason-only limit, Approvals); [screens: Rail note 4](../screens.md#rail), [N18](../screens.md#n18-approvals-inbox)
- **Build:**
  - Tap a sent drink on the tab for Void, Comp or Move: M3's fix panel (made or not made, a reason, "$X left this shift", labeled VOID or COMP). Within the limit a reason is enough; over it the line shows "Waiting for Andy", the tab row carries the badge, the approver decides on their own phone, and the tab updates when `approval.decided` arrives.
  - "Charge the remaining tabs" skips a tab waiting on an approval (M6-16).
- **Acceptance:**
  - [ ] Diego's void of 1 × Large bucket · 10 beers ($70.00) on Tariq A.'s tab shows "Waiting for Andy" on the line and on the tab row until Andy decides; once he approves, Tariq's tab reads $9.00 of drinks, $0.80 tax and $9.80.
  - [ ] Maya's panel shows "$63 left this shift", and a $13.00 comp leaves "$50 left this shift".
  - [ ] Voiding a drink rung by mistake takes 4 taps (the line, Not made, a reason, Void) and under 6 seconds.
- **Tests:** the money-cases groups `reason_only_limits` and `approvals`, and `bar_tab_t5_after_void_approved`; a timed end-to-end.
- **Notes:** The Rail's fix panel is the model for every screen ([Rail note 4](../screens.md#rail)).

### M6-16 · Charge the remaining tabs, and run the 4:30 AM tab cut-off

- **Status:** todo
- **Size:** M
- **Depends on:** M6-08, M6-15; M1 (the scheduler)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#bar-tab-with-a-growing-hold) steps 6 and 7; [Data model](../spec/04-data-model.md) (Tabs at the cut-off and at close); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Charging the remaining tabs); [API](../spec/08-api.md) (`POST /nights/{date}/charge-remaining-tabs`); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`tabs.cutOffAt`); [Money rules](../spec/05-money-rules.md) rule 2; [screens: Night note 5](../screens.md#night)
- **Build:**
  - Close the night's open-bar-tabs part (M7 builds the rest of the screen): the open tabs with their totals and cards, and "Charge the remaining tabs" for managers, which after one confirmation showing how many cards and the total captures every `open` tab not waiting on an approval, each at its balance with no tip (`walkout_captured`).
  - The tab cut-off job at `tabs.cutOffAt` (4:30 AM wall clock on each business date, worked out per date by the UTC scheduler so a daylight-saving night neither skips nor repeats it): it closes every tab still `open` and captures its balance, up to the hold plus the overcapture allowance; anything left goes on the saved card, or the tab becomes `capture_failed`; the order times are kept as dispute evidence.
  - A `tipping` tab is left for up to 2 minutes, then treated as the `open` or `awaiting_tip` tab it has become; `awaiting_tip` tabs are left to the sweeper (M6-17); a `capture_failed` tab is never retried and alerts the manager on duty.
  - The tab states that Night's close needs (no `open` or `tipping` tabs, `awaiting_tip` allowed) are M7's check.
- **Acceptance:**
  - [ ] At the seed's state, Charge the remaining tabs shows 4 cards and $152.43 (Hana K., Jess P., Luis M. and Seat 6), skips Tariq A.'s tab while Diego's void waits, and captures each at its balance with no tip.
  - [ ] Left open until 4:30 AM (simulated), Jess P.'s tab is charged $32.66 as a walkout.
  - [ ] On Nov 1, 2026 and Mar 14, 2027 the cut-off runs once, at 4:30 AM local time.
  - [ ] A tab whose balance is over its hold plus the allowance, with a saved card that declines, becomes `capture_failed` and alerts Andy.
- **Tests:** clock tests (a normal night and both daylight-saving nights); sandbox captures; chaos (killed mid-job, the rerun captures nothing twice).
- **Notes:** "Charge the remaining tabs", never "Last call" ([Night note 5](../screens.md#night)). How drinking-up time is measured is with the lawyer (gate); the cut-off is the `tabs.cutOffAt` setting, so an answer changes a value, not code.

### M6-17 · Sweep awaiting-tip tabs, watch hold expiry, and settle failed captures

- **Status:** todo
- **Size:** M
- **Depends on:** M6-09, M6-16
- **Spec:** [Payment flows](../spec/07-payment-flows.md#bar-tab-with-a-growing-hold) steps 6 and 7; [Data model](../spec/04-data-model.md) (Tabs at the cut-off and at close); [Money rules](../spec/05-money-rules.md) rule 16; [screens: Night note 12](../screens.md#night)
- **Build:**
  - A sweeper captures any tab still `awaiting_tip` 12 hours before its `capture_before`, at a tip of 0, and flags it.
  - Any hold within 12 hours of expiring raises an alert (an in-person hold lasts at least two days, and 5 days for Visa).
  - `capture_failed` tabs stay on the manager's list with their balance until settled (another card, cash or the saved card), which moves them to `closed`. Money collected later posts to the current business date with `adjusts_business_date`, and these tabs don't hold up the night close.
- **Acceptance:**
  - [ ] Dev S.'s slip, never entered, is captured at its $48.00 total with a $0 tip 12 hours before its hold expires, and flagged.
  - [ ] A hold 11 hours from expiring alerts the manager on duty.
  - [ ] A `capture_failed` tab settled in cash the next day posts to that day, with `adjusts_business_date` Fri Sep 25.
- **Tests:** clock tests; sandbox integration (`capture_before` as Stripe reports it); end-to-end.
- **Notes:** M7's Close the night lists these tabs ([Night note 12](../screens.md#night)).

### M6-18 · Keep the song queue: singers, credits and the rotation

- **Status:** todo
- **Size:** M
- **Depends on:** M3 (the menu and orders); M2 (phone codes and texts); M4-28 (the prepaid-value ledger)
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) (Bar mode: Joining, Rotation, Credits); [Data model](../spec/04-data-model.md) (`singers`, `song_credits`, `song_queue`); [API](../spec/08-api.md) (Bar mode); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`barMode`); [milestones: GA-M11](../milestones.md#must-fix-items-and-where-they-close)
- **Build:**
  - `singers` (display_name, phone_e164 confirmed once by a code, token_hash, check_id once they owe something), `song_credits` (source drink or prepaid, the drink's line) and `song_queue` (round, position, status queued, singing, sung, skipped or removed; pay_with credit or price; staff moves with who and why).
  - Joining at the bar: `POST /singers` (+ Singer) with a display name and a number confirmed by a code; joining from a phone is M6-20.
  - Rotation: round-robin by singer, `barMode.songsPerRound` songs per singer per round (1 at West 4). `POST /song-queue` adds a song; `/song-queue/{q}/move` moves one up or down with a reason, and it's logged.
  - Credits: a drink rung on a singer's tab earns a credit by itself; a drink bought at the bar without a tab earns one when the bartender picks the singer on the sale (`POST /singers/{s}/credits`); queuing a song holds a credit.
  - With no song price (West 4), a song without a credit is flagged "Needs a drink credit" and can't start; a cut-off from alcohol never stops anyone singing.
  - Prepaid song credit bought at a song price (paid in cash to staff) goes through the prepaid-value ledger; West 4 sets no song price.
  - `song_queue.updated` on every change.
- **Acceptance:**
  - [ ] The seed's queue loads as round 3 with 23 songs sung: Luis M. singing "Mr. Brightside", then Jess P., Kira, Ben T., Tariq A., Hana K. and Sofia R., and the bar POS header reads "Song queue · 6".
  - [ ] Sofia R., with no credits and no song price, is flagged "Needs a drink credit".
  - [ ] A second song from Jess P. goes into round 4, not round 3.
  - [ ] Moving Sofia R. up needs a reason, and the log shows who and why.
  - [ ] Tariq A.'s two tab lines (the Large bucket and a Modelo) gave him his 2 credits.
- **Tests:** unit tests for the rotation and for credits per drink; integration; end-to-end.
- **Notes:** Spec gaps: what counts as one drink for a credit isn't said; cautious default: one credit per unit sold (a bucket is one item) and none for a comped or voided unit, which fits the seed's credits. Where a new singer joins the rotation isn't said; cautious default: at the end of the current round, in join order. Both flagged.

### M6-19 · Start and skip songs: song lines, credits back and the play log

- **Status:** todo
- **Size:** M
- **Depends on:** M6-18, M6-07; M4-06
- **Spec:** [Payment flows](../spec/07-payment-flows.md#songs-on-a-tab); [Money rules](../spec/05-money-rules.md) rules 6 (Songs) and 8; [Song systems and texts](../spec/11-song-systems-texts.md) (Started and Skip, the play log); [Data model](../spec/04-data-model.md) (`song_plays`); [milestones: GA-M10 and GA-M11](../milestones.md#must-fix-items-and-where-they-close)
- **Build:**
  - `POST /song-queue/{q}/start` (Started): the singer before is marked sung, and this song's line posts to the singer's tab: $0.00 when it uses a credit (spending it), or the venue's song price, which grows the hold if needed. A singer with no tab uses their credit, and no line posts. A song is charged when it starts, never when it's queued.
  - Each start writes a `song_plays` row: the play log, with the tab or session, title, artist, `started_at` and source.
  - `POST /song-queue/{q}/skip`: free, and a credit held for the song comes back.
  - Song lines carry tax category `song` and are taxed at the rule pack's rate.
  - A singer without a tab, where there's a song price, opens a tab with a tap or pays cash to staff for prepaid credit.
- **Acceptance:**
  - [ ] Maya's Started on Luis M. at 10:39 PM put a $0.00 "Mr. Brightside · The Killers" line on his tab, spent his credit, and wrote the play log.
  - [ ] Started on Kira (no tab, 1 credit) spends her credit and posts no line.
  - [ ] Skipping Jess P.'s song gives her credit back and charges nothing.
  - [ ] Sofia R.'s song can't start until she has a credit.
  - [ ] On a test venue with a $5.00 song price, Started posts $5.00 and its tax to the singer's tab.
- **Tests:** unit tests; integration; end-to-end.
- **Notes:** The play log closes GA-M10 together with the license register in M8. Money rules rule 8 lists room time, drinks and damage fees as what phase 1 taxes, while GA-M11 says song lines are taxed; flagged. Nothing changes at West 4, whose songs are $0.00.

### M6-20 · Build the singer's queue page

- **Status:** todo
- **Size:** M
- **Depends on:** M6-18, M6-19; M5-01 (the site's "Sing at the bar"); M2 (the CAPTCHA on phone codes, the waitlist page)
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) (Joining, Screens, Songbook); [API](../spec/08-api.md) (the Bar mode public routes); [Tenancy and access](../spec/02-tenancy-access.md) (Singer in the bar queue); [screens: N9](../screens.md#n9-the-singers-queue-page), [Main note 1](../screens.md#main), [Waitlist note 5](../screens.md#waitlist)
- **Build:**
  - The queue page in `apps/guest`, reached from the site's "Sing at the bar", the waitlist page and the QR code on the Up next TV.
  - Join: a display name and a phone number confirmed once with a code (`POST /v1/public/venues/{slug}/singers`, `/singers/verify`), behind the CAPTCHA and daily limits on phone codes. The singer's token (128 bits, stored hashed) reaches only their own entries, and their tab once they owe something.
  - Song search through `GET /v1/public/venues/{slug}/songs?q=`; with no catalog yet, the singer types a title and artist.
  - My songs, their place ("2 singers before you"), their credits, and "Needs a drink credit" when they have none and no song price is set.
  - `GET` and `POST /v1/public/venues/{slug}/queue`; the page follows `song_queue.updated` and never shows another singer's phone number.
- **Acceptance:**
  - [ ] Ben T.'s page reads "2 singers before you" at 10:41 PM.
  - [ ] Sofia R.'s page shows "Needs a drink credit".
  - [ ] A new singer joins with a code and queues "Valerie" by typing it, with no catalog loaded.
  - [ ] No page shows any phone number but the singer's own.
  - [ ] The page passes the WCAG 2.2 AA checks.
- **Tests:** end-to-end; principal suite (the singer's token); accessibility checks in CI.
- **Notes:** The planned SingQueue board was never drawn ([N9](../screens.md#n9-the-singers-queue-page)). The spec doesn't say which page starts "Send the singer a drink", so the queue page doesn't offer it (see M6-24).

### M6-21 · Alert singers by push and text

- **Status:** todo
- **Size:** M
- **Depends on:** M6-19, M6-20; M2 (texts and STOP)
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) (Alerts; The automatic texts, #12 You're up next); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`barMode.alerts`); [decisions](../decisions.md) (D62)
- **Build:**
  - After every Started and Skip, each queued singer's place is worked out again as the singers still to start before them.
  - At `barMode.alerts.beforeYou` (2), a push: "2 singers before you".
  - When the singer before them starts, a push, "You're up next at the bar · come to the stage", and, with `upNextText` on, the You're up next service text: "You're up next at the bar. Come to the stage when this song ends."
  - Each alert goes once per queued song. A push needs the singer's phone to allow it, and the open page always shows the alert; STOP stops the text at once.
  - With Bar mode off, no alert or text goes out.
- **Acceptance:**
  - [ ] Ben T. gets "2 singers before you" by push; when Kira starts, he gets "You're up next at the bar · come to the stage" by push and "You're up next at the bar. Come to the stage when this song ends." by text (Twilio test credentials).
  - [ ] Songs started and skipped around him never send him the same alert twice.
  - [ ] A singer who texted STOP still gets the push but no text.
- **Tests:** integration (web push to a test subscription; Twilio test credentials); end-to-end.
- **Notes:** The per-singer limit and these alerts are GA-M11's guardrails; text reminders for unpaid tabs aren't adopted.

### M6-22 · Build the KJ's song-queue screen and the Up next TV

- **Status:** todo
- **Size:** M
- **Depends on:** M6-18, M6-19; M1 (pairing a shared device)
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) (Screens); [Devices, printing and offline](../spec/09-devices-printing-offline.md) (Up next display); [Tenancy and access](../spec/02-tenancy-access.md) (Up next display); [screens: N27](../screens.md#n27-kj-song-queue-screen), [N28](../screens.md#n28-up-next-tv), [Rail note 16](../screens.md#rail)
- **Build:**
  - The KJ screen in the desktop app, opened from "Song queue · 6" on the bar POS, from the bar orders screen and from the side menu: who's singing now, who's up next in order, the round, each singer's credits and flags, [Started], [Skip], move up or down with a reason, and [+ Singer]. It follows `song_queue.updated`.
  - The Up next TV: a device of kind `up_next_display`, paired like a shared device, on a channel that carries only the queue display: who's singing now, the next `barMode.upNextCount` (5) singers and a QR code to join. It never shows a phone number.
- **Acceptance:**
  - [ ] The KJ screen shows Luis M. singing, then Jess P., Kira, Ben T., Tariq A., Hana K., and Sofia R. flagged "Needs a drink credit".
  - [ ] The TV shows Luis M., the next five (Jess P., Kira, Ben T., Tariq A., Hana K.) and the join QR code, and no message on its channel carries a phone number (a test scans every one).
  - [ ] Started on the KJ screen updates the TV and the singers' queue pages within 3 seconds.
- **Tests:** end-to-end; channel-filter tests.
- **Notes:** The planned KJ and UpNext boards were never drawn ([N27](../screens.md#n27-kj-song-queue-screen), [N28](../screens.md#n28-up-next-tv)).

### M6-23 · Upload the songbook CSV and search it

- **Status:** todo
- **Size:** M
- **Depends on:** M6-20; M2 (`POST /files`)
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) (Songbook); [Data model](../spec/04-data-model.md) (`song_catalog`); [API](../spec/08-api.md) (`POST /songbook/uploads`, `GET /v1/public/venues/{slug}/songs?q=`, Files); [screens: N34](../screens.md#n34-admin--bar-mode); [decisions](../decisions.md) (D63)
- **Build:**
  - Admin → Bar mode → Songbook upload: a CSV of title, artist and code, up to 5 MB, through `POST /files` and then `POST /songbook/uploads`, which checks every row, loads `song_catalog` (`vendor_code` from the code, `source_file_id`) and replaces the last upload; rows that fail are listed with their line numbers.
  - `GET /v1/public/venues/{slug}/songs?q=` searches title and artist through a trigram index, for the queue page and the website's song section.
  - West 4's Playbox catalog comes only from Playbox or from West 4, and nothing is ever scraped.
- **Acceptance:**
  - [ ] A songbook CSV loads, and searching "brightside" on the queue page finds "Mr. Brightside · The Killers".
  - [ ] A second upload replaces the first.
  - [ ] A file with a missing title on line 12 reports line 12.
  - [ ] Once a catalog exists, the website's song section shows its search box (M5-01).
- **Tests:** parser unit tests; integration; end-to-end.
- **Notes:** A vendor's own catalog file needs its written agreement first; phase 1 runs every song system as `none`.

### M6-24 · Send the singer a drink as a checked gift order

- **Status:** todo
- **Size:** S
- **Depends on:** M6-18, M6-07; M3 (orders, the alcohol check)
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) (Send the singer a drink); [Data model](../spec/04-data-model.md) (`orders.gift_for_singer_id`, `gift_for_check_id`, Room orders); [API](../spec/08-api.md) (`POST /tabs/{t}/gift-order`); [Money rules](../spec/05-money-rules.md) rule 5; [decisions](../decisions.md) (D64)
- **Build:**
  - `POST /tabs/{t}/gift-order` from the sender's tab on the bar POS: an order with source `gift` naming the singer and the receiving tab, charged to the sender's tab through the hold-raise check, that rings the bar like any order.
  - The alcohol check runs against the receiving tab and the window: a cut-off receiving tab, or a time outside the window, answers `409 cut_off` or `409 alcohol_closed` with the reason, logged in `alcohol_refusals`.
  - The ticket names the singer and tells the bartender to check ID at hand-off.
- **Acceptance:**
  - [ ] Tariq A. sends Jess P. a Modelo: it rings the bar, goes on Tariq's tab, and the ticket names Jess.
  - [ ] A gift of alcohol to Hana K. (cut off) is refused with "Cut off by Andy at 10:30 PM" and logged, and a gift at 4:02 AM is refused with the 4 AM reason.
- **Tests:** integration; clock tests.
- **Notes:** Closes GA-M11's "gift orders checked for cut-offs". The spec doesn't say which page a guest starts a gift from, so M6 builds it for staff on the bar POS and leaves guest pages without it; flagged.

### M6-25 · Build Admin → Bar POS

- **Status:** todo
- **Size:** M
- **Depends on:** M6-01, M6-06; M1 (Admin)
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (Admin → Bar POS); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`PosSettings`, `TabSettings`, When a change starts); [screens: N33](../screens.md#n33-admin--bar-pos), [AdminDesk notes 1, 2 and 12](../screens.md#admindesk); [glossary](../glossary.md#the-escalation-sentence)
- **Build:**
  - One section editing `pos` and `tabs` together: Layout (M6-01); Limits (the reason-only limit each and per shift, $25 and $75, where 0 sends every comp and void for approval); Locks (idle lock 3 minutes, Wipe screen 10 seconds); Tip path (reader or slip, the slip the fallback either way); Order aging (bar phones 30 s, amber and the Board alert 2 min, pink and the manager on duty 4 min, a text or call 6 min; the chime; Mute 1 min); and Tabs (the $50 opening hold, the $600 flag and the 4:30 AM cut-off).
  - The escalation sentence reads as the glossary words it.
  - Saving the tab settings writes a new `policy_versions` row for the consent line; tabs already open keep the version that was read to them.
  - Changes are live at once, except a layout, which starts at the next business date.
  - No "Ring the bar until someone accepts" toggle.
- **Acceptance:**
  - [ ] West 4 shows the values above; setting the opening hold to $60 changes the consent line to "We'll hold $60 on this card…" for new tabs only.
  - [ ] A per-shift limit of 0 sends every comp and void for approval.
  - [ ] A new amber time changes the Board's and the bar screens' aging at once.
- **Tests:** settings validation; end-to-end.
- **Notes:** Whether the front desk can use the bar POS when covering the bar is a role permission in Admin → Team (M1), not here. M3's aging ran on West 4's defaults until this section.

### M6-26 · Build Admin → Bar mode

- **Status:** todo
- **Size:** S
- **Depends on:** M6-18, M6-23
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`BarModeSettings`, promotion checks); [Song systems and texts](../spec/11-song-systems-texts.md) (Bar mode, Promotions); [screens: N34](../screens.md#n34-admin--bar-mode), [AdminDesk note 27](../screens.md#admindesk); [Open technical questions](../spec/14-open-questions.md)
- **Build:**
  - The `barMode` editor: the song price ("Song price · not set · songs need a drink credit" at West 4), the drink credit ("Buy a drink, get a song", on), free nights, songs per round (1), singer alerts (2 singers before you, and the You're up next text), how many singers the TV shows (5), and the songbook upload (M6-23).
  - Every save runs the rule pack's promotion checks.
- **Acceptance:**
  - [ ] West 4 shows "Song price · not set · songs need a drink credit", drink credit on, 1 song per round and both alerts on.
  - [ ] A free drink with a song can't be set up: the promotion checks refuse it with the reason.
- **Tests:** settings validation; end-to-end.
- **Notes:** West 4's song price is the founder's open question; M6 ships it unset, and Admin can set it any time. "Buy a song, get a drink" waits for the lawyer ([Open technical questions](../spec/14-open-questions.md)).

### M6-27 · Load the seed's bar tabs, slips and singer queue into staging

- **Status:** todo
- **Size:** M
- **Depends on:** M6-06 to M6-19
- **Spec:** [Demo seed](../demo-seed.md#bar-tabs-room-tabs-and-paper-slips), [the singer queue](../demo-seed.md#the-singer-queue), [loading the seed](../demo-seed.md#loading-the-seed); [seed file](../../seed/west4-friday.json) (`bar_tabs`, `approvals`, `reason_only_used_tonight`, `tip_slips`, `singers`, `song_queue`, `up_next_tv`, `order_drafts`)
- **Build:**
  - The seed loader's M6 parts: the five open tabs, each opened through the real flow on a simulated reader so its hold is a real sandbox authorization (Luis M.'s grown to $80.00, Tariq A.'s at $100.00); Hana K.'s cut-off by Andy at 10:30 PM; Diego's pending void (appr_1); Maya's $12.00 comp line (ln_t2_5); the three paper slips as `awaiting_tip` tabs with their photos; the singers, the queue and the TV; Diego's Red Bull draft; and West 4's first `pos_layouts` version from the Rail board.
  - The seed's card brands and last fours stay on our rows for display, over Stripe's test cards of the same brands.
- **Acceptance:**
  - [ ] After a load, Maya's bar POS matches the seed: five tabs at $43.55, $32.66, $63.15, $86.01 and $13.07 with their holds and badges ("Cut off", "Waiting for Andy"), three slips to enter, and "Song queue · 6".
  - [ ] Every test that changes state starts from a fresh load.
- **Tests:** the loader's own test against the seed's `expected_at_now` numbers.
- **Notes:** The brief fixes the tabs' names, cards and states; their lines and holds come from the Rail board ([demo seed: Open points](../demo-seed.md#open-points)). The spec's key names win where the seed's differ (see [Open points](#open-points)).

### M6-28 · Prove every tab path and the queue end to end, and time the staff tasks

- **Status:** todo
- **Size:** M
- **Depends on:** M6-01 to M6-27
- **Spec:** [milestones: M6 done when](../milestones.md#m6--bar-pos-tabs-and-bar-mode); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (How we'll know it works); [Testing and operations](../spec/13-testing-operations.md) (Stripe flow tests, Clock tests, End-to-end browser tests)
- **Build:**
  - End-to-end suites on the connected sandbox for each done-when line, each from a fresh seed load.
  - Timed runs in staging, with taps and seconds recorded per task against the targets table: a walk-up beer in cash, opening a tab for a tapped phone, another round, closing a tab with a tip, taking over the terminal, accepting a room order, and voiding a drink rung by mistake.
- **Acceptance:**
  - [ ] In staging, a walk-up beer in cash takes under 8 s, another round under 3 s, and taking over the terminal under 2 s.
  - [ ] Every tab path passes on the connected sandbox: a declined raise, a timeout, a cut-off (alcohol grayed out, alcohol moves onto the tab refused), a walkout charged at 4:30 AM, a reopened tab that shows "Paid $272.19 · no hold" and no "Close to card", and $32.66 split into $16.33 + $16.33 that survives leaving the pay panel.
  - [ ] Moving Jess P.'s tab into Room 9 moves every line as a transfer ("Moved from Jess P.'s bar tab"), releases her hold once the room has a payment method, and refuses alcohol when the room is cut off.
  - [ ] Diego's void of 1 × Large bucket · 10 beers ($70) on Tariq A.'s tab waits for Andy, and Tariq A.'s tab shows "Waiting for Andy" until he decides.
  - [ ] The seed's queue plays out: Luis M. singing, Jess P. next, Ben T.'s phone reading "2 singers before you" and then getting "You're up next" by push and by text, Sofia R. showing "Needs a drink credit", and the TV never showing a phone number.
  - [ ] A songbook CSV loads and is searchable from the queue page.
  - [ ] A gift order to a cut-off tab, or after 4 AM, is refused with the reason.
- **Tests:** the suites above in CI against the sandbox; the timed runs recorded in staging.
- **Notes:** The timed targets are hypotheses; M9's staff trial repeats them in the venue, and a missed target changes the design, not the target.

## Coverage

Every "Ships" item, done-when line, Admin section and must-fix item of M6 in [milestones.md](../milestones.md#m6--bar-pos-tabs-and-bar-mode), and the tickets that build it.

| Milestone item | Tickets |
| --- | --- |
| Ships: The bar POS | M6-01, M6-02, M6-03, M6-04, M6-05 |
| Ships: Bar tabs | M6-06, M6-07, M6-08, M6-09, M6-10, M6-11, M6-12, M6-13, M6-14 |
| Ships: Closing tabs | M6-16, M6-17 |
| Ships: Bar mode | M6-18, M6-19, M6-20, M6-21, M6-22, M6-23, M6-24 |
| Ships: Canvas boards | M6-02, M6-06, M6-09, M6-20, M6-22, M6-25, M6-26 |
| Done when: The timed tasks in Staff screens and the bar POS | M6-03, M6-04, M6-05, M6-28 |
| Done when: Every tab path passes on the connected sandbox | M6-07, M6-08, M6-10, M6-12, M6-14, M6-16, M6-28 |
| Done when: Moving Jess P.'s tab into Room 9 | M6-13, M6-28 |
| Done when: Diego's void of 1 × Large bucket | M6-15, M6-28 |
| Done when: The seed's queue plays out | M6-18, M6-19, M6-20, M6-21, M6-22, M6-28 |
| Done when: A songbook CSV loads | M6-23, M6-28 |
| Done when: A gift order to a cut-off tab | M6-24, M6-28 |
| Admin: Bar POS | M6-01, M6-25 |
| Admin: Bar mode | M6-23, M6-26 |
| Must-fix: GA-M7 (cut-off for a tab) | M6-14, M6-13 |
| Must-fix: GA-M10 (the play log in M6) | M6-19 |
| Must-fix: GA-M11 (bar-mode guardrails) | M6-06, M6-08, M6-11, M6-18, M6-19, M6-21, M6-24 |

## Open points

Spec gaps met while writing these tickets, each built with the cautious default its ticket names:

- **The plan's size.** These tickets add up to about 50 to 76 working days against milestones.md's 3–4 weeks.
- **"Maya · on break"** needs the break punch, which ships with M7's time clock; M6 reads it and tests against a seeded punch (M6-04).
- **Growing the hold:** "near the hold" and the step sizes aren't set (M6-07).
- **The order of a split's shares** isn't set; the held card's share goes last (M6-10).
- **Drink credits:** what counts as one drink, and where a new singer joins the rotation (M6-18).
- **Song tax:** rule 8's list of taxed categories leaves out songs, while GA-M11 says they're taxed (M6-19).
- **Guest gift orders** have no page (M6-24).
- **A whole-tab move** with alcohol onto a cut-off room isn't spelled out (M6-13).
- **The seed's key names** differ from the spec's: `tabs.flagCents` (spec `flagOverCents`), `barMode.songsPerSingerPerRound` (spec `songsPerRound`), and `pay.tipScreen` without `fixedCents` and `smartThresholdCents`. The loader maps them to the spec's names.
- **The seed has no `pos_layouts`** (M6-01) and **no tab at $272.19** (M6-12).
- **`POST /tabs/{t}/hand-over`** belongs with M7's clock-out checklist, so it isn't built here.
- **`pay.roomHold`** (a room's own card hold) is referenced by the move-to-room rules but ships in no milestone; it's off at West 4 (M6-13).
- **Close the night:** M6 builds only its open-bar-tabs part and Charge the remaining tabs; M7 builds the rest (M6-16).
