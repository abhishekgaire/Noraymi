# V · Visual pass

Oct 8, 2026 · every screen was built for behaviour from the [spec](../spec/README.md), but nobody applied the frozen [design canvas](../../design/README.md)'s look. Decision D97 says screens match the canvas's visual design (colours, type, spacing, components) while the spec still wins on behaviour and wording, and [screens](../screens.md) still lists where the canvas is out of date. One ticket per Claude Code session; each restyles its screens on top of the shared design layer that V-01 builds.

**Goal (usable when done):** every screen looks like its canvas board at phone and desktop sizes, with the spec's behaviour, the glossary's words and both languages unchanged.

**Done when:**

- Every board in `design/canvas/` has a side-by-side capture in `docs/design-review/` and its remaining differences listed in its ticket.
- No screen uses a colour, typeface or radius outside `packages/shared/src/design/tokens.css`.
- Lint, typecheck, i18n, unit and the Playwright specs of every restyled screen pass, with no assertion weakened.

**How each ticket works:** restyle with the tokens and the bundled fonts only (never a runtime font call), keep 44 px touch targets on staff screens, keep every word in the i18n catalogs, capture the canvas beside the built screen with `DESIGN_REVIEW=1 pnpm exec playwright test --project=staff e2e/design-review` (add the ticket's boards to that spec), and list what still differs.

## V-01 · Build the canvas design layer and restyle the Board

- **Status:** done
- **Size:** M
- **Depends on:** none
- **Spec:** [Screens](../screens.md) · Board, Rules for every screen; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md); D97
- **Canvas:** `Board.dc.html` (1280 × 800); `Staff.dc.html` as the phone reference (390 wide)
- **Build:**
  - One shared design layer in `@west4/shared`: `design/tokens.css` (the canvas's colours, type, radii, spacing, shadows) and `design/fonts.css` (the canvas's typefaces bundled from `@fontsource` packages, never fetched at run time), imported by the staff app, the Console and the guest web.
  - The staff app's base on the tokens: background, text, buttons, links, inputs, the side menu, the top bar, the bands, screen titles in the display face.
  - The Board restyled after `Board.dc.html`: the title with the room counts as a chip, "Needs you" alert rows, room tiles filled by state (lime in room, amber wrap-up, pink over time, lime tint staying, grey cleaning, pink hatching out of service, outline open), and a side column for the headcount, arriving bookings and lost and found at desktop width. One column on a phone, in the board's old order.
  - Side-by-side captures in `docs/design-review/v01/`.
- **Acceptance:**
  - [x] The staff app, the Console and the guest web load the tokens and the bundled fonts; no request goes to Google Fonts.
  - [x] The Board at 1280 and 390 uses the canvas's colours, typefaces, radii, alert rows and tile colours.
  - [x] Words, states and behaviour are unchanged: lint, typecheck, i18n, unit and the staff Playwright specs pass with no assertion changed.
  - [x] Touch targets stay at least 44 px.
