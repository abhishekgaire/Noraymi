# Backlog

234 tickets for phase 1, one file per [milestone](../milestones.md). Each ticket names the spec it builds, what to build, how to accept it and which tests to write. The [definition of done](../../CLAUDE.md#definition-of-done) applies to every ticket.

## How to use it

- **Order.** Work the milestones in order, M1 first (M5 and M6 can swap). Inside a milestone, follow its suggested order and take the first `todo` ticket whose dependencies are all `done`.
- **Status.** Each ticket has a Status line: `todo`, `doing` or `done`. Set `doing` when you start, and `done` only when every Acceptance line passes. Record any change of scope in the ticket's Notes.
- **Sizes.** S is up to a day, M is 2 to 3 days and L is 4 to 5 days. Split anything bigger before it starts, and keep the IDs sequential by adding letters (M2-07a).
- **Open questions.** A ticket that touches one builds the cautious default as a setting, as its Notes say, and links the question in [open technical questions](../spec/14-open-questions.md).
- **The canvas.** UI tickets link [screens](../screens.md). The canvas is frozen, so wherever it and the spec differ, build what the spec says.

## Milestones

| Milestone | Tickets | S / M / L | Days at the sized effort |
| --- | --- | --- | --- |
| [M1 · Foundations](M1-foundations.md) | 37 | 18 / 19 / 0 | 47–75 |
| [M2 · Rooms and the board](M2-rooms-and-board.md) | 35 | 16 / 19 / 0 | 46–73 |
| [M3 · Room orders and the bar screen](M3-room-orders-and-bar-screen.md) | 25 | 9 / 16 / 0 | 36.5–57 |
| [M4 · Payments and receipts](M4-payments-and-receipts.md) | 30 | 7 / 22 / 1 | 51.5–78 |
| [M5 · Guest site and online booking](M5-guest-site-and-booking.md) | 17 | 3 / 14 / 0 | 29.5–45 |
| [M6 · Bar POS, tabs and bar mode](M6-bar-pos-tabs-and-bar-mode.md) | 29 | 5 / 24 / 0 | 50.5–77 |
| [M7 · Close the night and the books](M7-close-the-night-and-books.md) | 20 | 5 / 10 / 5 | 42.5–60 |
| [M8 · Offline, safety and operations](M8-offline-safety-and-operations.md) | 24 | 5 / 14 / 5 | 50.5–72 |
| [M9 · Cutover and going live](M9-cutover-and-going-live.md) | 17 | 8 / 9 / 0 | 22–35 |
| **Total** | **234** | **76 / 147 / 11** | **376–572** |

**Visual pass.** [V · Visual pass](V-visual-pass.md) applies the frozen canvas's look to the built screens (decision D97): V-01 built the shared design layer and restyled the Board; V-02 to V-08 restyle the rest, one group of boards each. It runs beside the milestones and doesn't change their order.

**Sing Sing first (proposed, awaiting approval).** West 4 asked that the system go live first at Sing Sing Karaoke, Astoria, then West 4 (decision D98). [K · Kitchen](K-kitchen.md) proposes 11 tickets (5 S, 6 M) for the draft [Kitchen and food](../spec/16-kitchen.md) spec, and [S · Sing Sing go-live](S-sing-sing-go-live.md) lists the go-live work done again for Sing Sing (S-01 to S-12). None of them starts until the founder approves the draft; they aren't counted in the table above.

## Every ticket

### [M1 · Foundations](M1-foundations.md)

| Ticket | Size | Depends on |
| --- | --- | --- |
| [M1-01 · Scaffold the monorepo with lint, typecheck, tests, CI and the migration runner](M1-foundations.md#m1-01--scaffold-the-monorepo-with-lint-typecheck-tests-ci-and-the-migration-runner) | M | none |
| [M1-02 · Stand up staging and deploy to it from CI](M1-foundations.md#m1-02--stand-up-staging-and-deploy-to-it-from-ci) | S | M1-01 |
| [M1-03 · Add the migration linter](M1-foundations.md#m1-03--add-the-migration-linter) | S | M1-01 |
| [M1-04 · Write the business-date and money helpers test-first](M1-foundations.md#m1-04--write-the-business-date-and-money-helpers-test-first) | S | M1-01 |
| [M1-05 · Build the tenancy tables and row-level security](M1-foundations.md#m1-05--build-the-tenancy-tables-and-row-level-security) | M | M1-03 |
| [M1-06 · Build the jobs table, the workers, the scheduler and the simulated clock](M1-foundations.md#m1-06--build-the-jobs-table-the-workers-the-scheduler-and-the-simulated-clock) | M | M1-04, M1-05 |
| [M1-07 · Build the audit triggers, the per-venue hash chain and the daily write-once export](M1-foundations.md#m1-07--build-the-audit-triggers-the-per-venue-hash-chain-and-the-daily-write-once-export) | M | M1-05, M1-06 |
| [M1-08 · Build the API conventions: the route registry, errors, idempotency and paging](M1-foundations.md#m1-08--build-the-api-conventions-the-route-registry-errors-idempotency-and-paging) | M | M1-05 |
| [M1-09 · Build the event relay and the live WebSockets](M1-foundations.md#m1-09--build-the-event-relay-and-the-live-websockets) | M | M1-06, M1-08 |
| [M1-10 · Load the New York County rule pack and resolve its versions](M1-foundations.md#m1-10--load-the-new-york-county-rule-pack-and-resolve-its-versions) | S | M1-04, M1-05 |
| [M1-11 · Build versioned venue settings with the rule-pack checks on every save](M1-foundations.md#m1-11--build-versioned-venue-settings-with-the-rule-pack-checks-on-every-save) | M | M1-08, M1-09, M1-10 |
| [M1-12 · Build closures and each business date's opening hours](M1-foundations.md#m1-12--build-closures-and-each-business-dates-opening-hours) | S | M1-11 |
| [M1-13 · Build modules, their dependencies, `404 module_off` and venue flags](M1-foundations.md#m1-13--build-modules-their-dependencies-404-module_off-and-venue-flags) | M | M1-08, M1-09 |
| [M1-14 · Load the five default roles into `role_permissions` and check them before every write](M1-foundations.md#m1-14--load-the-five-default-roles-into-role_permissions-and-check-them-before-every-write) | S | M1-08 |
| [M1-15 · Pair devices with one-time codes and signed device keys, and revoke them](M1-foundations.md#m1-15--pair-devices-with-one-time-codes-and-signed-device-keys-and-revoke-them) | M | M1-08, M1-09 |
| [M1-16 · Record heartbeats and clock offsets, and alert when a device goes quiet](M1-foundations.md#m1-16--record-heartbeats-and-clock-offsets-and-alert-when-a-device-goes-quiet) | S | M1-06, M1-12, M1-15 |
| [M1-17 · Load the M1 part of the demo seed into staging and local dev](M1-foundations.md#m1-17--load-the-m1-part-of-the-demo-seed-into-staging-and-local-dev) | S | M1-02, M1-11, M1-13, M1-14, M1-15 |
| [M1-18 · Send email through a transactional provider](M1-foundations.md#m1-18--send-email-through-a-transactional-provider) | S | M1-06 |
| [M1-19 · Sign in owners and managers with a passkey or an authenticator app](M1-foundations.md#m1-19--sign-in-owners-and-managers-with-a-passkey-or-an-authenticator-app) | M | M1-08, M1-14, M1-18 |
| [M1-20 · Add recovery codes and owner recovery](M1-foundations.md#m1-20--add-recovery-codes-and-owner-recovery) | S | M1-18, M1-19 |
| [M1-21 · Build the staff app shell with every string in English and Spanish](M1-foundations.md#m1-21--build-the-staff-app-shell-with-every-string-in-english-and-spanish) | M | M1-01, M1-09, M1-13, M1-14 |
| [M1-22 · Install the staff app to the home screen and send push](M1-foundations.md#m1-22--install-the-staff-app-to-the-home-screen-and-send-push) | S | M1-15, M1-21 |
| [M1-23 · Invite staff, confirm their phone with a code, and let them set their own PIN](M1-foundations.md#m1-23--invite-staff-confirm-their-phone-with-a-code-and-let-them-set-their-own-pin) | M | M1-15, M1-18, M1-19, M1-21, M1-22 |
| [M1-24 · Sign in on shared screens and phones with name and PIN, with lockouts](M1-foundations.md#m1-24--sign-in-on-shared-screens-and-phones-with-name-and-pin-with-lockouts) | M | M1-16, M1-22, M1-23 |
| [M1-25 · Check NTAG 424 DNA badges by their SUN message](M1-foundations.md#m1-25--check-ntag-424-dna-badges-by-their-sun-message) | M | M1-15, M1-24 |
| [M1-26 · Build the sign-in screen and each role's home](M1-foundations.md#m1-26--build-the-sign-in-screen-and-each-roles-home) | S | M1-21, M1-24, M1-25 |
| [M1-27 · Offboard a person in one step](M1-foundations.md#m1-27--offboard-a-person-in-one-step) | S | M1-22, M1-24, M1-25 |
| [M1-28 · Build the Electron desktop shell with its security checklist](M1-foundations.md#m1-28--build-the-electron-desktop-shell-with-its-security-checklist) | M | M1-15, M1-21 |
| [M1-29 · Add the watchdog, start at login, keep awake and updates at the cutover](M1-foundations.md#m1-29--add-the-watchdog-start-at-login-keep-awake-and-updates-at-the-cutover) | S | M1-12, M1-28 |
| [M1-30 · Read badges from the USB NFC reader in the desktop app, and pair them](M1-foundations.md#m1-30--read-badges-from-the-usb-nfc-reader-in-the-desktop-app-and-pair-them) | M | M1-25, M1-28 |
| [M1-31 · Build the Admin shell and Admin → Team](M1-foundations.md#m1-31--build-the-admin-shell-and-admin--team) | M | M1-19, M1-21, M1-23, M1-27, M1-30 |
| [M1-32 · Build Admin → Features](M1-foundations.md#m1-32--build-admin--features) | S | M1-13, M1-31 |
| [M1-33 · Build Admin → Hours & prices: weekly hours, the house last call and special dates](M1-foundations.md#m1-33--build-admin--hours--prices-weekly-hours-the-house-last-call-and-special-dates) | S | M1-11, M1-12, M1-31 |
| [M1-34 · Build Admin → Printers & devices: pairing and revoking](M1-foundations.md#m1-34--build-admin--printers--devices-pairing-and-revoking) | S | M1-15, M1-16, M1-31 |
| [M1-35 · Build the Console: sign-in with FIDO2 keys, the venue list, the module allow-list and venue flags](M1-foundations.md#m1-35--build-the-console-sign-in-with-fido2-keys-the-venue-list-the-module-allow-list-and-venue-flags) | M | M1-08, M1-13, M1-16 |
| [M1-36 · Publish rule-pack versions in the Console with two approvers and a signature](M1-foundations.md#m1-36--publish-rule-pack-versions-in-the-console-with-two-approvers-and-a-signature) | S | M1-10, M1-31, M1-35 |
| [M1-37 · Run the principal and venue-wall suites in CI and block merges](M1-foundations.md#m1-37--run-the-principal-and-venue-wall-suites-in-ci-and-block-merges) | M | M1-06, M1-08, M1-15, M1-19, M1-24, M1-25 |

### [M2 · Rooms and the board](M2-rooms-and-board.md)

| Ticket | Size | Depends on |
| --- | --- | --- |
| [M2-01 · Write the room-time rules test-first](M2-rooms-and-board.md#m2-01--write-the-room-time-rules-test-first) | S | M1-04 |
| [M2-02 · Write the rate, tab-so-far and deposit rules test-first](M2-rooms-and-board.md#m2-02--write-the-rate-tab-so-far-and-deposit-rules-test-first) | M | M1-11, M2-01 |
| [M2-03 · Add time bands with a billing step and rounding, and the pricing property tests](M2-rooms-and-board.md#m2-03--add-time-bands-with-a-billing-step-and-rounding-and-the-pricing-property-tests) | M | M2-02 |
| [M2-04 · Build rooms and room states, and Admin → Rooms](M2-rooms-and-board.md#m2-04--build-rooms-and-room-states-and-admin--rooms) | S | M1-11, M1-13, M1-31 |
| [M2-05 · Build room blocks and room assignment](M2-rooms-and-board.md#m2-05--build-room-blocks-and-room-assignment) | M | M1-12, M2-04 |
| [M2-06 · Build guests and staff bookings, each with a real room](M2-rooms-and-board.md#m2-06--build-guests-and-staff-bookings-each-with-a-real-room) | M | M1-07, M1-17, M2-02, M2-05 |
| [M2-07 · Build room sessions, clock segments and the live room clock](M2-rooms-and-board.md#m2-07--build-room-sessions-clock-segments-and-the-live-room-clock) | M | M1-09, M2-03, M2-05, M2-06 |
| [M2-08 · Open a room check for each session, numbered in order](M2-rooms-and-board.md#m2-08--open-a-room-check-for-each-session-numbered-in-order) | S | M1-03, M2-07 |
| [M2-09 · Set up West 4's Twilio subaccount and send texts from `message_templates`](M2-rooms-and-board.md#m2-09--set-up-west-4s-twilio-subaccount-and-send-texts-from-message_templates) | M | M1-06, M1-13, M2-06 |
| [M2-10 · Build Admin → Phone & texts and Admin → Texts](M2-rooms-and-board.md#m2-10--build-admin--phone--texts-and-admin--texts) | S | M1-31, M2-09 |
| [M2-11 · Build the check-in sheet, walk-ins and Mark no-show](M2-rooms-and-board.md#m2-11--build-the-check-in-sheet-walk-ins-and-mark-no-show) | M | M2-07, M2-08, M2-09 |
| [M2-12 · Record ID checks at check-in](M2-rooms-and-board.md#m2-12--record-id-checks-at-check-in) | M | M1-02, M2-11 |
| [M2-13 · Build presigned uploads with type and size limits](M2-rooms-and-board.md#m2-13--build-presigned-uploads-with-type-and-size-limits) | S | M1-02, M1-08 |
| [M2-14 · Write the reason-only limit test-first and total it per person](M2-rooms-and-board.md#m2-14--write-the-reason-only-limit-test-first-and-total-it-per-person) | S | M1-04, M2-08 |
| [M2-15 · Build approvals, their routing and the Approvals inbox](M2-rooms-and-board.md#m2-15--build-approvals-their-routing-and-the-approvals-inbox) | M | M1-09, M1-19, M1-22 |
| [M2-16 · Report faults: out of service, pause the clock and comp 15 minutes](M2-rooms-and-board.md#m2-16--report-faults-out-of-service-pause-the-clock-and-comp-15-minutes) | M | M2-07, M2-14, M2-15 |
| [M2-17 · Build the party-size control](M2-rooms-and-board.md#m2-17--build-the-party-size-control) | S | M2-07 |
| [M2-18 · Move a room with the move sheet](M2-rooms-and-board.md#m2-18--move-a-room-with-the-move-sheet) | M | M2-05, M2-07, M2-11 |
| [M2-19 · Run cleaning, room notes and lost and found](M2-rooms-and-board.md#m2-19--run-cleaning-room-notes-and-lost-and-found) | S | M2-07, M2-13 |
| [M2-20 · Send room calls to the board and every staff phone's Calls list](M2-rooms-and-board.md#m2-20--send-room-calls-to-the-board-and-every-staff-phones-calls-list) | S | M1-22, M2-07 |
| [M2-21 · Add the damage fee with a photo](M2-rooms-and-board.md#m2-21--add-the-damage-fee-with-a-photo) | S | M2-08, M2-13 |
| [M2-22 · Take replies into the two-way inbox, on Messages desktop and phone](M2-rooms-and-board.md#m2-22--take-replies-into-the-two-way-inbox-on-messages-desktop-and-phone) | M | M2-09 |
| [M2-23 · Honor STOP and HELP at once](M2-rooms-and-board.md#m2-23--honor-stop-and-help-at-once) | S | M2-22 |
| [M2-24 · Send the Reminder and the wrap-up texts on their triggers](M2-rooms-and-board.md#m2-24--send-the-reminder-and-the-wrap-up-texts-on-their-triggers) | S | M2-05, M2-07, M2-09 |
| [M2-25 · Build the waitlist: entries, the guest page behind the door QR, and the drawer](M2-rooms-and-board.md#m2-25--build-the-waitlist-entries-the-guest-page-behind-the-door-qr-and-the-drawer) | M | M1-08, M2-06, M2-09 |
| [M2-26 · Offer a waiting party a room: hold it 10 minutes, text, count down and expire](M2-rooms-and-board.md#m2-26--offer-a-waiting-party-a-room-hold-it-10-minutes-text-count-down-and-expire) | M | M2-05, M2-09, M2-25 |
| [M2-27 · Add the server-checked CAPTCHA and daily limits to the waitlist page and phone codes](M2-rooms-and-board.md#m2-27--add-the-server-checked-captcha-and-daily-limits-to-the-waitlist-page-and-phone-codes) | S | M1-23, M2-25 |
| [M2-28 · Count the headcount with the door counter, and build Admin → Safety](M2-rooms-and-board.md#m2-28--count-the-headcount-with-the-door-counter-and-build-admin--safety) | S | M1-31, M2-07, M2-25 |
| [M2-29 · Build the Tonight board: tiles, states, clocks and counts](M2-rooms-and-board.md#m2-29--build-the-tonight-board-tiles-states-clocks-and-counts) | M | M1-21, M2-07, M2-08, M2-11, M2-16, M2-19, M2-20, M2-28 |
| [M2-30 · Show the board's alerts, most urgent first](M2-rooms-and-board.md#m2-30--show-the-boards-alerts-most-urgent-first) | S | M2-18, M2-22, M2-26, M2-29 |
| [M2-31 · Build DeskRoom and the Room phone: the room panel and the running tab](M2-rooms-and-board.md#m2-31--build-deskroom-and-the-room-phone-the-room-panel-and-the-running-tab) | M | M2-11, M2-16, M2-17, M2-18, M2-20, M2-21 |
| [M2-32 · Build the staff phone's Tonight, Rooms, Calls and Waitlist tabs](M2-rooms-and-board.md#m2-32--build-the-staff-phones-tonight-rooms-calls-and-waitlist-tabs) | M | M2-11, M2-15, M2-20, M2-25, M2-26 |
| [M2-33 · Build the Calendar on desktop and phone](M2-rooms-and-board.md#m2-33--build-the-calendar-on-desktop-and-phone) | M | M1-12, M2-06 |
| [M2-34 · Add rates, bands, minimums and limits to Admin → Hours & prices, and build Admin → Alerts & rules](M2-rooms-and-board.md#m2-34--add-rates-bands-minimums-and-limits-to-admin--hours--prices-and-build-admin--alerts--rules) | S | M1-33, M2-03 |
| [M2-35 · Finish the M2 part of the demo seed and run its scenarios end to end](M2-rooms-and-board.md#m2-35--finish-the-m2-part-of-the-demo-seed-and-run-its-scenarios-end-to-end) | M | M2-29, M2-30, M2-31, M2-32, M2-33 |

### [M3 · Room orders and the bar screen](M3-room-orders-and-bar-screen.md)

| Ticket | Size | Depends on |
| --- | --- | --- |
| [M3-01 · Write the alcohol-window and clear-out rules test-first](M3-room-orders-and-bar-screen.md#m3-01--write-the-alcohol-window-and-clear-out-rules-test-first) | S | M1-04, M1-10, M1-12 |
| [M3-02 · Write the promotion checks test-first](M3-room-orders-and-bar-screen.md#m3-02--write-the-promotion-checks-test-first) | S | M1-10 |
| [M3-03 · Build the menu tables, the menu API and 86](M3-room-orders-and-bar-screen.md#m3-03--build-the-menu-tables-the-menu-api-and-86) | M | M1-09, M1-13, M1-14, M3-02 |
| [M3-04 · Build Admin → Menu](M3-room-orders-and-bar-screen.md#m3-04--build-admin--menu) | M | M1-31, M3-03 |
| [M3-05 · Render the menu PDF on every menu change](M3-room-orders-and-bar-screen.md#m3-05--render-the-menu-pdf-on-every-menu-change) | S | M1-06, M2-13, M3-03 |
| [M3-06 · Build the order pipeline, with Accept as the sale](M3-room-orders-and-bar-screen.md#m3-06--build-the-order-pipeline-with-accept-as-the-sale) | M | M1-09, M2-08, M2-15, M3-03 |
| [M3-07 · Add drinks to a room from the staff screens, with unsent drinks saved](M3-room-orders-and-bar-screen.md#m3-07--add-drinks-to-a-room-from-the-staff-screens-with-unsent-drinks-saved) | M | M2-31, M3-06 |
| [M3-08 · Join a room with its code, on a session token that rotates](M3-room-orders-and-bar-screen.md#m3-08--join-a-room-with-its-code-on-a-session-token-that-rotates) | M | M1-08, M2-07, M2-11, M2-18 |
| [M3-09 · Build the room page: the menu, ordering and live status in the guest's words](M3-room-orders-and-bar-screen.md#m3-09--build-the-room-page-the-menu-ordering-and-live-status-in-the-guests-words) | M | M3-06, M3-08 |
| [M3-10 · Add the running bill, Call staff and the host lock to the room page](M3-room-orders-and-bar-screen.md#m3-10--add-the-running-bill-call-staff-and-the-host-lock-to-the-room-page) | S | M2-20, M3-09 |
| [M3-11 · Add Same again to the room page](M3-room-orders-and-bar-screen.md#m3-11--add-same-again-to-the-room-page) | S | M3-09 |
| [M3-12 · Run the room tablets in kiosk mode](M3-room-orders-and-bar-screen.md#m3-12--run-the-room-tablets-in-kiosk-mode) | S | M1-15, M3-10 |
| [M3-13 · Print tickets to network printers, with failures and reprints](M3-room-orders-and-bar-screen.md#m3-13--print-tickets-to-network-printers-with-failures-and-reprints) | M | M1-15, M1-34, M3-06 |
| [M3-14 · Print to USB printers through the desktop app's print host](M3-room-orders-and-bar-screen.md#m3-14--print-to-usb-printers-through-the-desktop-apps-print-host) | M | M1-28, M3-13 |
| [M3-15 · Build the bar orders screen](M3-room-orders-and-bar-screen.md#m3-15--build-the-bar-orders-screen) | M | M1-21, M3-06, M3-13 |
| [M3-16 · Age and escalate room orders on the bar screens, phones and the board](M3-room-orders-and-bar-screen.md#m3-16--age-and-escalate-room-orders-on-the-bar-screens-phones-and-the-board) | M | M1-22, M1-28, M2-09, M2-15, M2-29, M3-15 |
| [M3-17 · Alert when no bar device is connected](M3-room-orders-and-bar-screen.md#m3-17--alert-when-no-bar-device-is-connected) | S | M1-16, M1-22, M2-29 |
| [M3-18 · Carry runs on every staff phone, and take returns](M3-room-orders-and-bar-screen.md#m3-18--carry-runs-on-every-staff-phone-and-take-returns) | M | M1-22, M2-12, M3-06 |
| [M3-19 · Build the fix panel for comps and voids on every screen](M3-room-orders-and-bar-screen.md#m3-19--build-the-fix-panel-for-comps-and-voids-on-every-screen) | M | M2-14, M2-15, M2-31, M3-06 |
| [M3-20 · Check the alcohol window and cut-offs on every route that creates an alcohol line](M3-room-orders-and-bar-screen.md#m3-20--check-the-alcohol-window-and-cut-offs-on-every-route-that-creates-an-alcohol-line) | M | M3-01, M3-07, M3-09, M3-11 |
| [M3-21 · Cut off a room or one guest](M3-room-orders-and-bar-screen.md#m3-21--cut-off-a-room-or-one-guest) | M | M2-29, M2-31, M3-08, M3-20 |
| [M3-22 · Stop alcohol at 4:00 AM on every screen, and cancel what nobody accepted](M3-room-orders-and-bar-screen.md#m3-22--stop-alcohol-at-400-am-on-every-screen-and-cancel-what-nobody-accepted) | M | M1-06, M3-20 |
| [M3-23 · Raise the clear-out check at 4:30 AM](M3-room-orders-and-bar-screen.md#m3-23--raise-the-clear-out-check-at-430-am) | S | M1-06, M2-29, M3-01 |
| [M3-24 · Run accessibility checks in CI for the room page and the tablets](M3-room-orders-and-bar-screen.md#m3-24--run-accessibility-checks-in-ci-for-the-room-page-and-the-tablets) | S | M3-09, M3-10, M3-11, M3-12 |
| [M3-25 · Load the M3 part of the demo seed and run the mock Friday](M3-room-orders-and-bar-screen.md#m3-25--load-the-m3-part-of-the-demo-seed-and-run-the-mock-friday) | M | M3-14, M3-16, M3-17, M3-18, M3-19, M3-21, M3-22, M3-23, M3-24 |

### [M4 · Payments and receipts](M4-payments-and-receipts.md)

| Ticket | Size | Depends on |
| --- | --- | --- |
| [M4-01 · Create West 4's Stripe account and a pinned Stripe client](M4-payments-and-receipts.md#m4-01--create-west-4s-stripe-account-and-a-pinned-stripe-client) | M | M1 (settings, Admin shell, the `integrations` table, secrets, audit); outside: our company entity and Stripe platform account |
| [M4-02 · Register the Terminal: configuration, Location and both S710s](M4-payments-and-receipts.md#m4-02--register-the-terminal-configuration-location-and-both-s710s) | S | M4-01; M1 (devices and heartbeats) |
| [M4-03 · Receive Stripe webhooks on the three endpoints](M4-payments-and-receipts.md#m4-03--receive-stripe-webhooks-on-the-three-endpoints) | M | M4-01; M1 (jobs, worker pools, the event relay); `webhook_events` from M2's Twilio webhooks, or created here |
| [M4-04 · Add the payment tables, allocations and the amount due](M4-payments-and-receipts.md#m4-04--add-the-payment-tables-allocations-and-the-amount-due) | M | M1 (row-level security, audit triggers, the migration linter); M2 and M3 (the open room check and its lines as orders join at Accept) |
| [M4-05 · Run every card attempt through one state machine](M4-payments-and-receipts.md#m4-05--run-every-card-attempt-through-one-state-machine) | M | M4-01, M4-03, M4-04 |
| [M4-06 · Work out check totals, tax and gratuity in packages/rules](M4-payments-and-receipts.md#m4-06--work-out-check-totals-tax-and-gratuity-in-packagesrules) | M | M2 (room time in `packages/rules`); M1 (the rule pack and settings types) |
| [M4-07 · Finalize checks into revisions, with tax lines and check numbers](M4-payments-and-receipts.md#m4-07--finalize-checks-into-revisions-with-tax-lines-and-check-numbers) | M | M4-04, M4-06; M2 and M3 (checks and their lines) |
| [M4-08 · Present the check and reopen it](M4-payments-and-receipts.md#m4-08--present-the-check-and-reopen-it) | M | M4-07; M3 (orders, ordering from the room, the room page and tablets); M2 (room states and cleaning) |
| [M4-09 · Apply the deposit at check-in and write forfeit lines](M4-payments-and-receipts.md#m4-09--apply-the-deposit-at-check-in-and-write-forfeit-lines) | S | M4-04, M4-07; M2 (the check-in sheet and `POST /bookings/{b}/check-in`) |
| [M4-10 · Load the seed's deposits, checks and drawers into staging](M4-payments-and-receipts.md#m4-10--load-the-seeds-deposits-checks-and-drawers-into-staging) | S | M4-02, M4-04, M4-09; M1 (the seed loader) |
| [M4-11 · Take a tap on the chosen reader, with every reader state](M4-payments-and-receipts.md#m4-11--take-a-tap-on-the-chosen-reader-with-every-reader-state) | M | M4-02, M4-05, M4-08 |
| [M4-12 · Reconcile unknown results and pass the chaos tests](M4-payments-and-receipts.md#m4-12--reconcile-unknown-results-and-pass-the-chaos-tests) | M | M4-05, M4-11 |
| [M4-13 · Take cash into the drawer at the screen where it's taken](M4-payments-and-receipts.md#m4-13--take-cash-into-the-drawer-at-the-screen-where-its-taken) | M | M4-04, M4-08; M3 (print jobs and the desktop app's USB print host); M1 (devices) |
| [M4-14 · Split a check evenly or by item, kept on the server](M4-payments-and-receipts.md#m4-14--split-a-check-evenly-or-by-item-kept-on-the-server) | M | M4-06, M4-11, M4-13 |
| [M4-15 · Serve the payment page on its own origin](M4-payments-and-receipts.md#m4-15--serve-the-payment-page-on-its-own-origin) | M | M4-01, M4-05; M3 (`apps/guest`) |
| [M4-16 · Show "Your bill" on the room page and the booking link](M4-payments-and-receipts.md#m4-16--show-your-bill-on-the-room-page-and-the-booking-link) | M | M4-08, M4-15; M3 (the room page, tablets, room calls) |
| [M4-17 · Charge the card on file with the guest's OK or a manager's approval](M4-payments-and-receipts.md#m4-17--charge-the-card-on-file-with-the-guests-ok-or-a-managers-approval) | M | M4-05, M4-15, M4-16; M2 (approvals, the Approvals inbox, texts) |
| [M4-18 · Let guests pay their own share](M4-payments-and-receipts.md#m4-18--let-guests-pay-their-own-share) | M | M4-14, M4-15, M4-16 |
| [M4-19 · Print, text and email receipts, and serve the public receipt page](M4-payments-and-receipts.md#m4-19--print-text-and-email-receipts-and-serve-the-public-receipt-page) | M | M4-07, M4-11, M4-13; M3 (print jobs and the PDF job); M2 (texts); M1 (the email provider) |
| [M4-20 · Close out a room on DeskRoom and the Room phone](M4-payments-and-receipts.md#m4-20--close-out-a-room-on-deskroom-and-the-room-phone) | L | M4-08, M4-11, M4-13, M4-14, M4-17, M4-18, M4-19 |
| [M4-21 · Refund from a paid check, approved on another phone and capped](M4-payments-and-receipts.md#m4-21--refund-from-a-paid-check-approved-on-another-phone-and-capped) | M | M4-05, M4-07, M4-13; M2 (approvals) |
| [M4-22 · Offer Refund from check on the staff phone and DeskRoom](M4-payments-and-receipts.md#m4-22--offer-refund-from-check-on-the-staff-phone-and-deskroom) | S | M4-21 |
| [M4-23 · Approve a lower party size after the gratuity applies](M4-payments-and-receipts.md#m4-23--approve-a-lower-party-size-after-the-gratuity-applies) | S | M4-07; M2 (the party size control, approvals) |
| [M4-24 · Open the disputes inbox with its evidence gathered](M4-payments-and-receipts.md#m4-24--open-the-disputes-inbox-with-its-evidence-gathered) | M | M4-03, M4-19; M2 (files and damage photos) |
| [M4-25 · Build the card-fee engine, off at West 4](M4-payments-and-receipts.md#m4-25--build-the-card-fee-engine-off-at-west-4) | M | M4-01, M4-06, M4-11, M4-13 |
| [M4-26 · Build Admin → Card fee & gratuity](M4-payments-and-receipts.md#m4-26--build-admin--card-fee--gratuity) | S | M4-02, M4-25; M1 (settings and Admin) |
| [M4-27 · Add minimum spend, off at West 4](M4-payments-and-receipts.md#m4-27--add-minimum-spend-off-at-west-4) | M | M4-06, M4-08; M2 (check-in, tiles, DeskRoom, Admin → Hours & prices); M3 (the room page) |
| [M4-28 · Reserve the prepaid-value ledger and session merges](M4-payments-and-receipts.md#m4-28--reserve-the-prepaid-value-ledger-and-session-merges) | M | M4-04, M4-07, M4-09 |
| [M4-29 · Run the go-live checklist for West 4](M4-payments-and-receipts.md#m4-29--run-the-go-live-checklist-for-west-4) | S | M4-01, M4-02 |
| [M4-30 · Prove Room 9's close-outs end to end and run the live payment drill](M4-payments-and-receipts.md#m4-30--prove-room-9s-close-outs-end-to-end-and-run-the-live-payment-drill) | M | M4-01 to M4-29; outside: West 4's onboarding and both S710s registered to its Location |

### [M5 · Guest site and online booking](M5-guest-site-and-booking.md)

| Ticket | Size | Depends on |
| --- | --- | --- |
| [M5-01 · Render the guest site from site_versions](M5-guest-site-and-booking.md#m5-01--render-the-guest-site-from-site_versions) | M | M3 (`apps/guest`, the menu); M1 (settings, modules, `closures`) |
| [M5-02 · Build Admin → Website](M5-guest-site-and-booking.md#m5-02--build-admin--website) | M | M5-01; M2 (`POST /files`) |
| [M5-03 · Serve the menu page and the PDF from one menu list](M5-guest-site-and-booking.md#m5-03--serve-the-menu-page-and-the-pdf-from-one-menu-list) | M | M5-01; M3 (the menu, the menu PDF job, the room page) |
| [M5-04 · Take private-party enquiries into Messages](M5-guest-site-and-booking.md#m5-04--take-private-party-enquiries-into-messages) | S | M5-01; M2 (Messages, `conversations`, the CAPTCHA) |
| [M5-05 · Guard booking and enquiries with the CAPTCHA and daily limits](M5-guest-site-and-booking.md#m5-05--guard-booking-and-enquiries-with-the-captcha-and-daily-limits) | S | M2 (the server-checked CAPTCHA and daily limits) |
| [M5-06 · Build Admin → Deposits & cancelling, with the policy guests accept](M5-guest-site-and-booking.md#m5-06--build-admin--deposits--cancelling-with-the-policy-guests-accept) | M | M1 (settings, the rule pack); M4-09 (forfeit lines) |
| [M5-07 · Quote a booking and hold a real room for 10 minutes](M5-guest-site-and-booking.md#m5-07--quote-a-booking-and-hold-a-real-room-for-10-minutes) | M | M5-05, M5-06; M2 (room assignment, `room_blocks`, bookings) |
| [M5-08 · Take the guest's details, consents and the policy they accept](M5-guest-site-and-booking.md#m5-08--take-the-guests-details-consents-and-the-policy-they-accept) | M | M5-06, M5-07; M2 (texts and STOP) |
| [M5-09 · Pay the deposit on the payment page](M5-guest-site-and-booking.md#m5-09--pay-the-deposit-on-the-payment-page) | M | M5-08; M4-05, M4-15 |
| [M5-10 · Confirm the booking and send the confirmation](M5-guest-site-and-booking.md#m5-10--confirm-the-booking-and-send-the-confirmation) | M | M5-09; M4-03, M4-12; M2 (texts) |
| [M5-11 · Change a booking on the manage page](M5-guest-site-and-booking.md#m5-11--change-a-booking-on-the-manage-page) | M | M5-10; M2 (room assignment, running late) |
| [M5-12 · Cancel by the refund cut-off, charge no-shows, and let the venue cancel](M5-guest-site-and-booking.md#m5-12--cancel-by-the-refund-cut-off-charge-no-shows-and-let-the-venue-cancel) | M | M5-11; M4-09, M4-21; M2 (Mark no-show, closures, the Calendar) |
| [M5-13 · Send payment links for staff and big-party bookings, and save cards for cardHold](M5-guest-site-and-booking.md#m5-13--send-payment-links-for-staff-and-big-party-bookings-and-save-cards-for-cardhold) | M | M5-09, M5-10; M2 (staff bookings, the Calendar and DeskCalendar) |
| [M5-14 · Turn booking off with the module, and keep manage links working](M5-guest-site-and-booking.md#m5-14--turn-booking-off-with-the-module-and-keep-manage-links-working) | S | M5-01, M5-12 |
| [M5-15 · Push hours to Google Business Profile](M5-guest-site-and-booking.md#m5-15--push-hours-to-google-business-profile) | M | M1 (`hours`, `closures`, `integrations`); M4-01 (Admin → Connections) |
| [M5-16 · Check accessibility: WCAG 2.2 AA in CI and a screen-reader pass](M5-guest-site-and-booking.md#m5-16--check-accessibility-wcag-22-aa-in-ci-and-a-screen-reader-pass) | M | M5-01 to M5-13; M3 (the room page and ordering); M2 (the waitlist page); M4-16, M4-18 (the bill and Pay my share) |
| [M5-17 · Prove Jae & co.'s booking end to end, and the payment page checks](M5-guest-site-and-booking.md#m5-17--prove-jae--cos-booking-end-to-end-and-the-payment-page-checks) | M | M5-01 to M5-16 |

### [M6 · Bar POS, tabs and bar mode](M6-bar-pos-tabs-and-bar-mode.md)

| Ticket | Size | Depends on |
| --- | --- | --- |
| [M6-01 · Publish bar POS layouts that start at the next business date](M6-bar-pos-tabs-and-bar-mode.md#m6-01--publish-bar-pos-layouts-that-start-at-the-next-business-date) | M | M3 (the menu with `button_name`); M1 (settings, Admin) |
| [M6-02 · Build the bar POS screen around the fixed grid](M6-bar-pos-tabs-and-bar-mode.md#m6-02--build-the-bar-pos-screen-around-the-fixed-grid) | M | M6-01; M3 (room-order cards, 86, the desktop side menu); M1 (the desktop app shell) |
| [M6-03 · Ring a round: usual options, repeat round, undo and drafts on the server](M6-bar-pos-tabs-and-bar-mode.md#m6-03--ring-a-round-usual-options-repeat-round-undo-and-drafts-on-the-server) | M | M6-02; M3 (`POST /checks/{c}/orders`, the alcohol check) |
| [M6-04 · Share the terminal: badge takeover, idle and wipe locks, "Maya · on break"](M6-bar-pos-tabs-and-bar-mode.md#m6-04--share-the-terminal-badge-takeover-idle-and-wipe-locks-maya--on-break) | M | M6-02; M1 (badges, PINs, the desktop app shell) |
| [M6-05 · Sell at the bar with Quick sale](M6-bar-pos-tabs-and-bar-mode.md#m6-05--sell-at-the-bar-with-quick-sale) | M | M6-03; M4-11, M4-13, M4-19 |
| [M6-06 · Open a tab card first, with the consent line and one tab per card](M6-bar-pos-tabs-and-bar-mode.md#m6-06--open-a-tab-card-first-with-the-consent-line-and-one-tab-per-card) | M | M6-02; M4-02, M4-05, M4-29 (the merchant category check before bar tabs turn on) |
| [M6-07 · Grow the hold, and handle a declined raise](M6-bar-pos-tabs-and-bar-mode.md#m6-07--grow-the-hold-and-handle-a-declined-raise) | M | M6-03, M6-06; M4-05; M2 (approvals) |
| [M6-08 · Close a tab with the tip on the reader](M6-bar-pos-tabs-and-bar-mode.md#m6-08--close-a-tab-with-the-tip-on-the-reader) | M | M6-07; M4-07, M4-19 |
| [M6-09 · Fall back to the paper slip, and enter tips from Tips to enter](M6-bar-pos-tabs-and-bar-mode.md#m6-09--fall-back-to-the-paper-slip-and-enter-tips-from-tips-to-enter) | M | M6-08; M2 (files, approvals); M4-19 |
| [M6-10 · Split a tab and keep its paid shares](M6-bar-pos-tabs-and-bar-mode.md#m6-10--split-a-tab-and-keep-its-paid-shares) | M | M6-08; M4-14 |
| [M6-11 · Pay a tab with another card or cash](M6-bar-pos-tabs-and-bar-mode.md#m6-11--pay-a-tab-with-another-card-or-cash) | M | M6-08; M4-13 |
| [M6-12 · Reopen a settled tab and charge the saved card](M6-bar-pos-tabs-and-bar-mode.md#m6-12--reopen-a-settled-tab-and-charge-the-saved-card) | M | M6-08, M6-11; M4-21, M4-22; M2 (approvals) |
| [M6-13 · Move a tab into a room, and move lines between tabs](M6-bar-pos-tabs-and-bar-mode.md#m6-13--move-a-tab-into-a-room-and-move-lines-between-tabs) | M | M6-07; M4-07, M4-09; M3 (the alcohol check, room cut-offs) |
| [M6-14 · Cut off a tab, and gray out alcohol on the bar POS](M6-bar-pos-tabs-and-bar-mode.md#m6-14--cut-off-a-tab-and-gray-out-alcohol-on-the-bar-pos) | S | M6-02; M3 (the alcohol check, room and guest cut-offs, the 4 AM stop) |
| [M6-15 · Fix a sent drink on the bar POS and show who it's waiting for](M6-bar-pos-tabs-and-bar-mode.md#m6-15--fix-a-sent-drink-on-the-bar-pos-and-show-who-its-waiting-for) | S | M6-02; M3 (the fix panel, reason-only limits, void approvals) |
| [M6-16 · Charge the remaining tabs, and run the 4:30 AM tab cut-off](M6-bar-pos-tabs-and-bar-mode.md#m6-16--charge-the-remaining-tabs-and-run-the-430-am-tab-cut-off) | M | M6-08, M6-15; M1 (the scheduler) |
| [M6-17 · Sweep awaiting-tip tabs, watch hold expiry, and settle failed captures](M6-bar-pos-tabs-and-bar-mode.md#m6-17--sweep-awaiting-tip-tabs-watch-hold-expiry-and-settle-failed-captures) | M | M6-09, M6-16 |
| [M6-18 · Keep the song queue: singers, credits and the rotation](M6-bar-pos-tabs-and-bar-mode.md#m6-18--keep-the-song-queue-singers-credits-and-the-rotation) | M | M3 (the menu and orders); M2 (phone codes and texts); M4-28 (the prepaid-value ledger) |
| [M6-19 · Start and skip songs: song lines, credits back and the play log](M6-bar-pos-tabs-and-bar-mode.md#m6-19--start-and-skip-songs-song-lines-credits-back-and-the-play-log) | M | M6-18, M6-07; M4-06 |
| [M6-20 · Build the singer's queue page](M6-bar-pos-tabs-and-bar-mode.md#m6-20--build-the-singers-queue-page) | M | M6-18, M6-19; M5-01 (the site's "Sing at the bar"); M2 (the CAPTCHA on phone codes, the waitlist page) |
| [M6-21 · Alert singers by push and text](M6-bar-pos-tabs-and-bar-mode.md#m6-21--alert-singers-by-push-and-text) | M | M6-19, M6-20; M2 (texts and STOP) |
| [M6-22 · Build the KJ's song-queue screen and the Up next TV](M6-bar-pos-tabs-and-bar-mode.md#m6-22--build-the-kjs-song-queue-screen-and-the-up-next-tv) | M | M6-18, M6-19; M1 (pairing a shared device) |
| [M6-23 · Upload the songbook CSV and search it](M6-bar-pos-tabs-and-bar-mode.md#m6-23--upload-the-songbook-csv-and-search-it) | M | M6-20; M2 (`POST /files`) |
| [M6-24 · Send the singer a drink as a checked gift order](M6-bar-pos-tabs-and-bar-mode.md#m6-24--send-the-singer-a-drink-as-a-checked-gift-order) | S | M6-18, M6-07; M3 (orders, the alcohol check) |
| [M6-25 · Build Admin → Bar POS](M6-bar-pos-tabs-and-bar-mode.md#m6-25--build-admin--bar-pos) | M | M6-01, M6-06; M1 (Admin) |
| [M6-26 · Build Admin → Bar mode](M6-bar-pos-tabs-and-bar-mode.md#m6-26--build-admin--bar-mode) | S | M6-18, M6-23 |
| [M6-27 · Load the seed's bar tabs, slips and singer queue into staging](M6-bar-pos-tabs-and-bar-mode.md#m6-27--load-the-seeds-bar-tabs-slips-and-singer-queue-into-staging) | M | M6-06 to M6-19 |
| [M6-28 · Prove every tab path and the queue end to end, and time the staff tasks](M6-bar-pos-tabs-and-bar-mode.md#m6-28--prove-every-tab-path-and-the-queue-end-to-end-and-time-the-staff-tasks) | M | M6-01 to M6-27 |
| [M6-29 · Print bar tickets only for room orders, unless "Print tickets for drinks rung at the bar" is on](M6-bar-pos-tabs-and-bar-mode.md#m6-29--print-bar-tickets-only-for-room-orders-unless-print-tickets-for-drinks-rung-at-the-bar-is-on) | S | M6-03, M6-05, M6-25; M3-13 (tickets) |

### [M7 · Close the night and the books](M7-close-the-night-and-books.md)

| Ticket | Size | Depends on |
| --- | --- | --- |
| [M7-01 · Clock in with a duty, take breaks and build shifts](M7-close-the-night-and-books.md#m7-01--clock-in-with-a-duty-take-breaks-and-build-shifts) | M | M1-24 and M1-25 (name and PIN, badges), M1-07 (audit triggers), M1-21 (string catalogs), M2-14 (the reason-only total), M2-15 (`manager_on_duty()` and its `duty_managers` stand-in), M6 (the bar POS top bar) |
| [M7-02 · Guard closed nights and post late money to the next open night](M7-close-the-night-and-books.md#m7-02--guard-closed-nights-and-post-late-money-to-the-next-open-night) | S | M1-04 (business-date helpers), M1-07 (audit), M4-07 (`venue_counters`, including `z_report`), M4-21 (refunds with `adjusts_business_date`) |
| [M7-03 · Turn on training mode per person or per device](M7-close-the-night-and-books.md#m7-03--turn-on-training-mode-per-person-or-per-device) | M | M1-31 (Admin → Team, `PATCH /team/{m}`), M1-15 (devices, `PATCH /devices/{d}`), M3-06 (the order pipeline), M3-13 (tickets), M4-07 (checks and the `check_training` counter), M4-19 (receipts), M6 (bar POS and tabs) |
| [M7-04 · Send practice payments only to Stripe's sandbox](M7-close-the-night-and-books.md#m7-04--send-practice-payments-only-to-stripes-sandbox) | M | M7-03; M4-01 (the Stripe client, whose live or sandbox choice lives in one place), M4-02 (readers), M4-03 (webhook endpoints), M4-05 and M4-12 (the state machine and the reconciler); M6 (tab holds, tips on the reader) |
| [M7-05 · Count drawers blind and hand them over when the manager on duty changes](M7-close-the-night-and-books.md#m7-05--count-drawers-blind-and-hand-them-over-when-the-manager-on-duty-changes) | M | M7-01, M7-02; M4-13 (the two house drawers, their sessions opened at each business date's start with the starting bank, sale moves "Logged to Maya · bar drawer"); M2-15 (approvals on the approver's own phone); M1-11 (settings versions, read as they stood at a business date's start) |
| [M7-06 · Take drops, paid-outs, no-sales and tip-outs at the drawer](M7-close-the-night-and-books.md#m7-06--take-drops-paid-outs-no-sales-and-tip-outs-at-the-drawer) | M | M7-05; M4-13 (staff banks from cash taken on a phone, cash refunds as drawer moves, the drawer kick); M2-15 (approvals and `202 approval_pending`), M2-13 (`POST /files`) |
| [M7-07 · Run a drawer per person with trays](M7-close-the-night-and-books.md#m7-07--run-a-drawer-per-person-with-trays) | M | M7-05, M7-06, M7-01 |
| [M7-08 · Keep the tip ledger](M7-close-the-night-and-books.md#m7-08--keep-the-tip-ledger) | M | M7-01, M7-02; M4-07 (gratuity lines), M4-20 ("Additional tip (optional)"), M4-13 (cash tips at the cash panel), M4-21 (refunds); M6 (tips on the reader, Tips to enter, tip review approvals, the sweeper) |
| [M7-09 · Pool tips by hours with eligibility and shares by occupation](M7-close-the-night-and-books.md#m7-09--pool-tips-by-hours-with-eligibility-and-shares-by-occupation) | M | M7-01, M7-08; M1-31 (Admin → Team), M1-11 (settings versions) |
| [M7-10 · Show each person My tips with the 146-2.17 records](M7-close-the-night-and-books.md#m7-10--show-each-person-my-tips-with-the-146-217-records) | S | M7-09 |
| [M7-11 · Walk the clock-out checklist, and edit punches with a reason](M7-close-the-night-and-books.md#m7-11--walk-the-clock-out-checklist-and-edit-punches-with-a-reason) | M | M7-01, M7-05 (the handover), M7-06 (drops), M7-07 (count your own drawer), M7-08 (declared cash tips); M6 (`tabs.owner_id`, `order_drafts`, `POST /tabs/{t}/hand-over`) |
| [M7-12 · Build Close the night: the checks before closing and the close](M7-close-the-night-and-books.md#m7-12--build-close-the-night-the-checks-before-closing-and-the-close) | L | M7-01, M7-02, M7-05, M7-07, M7-09, M7-11; M3-23 (the clear-out check); M6 (Charge the remaining tabs, the 4:30 AM tab cut-off, Tips to enter, `capture_failed` tabs); M2-25 (waitlist), M2-19 (cleaning), M2-15 (approvals) |
| [M7-13 · Print the running X report and the Z report](M7-close-the-night-and-books.md#m7-13--print-the-running-x-report-and-the-z-report) | L | M7-12, M7-05, M7-09, M7-03; M4-07 (check revisions, tax and gratuity lines), M4-09 (deposits and forfeit lines), M4-21 (refunds); M6 (tabs) |
| [M7-14 · Match payouts and work through Unmatched payments](M7-close-the-night-and-books.md#m7-14--match-payouts-and-work-through-unmatched-payments) | M | M7-02; M4-03 (payout events stored for M7), M4-04 (payments with `stripe_pi_id`), M4-12 (the reconciler, which already records Stripe activity with no row of ours), M4-21 (refunds), M4-24 (disputes) |
| [M7-15 · Write the nightly accounting journal and Export for QuickBooks](M7-close-the-night-and-books.md#m7-15--write-the-nightly-accounting-journal-and-export-for-quickbooks) | L | M7-12, M7-13, M7-14; M4-24 (dispute funds kept for the journal), M4-28 (the prepaid-value ledger's kinds) |
| [M7-16 · Export payroll with gratuity split from tips](M7-close-the-night-and-books.md#m7-16--export-payroll-with-gratuity-split-from-tips) | S | M7-01, M7-09 |
| [M7-17 · Report the sales-tax quarter](M7-close-the-night-and-books.md#m7-17--report-the-sales-tax-quarter) | S | M7-13 |
| [M7-18 · Build Reports and the report routes](M7-close-the-night-and-books.md#m7-18--build-reports-and-the-report-routes) | L | M7-13, M7-14, M7-16, M7-17 |
| [M7-19 · Reconcile two weeks of staging nights to the cent](M7-close-the-night-and-books.md#m7-19--reconcile-two-weeks-of-staging-nights-to-the-cent) | L | M7-12, M7-13, M7-14, M7-15, M7-16 |
| [M7-20 · Close GA-M2 and GA-M4, and sign off M7](M7-close-the-night-and-books.md#m7-20--close-ga-m2-and-ga-m4-and-sign-off-m7) | S | M7-01 to M7-19 |

### [M8 · Offline, safety and operations](M8-offline-safety-and-operations.md)

| Ticket | Size | Depends on |
| --- | --- | --- |
| [M8-01 · Show the outage and vendor banners, and the sync footer](M8-offline-safety-and-operations.md#m8-01--show-the-outage-and-vendor-banners-and-the-sync-footer) | M | M1-09 (event stream and WebSockets), M1-16 (heartbeats), M1-21 (string catalogs), M2-29 (the board), M3-15 (the bar orders screen), M6 (the bar POS) |
| [M8-02 · Report the router as a device: on the line or on LTE](M8-offline-safety-and-operations.md#m8-02--report-the-router-as-a-device-on-the-line-or-on-lte) | M | M1-15 (devices and pairing), M1-16 (heartbeats), M1-34 (Admin → Printers & devices), M1-35 (the Console's device health) |
| [M8-03 · Keep a read-only offline view in the desktop app](M8-offline-safety-and-operations.md#m8-03--keep-a-read-only-offline-view-in-the-desktop-app) | M | M1-28 (the desktop app's encrypted SQLite cache and keychain token), M2-29 (the board), M3-03 (the menu and 86), M3-16 (ringing orders on the locked device's channel), M6 (open tabs) |
| [M8-04 · Take orders in queue mode behind an offline code](M8-offline-safety-and-operations.md#m8-04--take-orders-in-queue-mode-behind-an-offline-code) | L | M8-03; M1-15 (device keys), M1-28 (the keychain); M6 (bar POS rounds, `order_drafts`) |
| [M8-05 · Replay queued orders as asked to wait, and list Review after outage](M8-offline-safety-and-operations.md#m8-05--replay-queued-orders-as-asked-to-wait-and-list-review-after-outage) | M | M8-04; M7-12 (Night); M7-14 (Unmatched payments); M3-06 (the order pipeline and `held`) |
| [M8-06 · Print the break-glass card](M8-offline-safety-and-operations.md#m8-06--print-the-break-glass-card) | S | M7-14 (Unmatched payments); M4-29 (the go-live checklist of managers' Stripe Dashboard logins and Tap to Pay phones); M3-05 (the PDF job) |
| [M8-07 · Run the four outage drills at West 4](M8-offline-safety-and-operations.md#m8-07--run-the-four-outage-drills-at-west-4) | M | M8-01 to M8-06; the router and both S710s installed at West 4, ahead of the full install |
| [M8-08 · Send the private help alert and keep the incident log](M8-offline-safety-and-operations.md#m8-08--send-the-private-help-alert-and-keep-the-incident-log) | M | M3-09 (the room page), M1-22 (staff phones with push), M2-28 (Admin → Safety) |
| [M8-09 · Keep the license register with renewal reminders](M8-offline-safety-and-operations.md#m8-09--keep-the-license-register-with-renewal-reminders) | M | M2-13 (`POST /files`), M1-31 (Admin), M1-06 (jobs), M1-18 (email), M1-22 (push) |
| [M8-10 · Let the owner approve support grants, and enforce them](M8-offline-safety-and-operations.md#m8-10--let-the-owner-approve-support-grants-and-enforce-them) | L | M1-35 (Console sign-in with FIDO2 keys), M1-05 (row-level security), M1-07 (audit triggers), M1-19 (owner passkey sessions) |
| [M8-11 · Run the Console's emergency actions with a second approver](M8-offline-safety-and-operations.md#m8-11--run-the-consoles-emergency-actions-with-a-second-approver) | M | M8-10; M4-12 (the reconciler), M4-11 (reader actions); M3-13 (print jobs and reprints); M7-12 (the close) |
| [M8-12 · Run the nightly retention job and detach saved cards on schedule](M8-offline-safety-and-operations.md#m8-12--run-the-nightly-retention-job-and-detach-saved-cards-on-schedule) | L | M1-06 (jobs), M1-05 (roles), M2-06 (guests and bookings), M2-22 (messages), M2-23 (consents), M2-25 (waitlist), M2-13 (files), M5-09 (cards saved at booking), M6 (singers, cards saved on bar tabs) |
| [M8-13 · Erase a guest on request](M8-offline-safety-and-operations.md#m8-13--erase-a-guest-on-request) | M | M5-08 (guests' details and consents from booking), M5-09 (cards saved at booking); M2-09 (the Twilio subaccount), M2-22 (messages); M6 (singers) |
| [M8-14 · Destroy each night's ID-scan key after 7 days](M8-offline-safety-and-operations.md#m8-14--destroy-each-nights-id-scan-key-after-7-days) | S | M2-12 (`id_checks` with scan fields encrypted by a key per venue and business date) |
| [M8-15 · Bill our plan on Stripe Billing](M8-offline-safety-and-operations.md#m8-15--bill-our-plan-on-stripe-billing) | M | our company entity and Stripe platform account (the M4 wait); M4-03 (billing events stored for M8); M1-31 (Admin); M2-04 (rooms and archiving) |
| [M8-16 · Watch production: telemetry, error tracking and the status page](M8-offline-safety-and-operations.md#m8-16--watch-production-telemetry-error-tracking-and-the-status-page) | M | M1 (every service), M3-16 (the order-to-alarm path), M4-05 (payments) |
| [M8-17 · Page on money risk with runbooks, and put two people on call](M8-offline-safety-and-operations.md#m8-17--page-on-money-risk-with-runbooks-and-put-two-people-on-call) | M | M8-16; M7-14 (payout matching); M6 (the capture sweep); M1-06 (jobs and dead letters), M1-16 (heartbeats and grouped device alerts) |
| [M8-18 · Run a synthetic order and reader payment every 5 minutes](M8-offline-safety-and-operations.md#m8-18--run-a-synthetic-order-and-reader-payment-every-5-minutes) | S | M8-16, M8-17, M7-04 (the sandbox path for practice payments); M3-08 and M3-06 (joining a room and ordering); M4-11 (reader payments) |
| [M8-19 · Close the security baseline (GA-M9)](M8-offline-safety-and-operations.md#m8-19--close-the-security-baseline-ga-m9) | M | M1-19 (sign-in), M1-37 (the venue-wall suites), M1-07 (audit), M4-01 (restricted keys), M4-03 (webhook endpoints), M4-15 (the payment page and its changed-script check), M5-05 (booking's public forms), M8-16 |
| [M8-20 · Restore one venue from a scratch copy, and drill it monthly](M8-offline-safety-and-operations.md#m8-20--restore-one-venue-from-a-scratch-copy-and-drill-it-monthly) | L | M1-05 (row-level security and the audited migration role), M1-07 (audit triggers), M4-04 (the money core), M8-13 (the erasure log) |
| [M8-21 · Load-test a Friday night for 20 venues](M8-offline-safety-and-operations.md#m8-21--load-test-a-friday-night-for-20-venues) | L | M8-16; M3-06 and M3-16 (orders and the alarm), M4-05 (payments), M6 (tabs), M7-18 (a heavy report) |
| [M8-22 · Put West 4's texts live on its 10DLC campaign](M8-offline-safety-and-operations.md#m8-22--put-west-4s-texts-live-on-its-10dlc-campaign) | S | West 4's 10DLC brand and campaign approval; M2-09 (the Twilio subaccount), M2-23 (STOP and HELP); M5-08 (the marketing opt-in with proof) |
| [M8-23 · Run the one-room mic power trial (K1)](M8-offline-safety-and-operations.md#m8-23--run-the-one-room-mic-power-trial-k1) | M | West 4's written approval; Playbox's answer on the equipment warranty; M1-15 and M1-16 (devices and heartbeats), M2-11 (check-in), M2-19 (cleaning), M4-20 (close-out) |
| [M8-24 · Close GA-M3, GA-M8, GA-M9 and GA-M10, and sign off M8](M8-offline-safety-and-operations.md#m8-24--close-ga-m3-ga-m8-ga-m9-and-ga-m10-and-sign-off-m8) | S | M8-01 to M8-22 |

### [M9 · Cutover and going live](M9-cutover-and-going-live.md)

| Ticket | Size | Depends on |
| --- | --- | --- |
| [M9-01 · Build the import tool for West 4's export files](M9-cutover-and-going-live.md#m9-01--build-the-import-tool-for-west-4s-export-files) | M | M1-05 (the audited migration role), M1-07 (audit triggers), M2-04 (rooms), M2-06 (guests and bookings), M3-03 (the menu's save path), M5-06 (policy versions), M5-11 (manage links) |
| [M9-02 · Import West 4's future bookings with their deposits](M9-cutover-and-going-live.md#m9-02--import-west-4s-future-bookings-with-their-deposits) | M | M9-01; M5-06 (policy versions), M5-11 (manage links), M5-12 (refund cut-offs); M4-04 (payments and allocations), M4-09 (deposits applied at check-in); M2-05 (room assignment) |
| [M9-03 · Import guests with their consent evidence](M9-cutover-and-going-live.md#m9-03--import-guests-with-their-consent-evidence) | S | M9-01; M2-06 (guests), M2-23 (consents, STOP and HELP); M8-13 (opt-outs kept as hashes) |
| [M9-04 · Import the menu](M9-cutover-and-going-live.md#m9-04--import-the-menu) | S | M9-01; M3-03 and M3-04 (the menu API and Admin → Menu), M3-02 (the promotion checks), M3-05 (the menu PDF job); M6 (`pos_layouts`) |
| [M9-05 · Import the team as people and roles only](M9-cutover-and-going-live.md#m9-05--import-the-team-as-people-and-roles-only) | S | M9-01; M1-05 (memberships), M1-14 (roles), M1-31 (Admin → Team and languages) |
| [M9-06 · Run the import dry run and prove nothing is lost](M9-cutover-and-going-live.md#m9-06--run-the-import-dry-run-and-prove-nothing-is-lost) | M | M9-01 to M9-05 |
| [M9-07 · Install and pair the hardware, and check the cellular signal at every pay point](M9-cutover-and-going-live.md#m9-07--install-and-pair-the-hardware-and-check-the-cellular-signal-at-every-pay-point) | M | M1-15 (pairing), M1-30 (the USB NFC readers), M3-13 and M3-14 (network and USB printers), M4-02 (readers on West 4's Location), M4-13 (drawers), M6 (the Up next TV), M8-02 (the router) |
| [M9-08 · Get everyone their own PIN and badge](M9-cutover-and-going-live.md#m9-08--get-everyone-their-own-pin-and-badge) | S | M9-05, M9-07 (badge readers installed); M1-23 (invites and Set your PIN), M1-30 (badge pairing), M1-22 (push) |
| [M9-09 · Move west4karaoke.com with a redirect from every old page](M9-cutover-and-going-live.md#m9-09--move-west4karaokecom-with-a-redirect-from-every-old-page) | M | M5-01 (the guest site), M9-06 (the cutover delta) |
| [M9-10 · Train the team in training mode](M9-cutover-and-going-live.md#m9-10--train-the-team-in-training-mode) | S | M7-03, M7-04, M9-08 |
| [M9-11 · Run the timed staff trial](M9-cutover-and-going-live.md#m9-11--run-the-timed-staff-trial) | M | M9-07, M9-10; M7-03 and M7-04 (training mode) |
| [M9-12 · Review every staff screen in Spanish](M9-cutover-and-going-live.md#m9-12--review-every-staff-screen-in-spanish) | S | the staff screens of M1 to M8 |
| [M9-13 · Collect the gate sign-offs and apply them](M9-cutover-and-going-live.md#m9-13--collect-the-gate-sign-offs-and-apply-them) | M | nothing to start; the requests go out on day one |
| [M9-14 · Prove every must-fix item closed](M9-cutover-and-going-live.md#m9-14--prove-every-must-fix-item-closed) | S | M7-20, M8-24, and the sign-off tickets of M1 to M6 |
| [M9-15 · Check every live night for money errors](M9-cutover-and-going-live.md#m9-15--check-every-live-night-for-money-errors) | M | M7-13, M7-14, M7-15, M7-19 (the reconcile script) |
| [M9-16 · Go live, with on-call covering every opening hour](M9-cutover-and-going-live.md#m9-16--go-live-with-on-call-covering-every-opening-hour) | M | M9-06 to M9-15; M8-17 (paging and the second responder); M8-22 (texts live) |
| [M9-17 · Run 4 weeks of live nights without a money error](M9-cutover-and-going-live.md#m9-17--run-4-weeks-of-live-nights-without-a-money-error) | S | M9-13, M9-14, M9-15, M9-16 |
