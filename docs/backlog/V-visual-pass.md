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

- **Status:** todo
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `Pin.dc.html`, `Staff.dc.html`, `Room.dc.html`, `Calendar.dc.html`, `Messages.dc.html`, `Reports.dc.html`, `Admin.dc.html`
- **Screens:** [Pin](../screens.md#pin), [Staff](../screens.md#staff), [Room](../screens.md#room), [Calendar](../screens.md#calendar), [Messages](../screens.md#messages), [Reports](../screens.md#reports), [Admin](../screens.md#admin), and the phone sheets N10 to N22
- **Build:** the sign-in keypad, the Staff portal's Tonight (timeline and list), Waitlist, Runs and Tips, the room tab and clock, and the phone tab bar, at 390 wide.
- **Acceptance:** side-by-side captures at 390; the staff Playwright specs pass unchanged.

## V-03 · Restyle the desk screens

- **Status:** todo
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `DeskRoom.dc.html`, `DeskCalendar.dc.html`, `DeskMessages.dc.html`, `DeskReports.dc.html`, `Night.dc.html`
- **Screens:** [DeskRoom](../screens.md#deskroom), [DeskCalendar](../screens.md#deskcalendar), [DeskMessages](../screens.md#deskmessages), [DeskReports](../screens.md#deskreports), [Night](../screens.md#night)
- **Build:** the room tab and clock, Calendar, Messages, Reports and Close the night at 1280 × 800, with the rail from V-01.
- **Acceptance:** side-by-side captures at 1280; the staff and desktop Playwright specs pass unchanged.

## V-04 · Restyle the bar screens

- **Status:** todo
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `Rail.dc.html`, `Bar.dc.html`
- **Screens:** [Rail](../screens.md#rail), [Bar](../screens.md#bar), and the song queue in bar mode
- **Build:** the bar POS (sections, item grid, tabs, close-out) and the bar orders screen by age, keeping spec 10's bigger bar targets.
- **Acceptance:** side-by-side captures at the boards' sizes; the staff and desktop Playwright specs pass unchanged.

## V-05 · Restyle Admin and the setup wizard

- **Status:** todo
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `AdminDesk.dc.html`, `Setup.dc.html`
- **Screens:** [AdminDesk](../screens.md#admindesk), [Setup](../screens.md#setup)
- **Build:** Admin's section list and forms, and the new-venue setup wizard.
- **Acceptance:** side-by-side captures at 1280; the staff Playwright specs pass unchanged.

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

- **Status:** todo
- **Size:** M
- **Depends on:** V-01
- **Canvas:** `Board.dc.html`
- **Screens:** [Board](../screens.md#board)
- **Build:** small canvas tiles (name, party, words, minutes and tab) in 5 columns, and the selected room's controls in the canvas's right panel, on desktop only. Founder to confirm first: it changes how staff reach a room's controls (one tap on the tile first), and every Board Playwright test then opens the room before using its controls.
- **Acceptance:** side-by-side capture at 1280 with the tiles in 5 columns; the staff Playwright specs pass with the extra tap and no assertion weakened.