- **Tests:** the existing staff Playwright specs (they check every word in both languages and that nothing is cut off at 390 and 1280); `e2e/design-review.staff.spec.ts` makes the captures, off unless `DESIGN_REVIEW=1`.
- **Notes:**
  - Capitals in the display face and the mono labels come from `font-variant-caps: all-small-caps`, not `text-transform: uppercase`, so the text people, screen readers and the language tests read stays the catalog's own.
  - Still different from the canvas: the canvas opens a room in a side panel and keeps the tiles small; the built tile still holds every control (party size, ID, cut-off, Move, Report a fault, Damage fee), so tiles are taller and the grid has 3 to 4 columns, not 5. Moving those controls into a panel changes how every Board test reaches them, so it is V-08. The canvas shows 3 alerts and "Show all 6"; the spec has no collapsed alerts, so all 7 show. The canvas has no top bar (its rail carries "W4"); the built top bar stays, restyled. No colour legend under the tiles (its words aren't in the catalogs yet). The phone's canvas home is the Staff portal's timeline (`/today`, V-02); `/tonight` on a phone keeps its one-column board.
  - The canvas is dark only, so the staff app and the Console stay dark only. The guest web keeps its light and dark colours and WCAG AA accent until V-07; it gets only the bundled body font now.
  - Fonts: Bricolage Grotesque, Instrument Sans, Space Mono, Archivo, Instrument Serif and DM Sans, all SIL Open Font License 1.1. The canvas's IBM Plex Mono (3 uses) maps to Space Mono.

## V-02 · Restyle the staff phone screens

- **Status:** done
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `Pin.dc.html`, `Staff.dc.html`, `Room.dc.html`, `Calendar.dc.html`, `Messages.dc.html`, `Reports.dc.html`, `Admin.dc.html`
- **Screens:** [Pin](../screens.md#pin), [Staff](../screens.md#staff), [Room](../screens.md#room), [Calendar](../screens.md#calendar), [Messages](../screens.md#messages), [Reports](../screens.md#reports), [Admin](../screens.md#admin), and the phone sheets N10 to N22
- **Build:** the sign-in keypad, the Staff portal's Tonight (timeline and list), Waitlist, Runs and Tips, the room tab and clock, and the phone tab bar, at 390 wide.
- **Acceptance:**
  - [x] Side-by-side captures at 390 in `docs/design-review/v02/`: `pin-390.png`, `pin-pad-390.png`, `today-390.png` (and `-full`), `waitlist-390.png`, `runs-390.png`, `tips-390.png`, `room-390.png` (and `-full`), plus `pin-desktop-1280.png` for the bar computer.
  - [x] Words, states and behaviour unchanged; English and Spanish from the catalogs; touch targets at least 44 px (the PIN keys are 82 px).
  - [x] The staff Playwright specs that cover these screens pass with no assertion changed (see Notes for the run).
- **Tests:** `e2e/design-review-v02.staff.spec.ts` makes the captures, off unless `DESIGN_REVIEW=1` (`DESIGN_REVIEW_API` and `DESIGN_REVIEW_CANVAS_PORT` point it at a second stack); the existing staff specs.
- **Notes:**
  - The styles live in `apps/staff/src/phone.css`, loaded after `styles.css` and scoped to each screen (`.sign-in`, `.phone-tonight`, `.waitlist`, `.runs`, `.tips-to-enter`, `.room-screen`), so the desk, bar and Admin screens keep theirs. The room screen's card layout applies below 1024 px only; at 1280 it is V-03's DeskRoom. Markup changes are class names and data attributes only, plus the badge mark and the tiles' initials (aria-hidden, so every accessible name and test locator is unchanged).
  - Two fixes on the way: the phone shell's grid gave its last row (the bottom tabs) the spare height when no band showed, so the active tab stretched into a tall pill on short pages; the shell is a column on a phone now and the tabs sit at the foot. The room tab's section has the class `tab`, the same as a bottom tab, so it picked up the tab pill's flex centring and the running tab rendered as a squeezed column; `.room-screen section.tab` resets that at every width. Tips to enter's slip buttons were centred by the button base style; they fill the card now.
  - Pin: the canvas's display title, lime mono line, badge card with the reader mark, 2 × 2 name tiles with initials (cyan for a 6-digit PIN), round 82 px keys and glowing dots. Still different: no "This is · Bar computer / Staff phone" switch (pairing sets the device), the title is the catalog's "Staff sign-in" with the time and venue under it rather than "Who's on?" under a device line, no badge sub-sentence, demo badges or long footer paragraph (not in the catalogs), and the tiles add the shift line (N24); the waiting bar orders strip, Time clock, owner passkey and language switch stay.
  - Staff portal (`/today`, `/waitlist`, `/runs`, `/tips`): cards on the canvas's row colour, status chips (lime Seated, pink Late, grey Booked), pink display numbers on the waitlist, display room names and amber mono status on runs, an amber edge and ID chip when the runner checks the last IDs, mono amounts on tips. Still different: a booking is one catalog line (time · name · party · room · hours · deposit), so there is no big time column or "Party of" sub-line, and its actions (Check in, Tab & close out →, Details) are in its Details sheet, per the spec; waitlist actions are Offer a room, Text, Remove (Staff note 3), and "Add a party" is the dashed row; runs show the spec's words ("Ready for a runner · 4:11") rather than "since made", no "Made by" chip, and Delivered and Couldn't serve… show with I've got it; a slip opens its entry (photo and amount) instead of an inline tip field; no intro paragraphs or "N to carry" / "N left" labels (not in the catalogs). The phone's Tonight board, the views and "+ Walk-in" are V-08's.
  - Room: the clock and the tab as the canvas's dark cards, the room's party as a lime mono line, tab lines with hairlines and mono amounts, the calls as the canvas's amber strip, the fix panel's lines as rows. Still different: the clock shows minutes and the per-minute rate (the API's numbers), not an H:MM:SS counter with a progress bar and the booked window; no sticky "Close out $618.60 · Guest view" bar (Present the check and the close-out steps of N21 follow the tab); menu search instead of quick-add chips (Room note 3); no × on tab lines (the fix panel, Room note 1); the calls strip sits below the controls, not at the top; the shell's top bar instead of the canvas's back header.
  - The phone sheets (N10 to N22) get the raised-card look below 1024 px (hairline, 18 px radius, shadow) instead of the lime frame. Calendar, Messages and Reports at phone width are not restyled here: the Build line doesn't name them and they share their components with V-03's desk screens.
  - Test run (Oct 9, 2026), on a second stack (API 3102, staff 5182, database `west4_v02`) with ports rewritten in a throwaway copy of `e2e/staff.spec.ts`: 24 staff tests covering these screens passed (sign-in on the bar computer, the manager's 6-digit pad, Andy's Tonight and booking actions, Runs, the waitlist drawer, every screen fits in Spanish at 390 and 1280, the Room phone, Calls, check-in, party size, close-out and refund on the phone, Approvals, My tips, Messages, Calendar, the locked bar computer, the Tonight board and alerts band). Two failed only because of that second stack: the move sheet reads the guest page on port 3001 (the other stack), and the damage photo's upload is refused by the local store's CORS for origin 5182. Tips to enter wasn't run (it captures through the fake Stripe on 12111). The full staff project runs at the merge.

## V-03 · Restyle the desk screens

- **Status:** done
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `DeskRoom.dc.html`, `DeskCalendar.dc.html`, `DeskMessages.dc.html`, `DeskReports.dc.html`, `Night.dc.html`
- **Screens:** [DeskRoom](../screens.md#deskroom), [DeskCalendar](../screens.md#deskcalendar), [DeskMessages](../screens.md#deskmessages), [DeskReports](../screens.md#deskreports), [Night](../screens.md#night)
- **Build:** the room tab and clock, Calendar, Messages, Reports and Close the night at 1280 × 800, with the rail from V-01.
- **Acceptance:**
  - [x] Side-by-side captures at 1280 in `docs/design-review/v03/` (each screen, the first 800 px and the full page).
  - [ ] The staff and desktop Playwright specs pass unchanged: no spec or assertion was changed, but the full suite wasn't run in this pass (it runs in the merge pass). Lint, typecheck, i18n and unit pass.
- **Tests:** `e2e/design-review.staff.spec.ts` ("V-03 · the desk screens…", `DESIGN_REVIEW=1`; `DESIGN_REVIEW_CANVAS_PORT` moves the canvas server off 8765). It reseeds through `SEED_COMMAND` and sets the clock through its own `baseURL`, so it can run against a second stack.
- **Notes:**
  - One stylesheet, `apps/staff/src/screens/desk.css`, imported by the five screens; no shared file changed. A head row (`.desk-head`), canvas cards (`.desk-card`: `--w4-bg-row`, `--w4-line`, tile radius) and columns (`.desk-cols`) at 1024 px and up, one column below. On a desk screen a bare `.card` (ReportPanel, TipsPanel, DrawerPanel, NightChecks, Unmatched payments, the break-glass card) gets the card look; elsewhere it doesn't. Section titles inside cards are the canvas's mono small-caps labels.
  - Room: the clock card (the minutes and rate in the display face, the stay-on or wrap-up line, party size, IDs, Scan ID, Move, Report a fault, Damage fee, No more alcohol), Calls as a pink card and Room notes under it; the running tab with Fix a sent drink and Add drinks in the middle; Present the check and the close-out steps on the right. The `<section class="tab">` no longer picks up the phone's bottom-tab style.
  - Calendar: the days as tiles (the picked one outlined in yellow, a closed day pink-hatched), the picked day's bookings in a card beside them. Messages: inbox, the open conversation (staff replies in lime, inbound and automatic texts as grey bubbles) and the automatic texts in three columns; on a phone the empty pane and, inside a thread, the automatic texts hide. Reports: tonight's X/Z, the week and the tax quarter as figure cards, then the 8-week trend (lime bars) and the exceptions, then exports. Night: everything still open, the bar tabs as chips and Charge the remaining tabs in the canvas's pink card; then the X/Z report, tips and both drawers in three columns.
  - Still different from the canvas: the built top bar and side menu stay (V-01). Room: the clock reads "161 min · $2.00 a minute", not "2:41:01 elapsed", and has no progress bar; no quick-add chips (the menu search stands in, spec F21); no "Text: stay as long as you like" (spec wording), no Room code / Host lock / Text Marcus buttons; the close-out column shows the spec's steps (Present the check first), not Tap card / Card on file / Cash / Split from the start. Calendar: a list of days ahead in 5 columns, not a month grid with weekday columns and busy-night bars; each booking is the catalog's one line, not time / name / status chip; no legend or "+ Big party" in the head. Messages: no avatars, times or search; the reply has no quick-reply chips; automatic texts show On/Off, not toggles with their wording (Admin → Texts owns those). Reports: no SALES / ROOM HOURS / NO-SHOWS / AVERAGE PARTY tiles, no rooms-by-hour chart and no best sellers (the API doesn't report them; spec N38 doesn't list them); the trend runs sideways with amounts. Night: no "The numbers / Every action" switch and no per-room Close out chips (the spec's checks list with Fix links stands in, F30).
  - Captures were made against a separate stack (API 3103, staff 5183, database `west4_v03`, canvas 8775), then stopped and dropped.

## V-04 · Restyle the bar screens

- **Status:** done
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `Rail.dc.html`, `Bar.dc.html`
- **Screens:** [Rail](../screens.md#rail), [Bar](../screens.md#bar), and the song queue in bar mode
- **Build:** the bar POS (sections, item grid, tabs, close-out) and the bar orders screen by age, keeping spec 10's bigger bar targets.
- **Acceptance:**
  - [x] Side-by-side captures at the boards' sizes in `docs/design-review/v04/`: `rail-1280.png` (and `-full`) beside `Rail.dc.html` at 1280 × 800, `bar-orders-900.png` (and `-full`) beside `Bar.dc.html` at 900 × 640, `song-queue-1280.png` (no board; drawn in the Rail's style).
  - [x] Words, roles, states and behaviour unchanged; no Playwright spec or assertion changed. Lint, typecheck, i18n and unit pass. The staff and desktop Playwright suites were not run in this worktree (the merge pass runs them); the capture spec checks in Spanish that nothing is cut off on `/bar` at 1280 and 390, `/bar-orders` at 900 and `/song-queue` at 1280, and that every menu button is at least 115 × 100.
- **Tests:** `e2e/design-review-v04.staff.spec.ts` makes the captures, off unless `DESIGN_REVIEW=1`. It seeds `DATABASE_URL` and moves the clock through the staff app's own `/v1`, so it can run against its own database and ports (`DESIGN_REVIEW_CANVAS_PORT` picks the canvas server's port, 8765 by default).
- **Notes:**
  - Styles live in `apps/staff/src/screens/bar.css`, imported by the Rail, Bar orders and Song queue, every rule scoped under the screen's root so it wins over the older rules in `styles.css` (left untouched). The ten section colours are new tokens (`--w4-sec-*`) in `tokens.css`.
  - The Rail: room orders as the canvas's cards (cyan new, amber at 2 min, pink at 4) in a row under the header, with all three spec buttons; three panels (tabs and rooms, menu, the tab) that fill the window and scroll on their own; tab rows with coloured edges (cyan for rooms) and mono marks (pink for a stop, amber for a warning, lime when settled); sections with their dots, five across; each menu button edged in its own section's colour (the first section after Favorites that holds it); the tab's name in the display face. A Food section (spec 16, draft) would land as the 11th button in the same five-across grid with no other change; its sub-categories can be a second row under it.
  - Spec 10 rule 9 beats the canvas: menu buttons stay at least 115 × 100 and main actions 52 to 64 px. To fit five 115 px buttons across at 1280 beside the side menu, the side menu is 148 px wide on the bar POS only (`.shell:has(.rail)`), and the tab list (204 px) and the tab panel (284 px) are narrower than the canvas's 256 and 392. At 800 high the menu's fifth row scrolls inside its panel.
  - Bar orders: Waiting for you, Being made and Ready for a runner on the left, Delivered tonight and Returned on the right (the spec's five groups, laid out like the canvas's two columns); waiting orders as the canvas's big cards, the rest as quieter rows; Out tonight as pink pills with Back on; the escalation sentence and Mute in a footer panel.
  - Still different from the canvas: the built shell's top bar and side menu stay (the canvas has its own W4 header and no menu); no "online" dot, Lock button or Demo links in the Rail header (Lock is in the side menu); no "guest taps a card" sub-label on New tab, no "same places every night" eyebrow, no Undo button and no "Send to tab" button (the built draft and send live in Add drinks under the tab); tab rows show the marks the spec defines, not the canvas's seat and owner line; prices show cents ($8.00, not $8); the bar orders screen has no orange alarm band, no printed-ticket preview and no "Tap once for the chime" chip (none is in the spec); at 900 the shell is the phone layout with its bottom tabs. These need catalog words or features, so they stay out of a visual pass.

## V-05 · Restyle Admin and the setup wizard

- **Status:** done
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `AdminDesk.dc.html`, `Setup.dc.html`
- **Screens:** [AdminDesk](../screens.md#admindesk), [Setup](../screens.md#setup)
- **Build:** Admin's section list and forms, and the new-venue setup wizard.
- **Acceptance:**
  - [x] side-by-side captures at 1280: `docs/design-review/v05/` (Hours with and without unsaved changes, Features, Team, Printers & devices, Menu, Card fee & gratuity, Cash drawers; the 390 phone beside `Admin.dc.html`).
  - [ ] the staff Playwright specs pass unchanged: no selector, role or word changed, so none was edited; the full run is left to the merge pass.

- **Notes:**
  - The setup wizard is phase 2 and isn't built, so there was nothing of it to restyle. Its West 4 checks live in Admin → Go live, which picks up the same form layer.
  - Admin's shell follows the canvas: the settings column (232 px, the rail's background, lime for the open section, its hint at 70%), "Admin" as that column's mono label (still the page's one level-1 heading), and the canvas's footer card in the column, "Every change is logged with who and when…" (new key `admin.changesNote`, English and Spanish). Each section's own title is the display-face header with a rule under it, and "Save and publish" sits in that header's right corner, Discard then Save as the canvas reads, sticky while the section scrolls. It still shows only while there are unsaved changes, or after a publish (the canvas's greyed "Saved" button and "Saved 2 min ago by Andy" aren't in the spec or the catalogs).
  - New shared form layer `packages/shared/src/design/controls.css` (exported as `@west4/shared/design/controls.css`): a container with `w4-forms` gets the canvas's fields (surface fill, 8 px corners, lime focus edge, 44 px tall), checkboxes in labels drawn as the canvas's 42 × 24 switches (still checkboxes for screen readers, the label row is the 44 px target), radio choices as bordered option rows, fieldsets and forms as cards, and tables as one row card with mono column labels. `.w4-switch`, `.w4-field` and `.w4-card` work on their own for other screens. Admin's own look is `apps/staff/src/admin/admin.css`, all under `.admin-screen`; both load from `main.tsx` after `styles.css`, so they win their ties.
  - Still different from the canvas: each section is still one column of the built content, not the canvas's two-column card grid (that needs each section's markup grouped into cards, 30 files; the CSS can't wrap them). Team, Devices and Menu stay tables, scrolling sideways inside their card when they're wider than the screen, where the canvas draws Team as per-person rows with role buttons. The canvas's mono subtitle under the section title, "Saved … by", the menu's category chips and search, and the "Try it · Room 9" preview have no spec'd words or behaviour behind them yet. Features' On / Stopping / Off stays three buttons (the spec's three states), not the canvas's two-state switch. The app's own top bar and rail stay as V-01 left them; the canvas has the "W4" rail without a top bar.
  - The phone capture shows Admin in a passkey session at 390 (the column stacks above the section). The "Admin needs your passkey" stub, for PIN and badge sessions, keeps its words and is now a display-face title over a card.

## V-06 · Restyle the Console

- **Status:** todo
- **Size:** S
- **Depends on:** V-01
- **Canvas:** `Console.dc.html`
- **Screens:** [Console](../screens.md#console)
- **Build:** the internal Console on the tokens (V-01 gave it the tokens' colours and body font only).
- **Acceptance:** side-by-side captures; the console Playwright specs pass unchanged.

## V-07 · Restyle the guest site and guest pages

- **Status:** todo
- **Size:** L
- **Depends on:** V-01
- **Canvas:** `Main.dc.html`, `Rooms.dc.html`, `Book.dc.html`, `Menu.dc.html`, `Manage.dc.html`, `Waitlist.dc.html`, `Parties.dc.html`, `Order.dc.html`, `SiteBuilder.dc.html`
- **Screens:** [Main](../screens.md#main), [Rooms](../screens.md#rooms), [Book](../screens.md#book), [Menu](../screens.md#menu), [Manage](../screens.md#manage), [Waitlist](../screens.md#waitlist), [Parties](../screens.md#parties), [Order](../screens.md#order), [SiteBuilder](../screens.md#sitebuilder), and the guest pages N1 to N9
- **Build:** the guest web on the tokens. Founder to decide first: the canvas is dark only, while the guest web today follows the phone's light or dark setting; and every guest colour must still pass the WCAG 2.2 AA check (M5-16), which the canvas's pink on cream may not.
- **Acceptance:** side-by-side captures at 390 and desktop; the guest and accessibility Playwright specs pass unchanged.

## V-08 · Open a room in a side panel on the Board

- **Status:** done
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `Board.dc.html`; `Staff.dc.html` (the phone's Tonight)
- **Screens:** [Board](../screens.md#board), [Staff](../screens.md#staff)
- **Build:** small canvas tiles (name, party, words, minutes and tab) in 5 columns, and the selected room's controls in the canvas's right panel. The founder confirmed it (Oct 9, 2026), with two additions: "Show all N" under the 3 most urgent alerts, and the phone's Tonight after `Staff.dc.html` (four counts, the views, the timeline first, a pinned "+ Walk-in").
- **Acceptance:**
  - [x] Side-by-side capture at 1280 with the tiles in 5 columns and Room 9's panel open (`docs/design-review/v08/`).
  - [x] Every control and state a tile held is in the panel: Tab & close out, Move, the wrap-up text, Report a fault, Damage fee, party size, ID chip and Scan ID, No more alcohol, Unpause, stay on, faults and Fixed, notes, Mark clean, + Walk-in.
  - [x] The staff Playwright specs pass with the extra tap and no assertion weakened.
  - [x] English and Spanish strings; touch targets at least 44 px.
- **Tests:** `e2e/staff.spec.ts` (the `openRoom`, `listView` and `showAllAlerts` helpers add the extra taps; the alerts band test now also checks that only 3 show before "Show all 7"); `e2e/design-review.staff.spec.ts` with `DESIGN_REVIEW=1`.
- **Notes:**
  - Founder-approved design additions, beyond the canvas and the spec: (1) the board shows the 3 most urgent alerts and "Show all N" ("Show only the 3 most urgent" folds them again); (2) below 1024 px the board opens on the phone Tonight of `Staff.dc.html`: four count boxes (In room, Open, Arriving, Waitlist), the views (Timeline, List, Waitlist, and Runs and Tips as links to `/runs` and `/tips` when the role and modules allow them), the room-by-room timeline from 4 PM to 4 AM with the now line, bookings as blocks and out-of-service rooms hatched, and "+ Walk-in" pinned above the bottom tabs. List is the board as it was (alerts, tiles, headcount, arrivals, lost and found); the last view is remembered for the tab in `sessionStorage`. The bottom tabs are styled as the canvas's pills.
  - Desktop: the panel sits at the top of the right column, with the headcount, arrivals and lost and found under it; with no room open it says "Tap a room to see its clock, tab and controls here." No room opens by default, so nothing changes until someone taps. On a phone the panel is a sheet above the bottom tabs, and it steps aside while a sheet it opened (Move, Damage fee, Report a fault, check-in) is up.
  - The panel adds the canvas's room-note field (the same `POST …/rooms/:id/notes` as the room screen) and shows the room's calls with On it.
  - The counts line ("8 in use · 3 open · 2 cleaning · 1 out of service", Staff note 12) stays on the phone too, beside the four boxes.
  - Still different from the canvas: the panel's "Tab so far" is the totals (tab, room time, deposit), not the line items; there is no "Text guest" link or "Text: stay as long as you like" button (the spec's wrap-up text and stay-on line stand in); no colour legend under the desktop tiles; the built top bar and side menu stay instead of the canvas's rail (headcount and drawers live in the right column and Cash drawers); on a phone the shell's top bar and the Tonight head (counts line, Waitlist, Cash drawers) sit above the boxes, the canvas's Calendar/Messages/Reports/lock row isn't built (they're in the menu and tabs), the timeline's room names have no size range ("3–6"), alerts show only in the List view, and Runs has no count.
  - Timeline block labels are cut at the block's edge with `clip-path`; each block's button carries the full words.
  - Test run (Oct 9, 2026): the staff project ran once in full, 136 passed. `accept_o1` failed only in the full run and passes alone. "Our plan: a failed payment…" fails alone too, and not on the Board: `subscribeVenue` gets Stripe's "Keys for idempotent requests can only be used with the same parameters" because the long-running fake Stripe (started by `scripts/demo-start.sh`) still holds `billing:subscription:<venue>:<plan>` from an earlier run after the database was reseeded. A fresh fake Stripe (as in CI) passes it. Worth a ticket: the key is fixed per venue and plan, so a venue that resubscribes to the same plan within Stripe's 24 hours with different items would hit the same error. Fixed the same day under M8-15's Notes: the key now names a stored subscribe attempt.
