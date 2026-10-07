
# M8 · Offline, safety and operations

Sep 29, 2026 · the backlog for [M8 · Offline, safety and operations](../milestones.md#m8--offline-safety-and-operations), one ticket per Claude Code session. The [spec](../spec/README.md) says how each piece works, [screens](../screens.md) says where to build differently from the frozen canvas, and the checks use the [demo seed](../demo-seed.md)'s names and numbers. Paths follow the repo layout M1's first ticket creates (`apps/api`, `apps/staff`, `apps/desktop`, `apps/guest`, `apps/console`, `packages/db`, `packages/rules`, `packages/shared`). Runbooks go in `docs/runbooks/`.

**Goal (usable when done):** The venue gets through an outage; on-call, retention, billing and backups work.

**Done when** (from [milestones](../milestones.md#m8--offline-safety-and-operations)):

- The outage drills pass at West 4: the internet down with the Wi-Fi up, the access point off, the router's LTE off too, and our cloud down. Each shows its banner; queue mode takes orders behind a code; replay lands them as asked to wait with nothing charged twice; anything that fails the checks is on "Review after outage"; and a break-glass tap on each manager's phone lands in Unmatched payments.
- A help alert from Room 9 reaches only the managers' phones, and the board shows "Manager needed" with no room.
- The restore drill brings one venue back from a scratch copy without touching the others, and its counts match Stripe.
- In the load test (20 venues peaking together), the bar alarm still rings within 3 seconds.
- A support grant opens only after the owner approves it, stays read-only and ends at 60 minutes. An emergency action needs our second approver and tells the owner at once.
- The retention job deletes or pseudonymizes what's past its time and logs it. Erasing a guest blanks their details, detaches their saved cards and keeps the opt-out as a hash.
- A license inside its reminder window sends the reminder.
- A failed plan payment on our test venue shows the banner, and 14 days later on a simulated clock Admin is read-only while the board, rooms, bar and payments keep working.
- A second responder is on call, and a page nobody acknowledges in 10 minutes reaches them.

**Depends on:** M7 (Night's review list and Unmatched payments) and M5 (guests to erase); West 4's 10DLC approval. **Size in milestones.md:** 3–4 weeks. The tickets below add up to more; see the size line at the end.

## Suggested order

1. **Outages, in the order a drill needs them:** M8-01 (banners), M8-02 (router), M8-03 (read-only view), M8-04 (queue mode), M8-05 (replay and review), M8-06 (break-glass card), then M8-07 (the four drills at West 4, once the router and both readers are installed there).
2. **Safety and records:** M8-08 (help alert and incidents) and M8-09 (licenses), in parallel with the outage work.
3. **Our staff's tools:** M8-10 (support grants), then M8-11 (emergency actions).
4. **Data jobs:** M8-12 (retention), M8-13 (guest erase), M8-14 (ID-scan keys).
5. **Running the business:** M8-15 (plan billing, which needs our entity and platform account).
6. **Watching production:** M8-16, then M8-17 (alerts and on-call) and M8-18 (synthetic checks); M8-19 (the security baseline) beside them.
7. **Backups and load:** M8-20 (restore and its drill) and M8-21 (load test).
8. **Outside waits:** M8-22 as soon as West 4's 10DLC campaign is approved; M8-23 only once West 4 approves in writing and Playbox has answered. M8-24 closes the milestone and doesn't wait for M8-23.

Definition of done: see CLAUDE.md.

## Tickets

### M8-01 · Show the outage and vendor banners, and the sync footer

- **Status:** done
- **Size:** M
- **Depends on:** M1-09 (event stream and WebSockets), M1-16 (heartbeats), M1-21 (string catalogs), M2-29 (the board), M3-15 (the bar orders screen), M6 (the bar POS)
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Outages; [Scope and architecture](../spec/01-scope-architecture.md) · When the venue's internet drops, When our cloud is down; [Testing and operations](../spec/13-testing-operations.md) · Outage drills; [decisions](../decisions.md) D53; [glossary](../glossary.md#other-exact-sentences) · Outage banners; screens [N29](../screens.md#n29-outage-banners-and-queue-mode), [Board](../screens.md#board) note 14, [Bar](../screens.md#bar) note 7, [Rail](../screens.md#rail) note 17, [Staff](../screens.md#staff) note 17
- **Build:**
  - A connection state in the staff app and the desktop app: online, on backup internet (from the router, M8-02), offline (the line and LTE both down, or our cloud unreachable) and back online with replayed orders waiting (M8-05).
  - One banner for each state on the Board, the bar POS and the bar orders screen: amber "On backup internet · card readers may take up to 2 min to switch"; pink "Offline · read-only · orders queue with an offline code"; "Confirm replayed orders (3)"; "Stripe is having trouble · card payments may fail"; "Texts are delayed". The two vendor banners show on staff phones too. English and Spanish.
  - The Board's footer always shows the connection and the last sync, "Online · synced 4 s ago", and never "works offline".
  - Vendor-health checks, a job in `apps/api`: Stripe's and Twilio's published status feeds plus our own error rates on calls to them, per venue and overall, set a vendor-health state on the venue's channel (a new `vendor.health` event).
  - While "Texts are delayed" shows, Text buttons still work, and a room-ready text that fails still shows "Not delivered · Call".
- **Acceptance:**
  - [x] With the router reporting LTE, the Board, the bar POS and the bar orders screen show the amber banner, and everything else keeps working.
  - [x] With our API unreachable from the bar computer, the pink banner shows there, and the footer keeps the time of the last sync.
  - [x] Pushing our Stripe error rate over its threshold shows "Stripe is having trouble · card payments may fail" on the Board, the bar POS, the bar orders screen and every staff phone, and clearing it hides the banner.
  - [x] Twilio trouble shows "Texts are delayed", and a failed Room ready text to Amara B. still shows "Not delivered · Call".
  - [x] No staff screen says "works offline".
- **Tests:** unit tests for the connection state; Playwright with network faults (the browser offline, the API host blocked, forced vendor error rates); the language test.
- **Notes:** Canvas: no banners, and the footer says "works offline" ([Board](../screens.md#board) note 14). Don't build the boards' "Demo:" controls. Spec gaps: [Scope and architecture](../spec/01-scope-architecture.md) says the vendor-health checks also cover the CDN, but no CDN banner wording exists (cautious default: no staff banner for the CDN until wording is set; guest pages fail as they would offline); `vendor.health` isn't in the event table (add it).
  - **Built (M8-01).** Migration `0106_vendor_health.sql`: `vendor_calls` (our calls to Stripe and Twilio per venue and minute, no audit, like heartbeats) and `vendor_health` (one state per venue and vendor, audited), both behind the venue wall, plus the definer `vendor_call_totals` for the overall rate (counts only, no venue named). `packages/db/src/vendor-health.ts` records, reads and sets them; a change raises `vendor.health` (added to [API](../spec/08-api.md)'s event table). The Stripe client (`call`) and the Twilio venue client (`send`) report each call to `apps/api/src/vendors/outcomes.ts`: no answer, a 5xx or a 429 is a failed call; a decline or a refused number is an answer. The API and the worker count them against the venue(s) behind the account (`resolve_stripe_account`, `resolve_twilio_account`), after the call and outside any transaction. The job `vendors.health` (`apps/api/src/jobs/vendor-health.ts`, every 30 s) reads the status feeds, the venue's rate and the overall rate. `GET /v1/venues/{v}/connection` returns backup internet (the router's heartbeat `on_backup_now`) and both vendors' state. Staff app: `connection-state.ts` (pure, unit-tested) and `connection.tsx` (a poll every 10 s, at once on `vendor.health` and the router's events; the browser's offline event); the shell shows the banners, and the Board's footer reads "Online · synced 4 s ago".
  - **Cautious defaults (settings, platform-wide, from the environment; the spec sets none).** A vendor is in trouble at 20% failed of at least 5 calls in 5 minutes, for the venue or for every venue together (`VENDOR_ERROR_RATE_PERCENT`, `VENDOR_ERROR_MIN_CALLS`, `VENDOR_ERROR_WINDOW_MINUTES`). Status feeds are read only when `STRIPE_STATUS_URL` and `TWILIO_STATUS_URL` are set (a Statuspage-style `status.indicator`; major or critical is trouble, minor isn't, no answer says nothing); both are empty until someone confirms each vendor's feed URL for staging. No CDN check or banner until its wording is set. Offline, the vendor banners hide (their state is unknown) and only the pink banner shows.
  - **Words the spec doesn't give.** The footer's other states: "On backup internet · synced 4 s ago", "Offline · synced 3 min ago", "Offline · not synced yet" and "Connecting…" before the first answer; ages read "N s ago", "N min ago", "N h ago". Spanish for every banner and footer string.
  - **Where they show.** The amber, pink and "Confirm replayed orders (N)" banners on the Board (`/tonight`), the bar POS (`/bar`) and the bar orders screen (`/bar-orders`); other screens keep "Offline · reconnecting" when the connection drops. The two vendor banners on every staff screen, phones included. Offline means the browser has no network or our API didn't answer a poll (no answer, 502, 503 or 504).
  - **For later tickets.** M8-02 makes the router's heartbeat report LTE (`network.on_backup_now`; the tests set it directly) and raises `venue.backup_internet`. M8-05 adds `replayed_waiting` to the connection answer; the banner and its count are built and tested in the unit tests. Queue mode and "queued · not charged" are M8-03/M8-04.


### M8-02 · Report the router as a device: on the line or on LTE

- **Status:** done
- **Size:** M
- **Depends on:** M1-15 (devices and pairing), M1-16 (heartbeats), M1-34 (Admin → Printers & devices), M1-35 (the Console's device health)
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Router, Supported hardware, Heartbeats; [Scope and architecture](../spec/01-scope-architecture.md) · When the venue's internet drops; [API](../spec/08-api.md) · Live events (`venue.backup_internet`); [milestones](../milestones.md#admin-by-milestone) · Admin by milestone (Printers & devices: the router); screens [AdminDesk](../screens.md#admindesk) note 9, [Console](../screens.md#console) note 1
- **Build:**
  - A `devices` row of kind `router`, paired like any device. An adapter for the router maker's documented cloud API reads whether the router runs on the wired line or on LTE, and whether the LTE backup is ready. Pick a dual-WAN LTE router with such an API, on a different carrier from the readers.
  - For a router without an API, the server infers LTE from the carrier behind the bar computer's public IP (the desktop app reports it; an IP-to-network-owner lookup tells the wired provider from the LTE carrier).
  - `venue.backup_internet` events. Admin → Printers & devices and the Console show "Backup internet · on" while the backup is ready, from the same device rows; the Board's amber banner (M8-01) shows only while the venue is running on it.
  - The monthly failover test: a reminder to the manager when it's due, and its result (passed or failed, and how long the switch took) recorded on the router's device page.
- **Acceptance:**
  - [x] At 10:41 PM on the seed, Admin → Printers & devices and the Console both read "Backup internet · on", and the Board shows no banner.
  - [x] Unplugging the router's wired line puts the venue on LTE; the Board, the bar POS and the bar orders screen show the amber banner, and plugging it back clears it.
  - [x] With the maker's API switched off, the fallback still sees LTE from the bar computer's public IP.
  - [x] The monthly failover test reminds the manager when it's due and keeps its result.
- **Tests:** adapter contract tests against recorded API responses; unit tests for the fallback with network-owner fixtures; the venue-wall suite over router events; the live check happens in M8-07.
- **Notes:** Use only the router maker's documented API, never an undocumented one. Spec gap: how often to poll the router isn't said; cautious default: on the 30-second heartbeat.
  - **Built (M8-02).** Migration `0107_router.sql`: `router_links` (per router: the maker, its org and device ids, `api_on`, and the wired provider's and LTE carrier's network names for the fallback; ids only, the credentials come from the environment) and `router_failover_tests` (tested at, `tested_on` business date, passed, seconds to switch, who kept it), both behind the venue wall and audited. `packages/db/src/router.ts` reads routers, sets the link, writes a reading as the router's heartbeat (`network.cellular_backup`, `on_backup_now`, `source`; never audited) and raises `venue.backup_internet` on a change (`device.online` when it was flagged offline), keeps failover results. The adapter `apps/api/src/router/peplink.ts` (Peplink InControl 2: client-credentials token, then `GET /rest/o/{org}/d/{device}`; a wired WAN up means the line, only a cellular one up means LTE; a cellular WAN not disabled, with a SIM, under quota and not switched off means the backup is ready). The fallback `apps/api/src/router/ip-owner.ts`: the bar computer's heartbeat now stores the public IP it came from (`network.public_ip`; behind `TRUSTED_PROXY_HOPS` proxies, from X-Forwarded-For), the owner is read over RDAP (an hour's cache, never for a private address, not at all until a network name is set) and matched against the two names; a match on neither or both changes nothing. The sweep `routers.watch` (`apps/api/src/jobs/router-watch.ts`) reads each router during opening hours, outside any transaction; no answer is no heartbeat, so an unreadable router shows offline after two minutes. Routes `GET /routers`, `PUT /routers/{d}/link`, `POST /routers/{d}/failover-tests` (added to [API](../spec/08-api.md)). Admin → Printers & devices has a Router section: backup internet, on the line or on LTE now, how it's read, the failover test (due, next date, results, a form to keep one) and the link form, in English and Spanish. The Console and the M8-01 banners read the same heartbeat, unchanged.
  - **Decisions and cautious defaults** ([D90](../decisions.md)). Polled on the 30-second heartbeat, during opening hours. Peplink is the first supported maker because InControl 2's API is published; the exact model and the carrier (not the readers') are the founder's purchase. The failover test is due a calendar month after the last one (at once if never run), with one push to the managers' phones when it falls due (`router.push.failoverDue`), and "Failover test due" in Admin until a result is kept. The network names are venue facts nobody has given us, so they start empty with a hint. New env: `PEPLINK_CLIENT_ID`, `PEPLINK_CLIENT_SECRET`, `PEPLINK_API_URL`, `IP_OWNER_LOOKUP_URL`, `TRUSTED_PROXY_HOPS` (`.env.example`). The failover date is `tested_on`, not `business_date`, because it isn't money and needs no closed-night guard.
  - **What's simulated.** Acceptance 2 is tested with the maker's answer faked (the e2e banner test now drives the router sweep instead of writing the heartbeat); the adapter's fixtures are shaped from InControl 2's documented schema, not recorded. **M8-07 must** pull real answers from the venue's router (on the line, unplugged, no SIM) into `apps/api/src/router/fixtures/`, set `TRUSTED_PROXY_HOPS=1` behind staging's load balancer, set the Peplink credentials, and do the live unplug. The seed's router has no link, so the demo reads it as the seed says ("Backup internet · on") and the failover test shows due.


### M8-03 · Keep a read-only offline view in the desktop app

- **Status:** done
- **Size:** M
- **Depends on:** M1-28 (the desktop app's encrypted SQLite cache and keychain token), M2-29 (the board), M3-03 (the menu and 86), M3-16 (ringing orders on the locked device's channel), M6 (open tabs)
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Offline and queue mode, Outages; [Scope and architecture](../spec/01-scope-architecture.md) · When the venue's internet drops (3); [Security and data retention](../spec/12-security-retention.md) 6 and 10, How long we keep things (desktop cache: the current business date); screens [N29](../screens.md#n29-outage-banners-and-queue-mode)
- **Build:**
  - `apps/desktop` keeps the current business date's board (room tiles, states and totals as of the last sync), open tabs (bar and room, with lines and totals), the menu with 86'd items, and ringing and asked-to-wait orders in its encrypted cache, kept up to date from the event stream. The cache is wiped at the business-date turn.
  - Under the pink banner, the board, open tabs and the menu are read-only: every write control is disabled, with the reason in words, and totals say they're as of the last sync.
  - The orders the bar already has keep ringing and aging, without a PIN, while the screen is locked.
  - Nothing is written locally except queue mode (M8-04).
- **Acceptance:**
  - [x] With our API blocked at 10:41 PM, the bar computer shows 8 rooms in use, 3 open, 2 cleaning and 1 out of service, the 5 bar tabs with their totals (Jess P. $32.66, Luis M. $63.15), and the menu with Hoegaarden 86'd, all read-only under the pink banner.
  - [x] o1 (Room 9, ringing 0:43) and o2 (Room 5, ringing 2:11) keep aging and chiming with the screen locked.
  - [x] The cache file can't be read without the keychain token, and Fri Sep 25's cache is gone after 6:00 AM Sat Sep 26.
- **Tests:** Electron integration tests with Playwright; an encryption test that opens the cache file raw; a retention test on the simulated clock.
- **Notes:** Spec gap: an order ringing when the venue went offline can't be accepted offline, since Accept is a write. Cautious default: it keeps ringing and the bar may make it; the bartender accepts it once online. If the 4:00 AM stop canceled it meanwhile, it lands on Review after outage (M8-05). Room tablets are online only, so they get nothing offline.
  - **Built (M8-03).** `packages/shared/src/offline-view.ts` is the one list of reads the offline view keeps (the board, sessions, bookings, open tabs, each open check, the menu, the bar's orders, and what the bar POS needs to draw itself); nothing off the list is ever cached. The desktop app keeps them in its SQLCipher cache (`apps/desktop/src/offline.ts`, IPC `west4:offline:save` and `west4:offline:read`, each sender-checked), stamped with the venue time of the sync, for the current business date only: a read past 6:00 AM wipes the day before first, and the minute wipe now runs on the venue's clock instead of the computer's. In the staff app, `api()` and the device-signed `signedApi()` hand every listed GET's answer to the cache, and when our API doesn't answer (no network, or a gateway's 502, 503 or 504) give back the kept one; a refusal is never covered up, and writes never touch the cache. `OfflineSync` (in the shell, desktop only) refreshes the list on every event and once a minute, plus each open tab's and room's check so their lines can be seen offline.
  - **Read-only.** Under the pink banner the Board, the bar POS and the bar orders screen disable every button and field, each with the title "Offline · read-only: this needs the connection", and show "Read-only while offline · changes wait for the connection · totals as of the last sync, 10:41 PM" (the oldest kept answer on screen). Controls that only change what's shown stay live (`data-view`): picking a tab or room to see its lines, the menu sections and search, the filters, Mute and Wipe. The shell's Lock stays live too.
  - **Locked screen.** The waiting-orders notice on a locked bar or front-desk screen now lists each order with its age ("Room 9 · Ringing · 0:43"), ticking on the venue's clock, from the cache when offline; the chime loop reads the same cache, so it keeps chiming once a minute for orders past 2 minutes.
  - **Words the spec doesn't give.** The read-only note and the disabled controls' reason, in English and Spanish.
  - **Not built here.** Queue mode and offline codes (M8-04), replay (M8-05). If the desktop app is restarted while offline, the venue's clock falls back to the computer's own until the next sign-in; the staff app's own files must still load (the service worker's job), which this ticket doesn't change.
  - **Tests.** `packages/shared/src/offline-view.test.ts` (the list), `apps/desktop/src/offline.test.ts` (keeps only listed reads; the file can't be read raw or with another key; Fri Sep 25 kept through 5:59 AM and gone at 6:00 AM Sat Sep 26 on the simulated clock), `apps/staff/src/offline.test.ts` (the fallback, and no fallback for refusals, writes or other reads), and an Electron Playwright test in `e2e/desktop.spec.ts` that blocks `/v1/` at 10:41 PM and checks the board's counts, the five tabs (Jess P. $32.66, Luis M. $63.15), Hoegaarden 86'd, disabled writes, the locked screen's aging orders, a chime, and the cache file on disk.
  - **Unrelated failure.** In the full e2e run, the staff test "Close the night: the checks, the clear-out at 4:31 AM and Night closed · 4:48 AM" fails ("Night closed · 4:48 AM" never shows); it fails the same way on the commit before this ticket, so it isn't from M8-03.

### M8-04 · Take orders in queue mode behind an offline code

- **Status:** done
- **Size:** L
- **Depends on:** M8-03; M1-15 (device keys), M1-28 (the keychain); M6 (bar POS rounds, `order_drafts`)
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Offline and queue mode; [Scope and architecture](../spec/01-scope-architecture.md) · When the venue's internet drops; [Tenancy and access](../spec/02-tenancy-access.md) · PINs (no device caches PIN hashes); [milestones](../milestones.md#must-fix-items-and-where-they-close) GA-M8, GA-M11 (no new tabs offline); screens [N29](../screens.md#n29-outage-banners-and-queue-mode), [Rail](../screens.md#rail) note 17
- **Build:**
  - Offline codes, checked by the desktop app itself: a time-based code from a per-device secret set up while online and kept in the operating system's keychain, or one-time codes printed in advance, valid only for that device and business date. A manager reads the code from their phone, which caches each paired device's upcoming codes while online (managers' phones only), or from a sealed card.
  - A code opens queue mode until the connection returns or 4 hours pass.
  - In queue mode the bar POS queues rounds on open tabs from the cache. Each queued order records a staff name, picked from the cached team (no PIN offline, since no device caches PIN hashes), and a device-made `order_id`, and each round shows "queued · not charged".
  - Voids, refunds, the drawer and New tab stay locked, with the reason in words. The cached alcohol window and cut-offs grey out alcohol as they do online; the server checks again on replay.
  - Queued orders survive a restart or a watchdog relaunch in the encrypted cache.
  - Staff phones on cellular keep working online and don't see the bar computer's queue until it replays.
- **Acceptance:**
  - [x] With our API blocked, Andy reads the bar computer's code from the codes his phone cached, and Maya queues 1 × Jäger Bomb on Luis M.'s tab, which shows "queued · not charged" with her name.
  - [x] A wrong or expired code, or a printed code for the front-desk computer or another business date, doesn't open queue mode.
  - [x] Queue mode ends by itself after 4 hours.
  - [x] Void, refund, no-sale and New tab are locked and say why.
  - [x] Killing the desktop app mid-outage loses no queued order.
  - [x] Past 4:00 AM on the simulated clock, queue mode greys out alcohol as online does.
- **Tests:** unit tests for the time-based codes (clock skew windows, device and date scope) and the printed codes; Electron integration tests; a kill-and-restart test.
- **Notes:** Spec gaps: the drawer stays locked in queue mode, yet the break-glass card says to take cash when Stripe is down too; how offline cash is recorded isn't said. Cautious default: a queued round can carry "cash taken offline · amount · by whom" as a note, which lands on Review after outage for a manager to post as a cash payment once online (M8-05); the drawer never kicks offline. Only the bar POS queues; the Board stays read-only.
  - **Built (M8-04).** The code rules are in `packages/rules/src/offline-codes.ts` (pure; the HMAC-SHA256 is handed in). A time-based code is 6 digits, one per 5-minute step, bound to the computer and the business date the step starts in; the computer accepts one step either side (clock drift offline). Printed codes are 10 one-time 8-digit codes per computer per business date. Queue mode lasts until our API answers again or 4 hours (`queueModeEndsAt`).
  - **Server.** Migration 0108 `device_offline_secrets` (row-level security forced, not audited so the audit log never copies the sealed secret; the seed wipes it). `POST /devices/offline-secret` (the bar or front-desk computer, signed as the device alone): the computer sends the fingerprint of the secret it holds; a match changes nothing, otherwise a new 256-bit secret is made, sealed with AUTH_SECRET_KEY and handed back once. `GET /offline-codes` (owners and managers on a passkey or authenticator session): each computer's next 12 hours of codes. `GET /devices/{d}/offline-codes/printed?date=` : the printed card for one computer and date. The codes are only ever checked on the computer.
  - **Desktop app.** `apps/desktop/src/queue.ts`: the secret sealed by the keychain (`offline.secret`), never returned to the page; IPC `west4:queue:*` (sender-checked) to check a code, read the state, end it, add and list rounds. Queue mode and used printed codes live in the encrypted cache's meta; queued rounds are cache rows of kind `queued`, kept through the 6:00 AM wipe until M8-05 replays them. The venue clock's offset is kept in the cache, so a restart mid-outage keeps the same clock. Found while testing the kill: after a hard kill, the relaunched window's first load stalls on the service worker the killed app left; the window now asks for the page again every 10 s (up to 3 times) until it loads.
  - **Staff app.** `QueueProvider` (desktop only) sets up the secret while online, polls the state, and ends queue mode on the first answer from our API. On the bar POS under the pink banner: the "Offline code" form; once open, a band "Queue mode · until 6:41 AM · rounds are queued, not charged", and on a picked open tab "Queue a round on Luis M.": drinks tapped on the grid, "Who's ringing it" from the kept team tiles (names only, no PIN), an optional "Cash taken offline" note, "Queue round"; each round then reads "1 × Jäger Bomb · queued · not charged · Maya S.". Everything else stays locked with the title "Queue mode: voids, refunds, the drawer and New tab wait for the connection"; New tab also says "No new tabs while the bar computer is offline." The alcohol window is now moved on by the clock from the menu's `changes_at` (`alcoholStateAt`), so alcohol greys out at 4:00 AM offline exactly as online. `/team/tiles` joined the offline read list.
  - **Managers' phones.** A new phone tab "Offline codes" (owners and managers only) shows each computer's code now and when it changes, from codes kept in the phone's storage (refreshed every 30 minutes in the background and on opening), and prints tonight's one-time codes for the sealed card.
  - **Cautious defaults (settings-free constants, the spec gives no numbers):** the 5-minute step and one-step skew, 12 hours of codes kept on a phone, 10 printed codes per night. The ticket's cash default is built as the round's `cash_note` (M8-05 shows it on Review after outage); the drawer never kicks offline. Rooms can't take queued rounds; only the bar POS queues. Staff phones on cellular stay online and never see the computer's queue (it is local to the computer).
  - **Words the spec doesn't give,** in English and Spanish: the code form, the queue band and note, the round panel and the Offline codes screen.
  - **Tests.** `packages/rules/src/offline-codes.test.ts` (steps, skew windows, device, date and secret scope, printed codes once each, 4 hours, the 4:00 AM flip), `apps/desktop/src/queue.test.ts` (sealed secret, open and expire, wrong/old/other-device/other-date codes, kill and reopen, the cutover keeps rounds), `apps/api/src/routes/offline-codes.int.test.ts`, the phone's kept codes (`apps/staff/src/offline-codes.test.ts`), the phone tab, and Playwright: the staff test "Offline codes: Andy's phone …" (codes kept and shown with our API down) and two Electron tests (wrong code refused, the code opens queue mode, Maya queues 1 × Jäger Bomb on Luis M., New tab and Fix locked with the reason, kill and relaunch keeps the round; and at 3:58:45 AM the kept menu greys alcohol out at 4:00 AM). The Electron test reads the bar computer's code from the server's copy of its secret through the same rule as `GET /offline-codes`, since Andy's passkey phone can't sign in inside Electron; the staff test shows the phone side. No-sale lives on the desk's drawer panel and is locked by the same rule as Fix (every non-queue control on the outage screens); it isn't clicked in a test.
  - **Full-run noise.** In the full `pnpm check --e2e` run, three integration files (send-email, night-run, site) hit 60 s hook timeouts and twelve smoke tests failed while stale dev servers from an interrupted run were still up; each passed when re-run alone, and `pnpm check` then passed whole. One real ordering problem was fixed: the 4:00 AM desktop test now sets the clock back to 10:41 PM, which the API smoke test expects.
  - **Regression fixed first (commit 308470d).** The close-the-night smoke test failed because the seed didn't wipe the night's export (M7-15), not because of M8-01/02.

### M8-05 · Replay queued orders as asked to wait, and list Review after outage

- **Status:** done
- **Size:** M
- **Depends on:** M8-04; M7-12 (Night); M7-14 (Unmatched payments); M3-06 (the order pipeline and `held`)
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Replay, Review after outage; [Testing and operations](../spec/13-testing-operations.md) · Tests (offline replay tests); [Data model](../spec/04-data-model.md) · `orders` (source `offline`, `client_order_id`); [API](../spec/08-api.md) · Conventions (Idempotency); screens [N29](../screens.md#n29-outage-banners-and-queue-mode), [Night](../screens.md#night) note 8
- **Build:**
  - On reconnect the desktop app uploads each queued order once, keyed by its `order_id` (`client_order_id`, kept 7 days like idempotency keys). The server checks each again: the session or tab is still open, its check isn't finalized or paid, the alcohol window is open and the business date matches.
  - A passing order lands as `held` with source `offline`, listed under "Confirm replayed orders (3)" on the bar POS and the bar orders screen until a bartender accepts it against its tab. Accept is the sale.
  - A failing order goes to "Review after outage" on Close the night for a manager: every order taken offline and its payment, failed replays first with the reason, offline cash notes to post, and any break-glass card payments still waiting in Unmatched payments.
  - Posting offline cash: a manager records it as a cash payment on its check, into the drawer at their screen, with the PIN again.
- **Acceptance:**
  - [x] Three orders queued in the outage show "Confirm replayed orders (3)" after reconnect, each asked to wait and off the tab until accepted.
  - [x] A round rung online on Diego's phone during the outage and also queued at the bar is charged once: the bartender accepts one and cancels the replayed copy.
  - [x] A queued order for Room 9 whose check was paid in the meantime lands on Review after outage, never on the paid check.
  - [x] An order queued on Fri Sep 25 and replayed after 6:00 AM Sat goes to Review after outage.
  - [x] Uploading the same queue twice lands each order once.
- **Tests:** the offline replay tests (never onto a paid check or an earlier night; failures on the review list); idempotency tests; Playwright for "Confirm replayed orders" and Review after outage.
- **Notes:** Canvas: Night has nothing for outages ([Night](../screens.md#night) note 8).
  - **Built (M8-05).** Migration 0109 `offline_replays` (row-level security forced, audited, wiped by the seed): one row per device-made order id, the round as queued (tab, who rang it, lines, total in cents, cash note), the outcome (`held` or `failed` with a reason), the held order, and any posted cash. Its dates are `queued_on` and `replayed_on`, not `business_date`, so the closed-night guard doesn't apply: a round from a closed night must still reach the review list.
  - **Server.** `apps/api/src/orders/replay.ts` checks each round again as if rung now: the night it was queued (from `queued_at`) is tonight (else `earlier_night`); the check exists (`no_check`), isn't paid or partly paid (`check_paid`) or otherwise closed/finalized or ordering-locked (`check_closed`); the tab is open or the room session not ended (`tab_closed`); every drink is on the menu and not 86'd (`not_on_menu`, `out_tonight`, priced from the menu now, as any order); the alcohol window and cut-offs (`alcohol_closed`, `cut_off`, logged as refusals like any order). A pass inserts the order (source `offline`, placed by the member who queued it, placed at the queued time) straight to `held`; Accept is then the sale through the usual pipeline. Routes in `apps/api/src/routes/offline-orders.ts`: `POST /offline-orders/replay` (the bar or front-desk computer, signed as itself; the order id answers the same every time, a racing duplicate is caught on the unique key), `GET /offline-orders?business_date=` (managers: rounds queued or replayed that night, failed first, with the order's and check's state now and posted cash, plus the break-glass card payments still unmatched, and `pin_again`), `POST /offline-orders/{replayId}/cash` (managers, `payments.take`, Idempotency-Key required: the cash payment on the round's check through `takeCash`, so into the drawer at their screen, PIN again in a PIN or badge session; refused when already posted, the check is paid or void, or the amount is over what it owes). `GET /connection` now answers `replayed_waiting`. Order rows carry `tab_name` and `queued_by`.
  - **Desktop app.** `QueueMode.settle(ids)` and IPC `west4:queue:settle` drop only the rounds the server answered; the staff app's `QueueProvider` uploads the queue (in batches of 100, signed as the device) as soon as our API answers again, and retries on the next poll if an upload fails.
  - **Staff app.** `ReplayedOrders` lists "Confirm replayed orders (N)" on the bar POS (when not offline) and the bar orders screen, each "Luis M. · 1 × Jäger Bomb · $12.00 / Asked to wait · queued by Maya S. at 10:20", with "Accept · print ticket" and "Cancel copy"; replayed rounds are left out of the room-order strip and the Waiting column so they show once. The banner count refetches on `order.held|accepted|cancelled`. Close the night gets "Review after outage" (`ReviewAfterOutage`): every round, failed first with its reason in words, its order's state, whether its check is paid, the offline cash note with a "Post cash" form (amount, and the PIN when asked), and the count of break-glass payments waiting in Unmatched payments.
  - **Cautious defaults.** Offline cash is posted only on a check that still owes at least that much; cash on a round whose check was paid stays on the list for the manager to handle by hand (the spec doesn't say where it goes). The replay records are kept like the rest of the night's records, not purged after 7 days, since they are the outage's audit trail; an order id still lands once while its record exists. A queued round's price is taken from the menu at replay, as any order is priced when placed.
  - **Words the spec doesn't give,** in English and Spanish: the replay list's hint, line and "Cancel copy", and every Review after outage string and reason.
  - **Tests.** `apps/api/src/routes/offline-orders.int.test.ts` (three held and off the tab with `replayed_waiting: 3`; same queue twice lands once; Diego's online round plus the replayed copy charged once; Accept is the sale; Room 9 paid → `check_paid`, nothing on the check; queued Fri, replayed 6:05 AM Sat → `earlier_night`; review list failed first and managers only; cash posted once; a person can't replay), `apps/desktop/src/queue.test.ts` (settle), the principal and wall suites (new routes), Playwright staff "Confirm replayed orders (3) on the bar POS and bar orders, and Review after outage on Close the night" and desktop "replay: three rounds queued in the outage …" (queue three offline, reconnect, banner (3), queue empty, held and off the tab, Accept adds the line). Checks: lint, i18n, typecheck, unit and the migration linter pass; in the full `pnpm check` four integration files (night-report, room-care, twilio-hooks, bar-mode-settings) hit 60 s hook timeouts while the dev servers were also running, and pass alone. Playwright: the 30 staff tests on the bar POS, bar orders, banners and Close the night, and all 8 desktop tests, pass; the full staff suite wasn't rerun.

### M8-06 · Print the break-glass card

- **Status:** done
- **Size:** S
- **Depends on:** M7-14 (Unmatched payments); M4-29 (the go-live checklist of managers' Stripe Dashboard logins and Tap to Pay phones); M3-05 (the PDF job)
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Break-glass card; [Stripe setup](../spec/06-stripe-setup.md) 11; [Scope and architecture](../spec/01-scope-architecture.md) · When our cloud is down; [decisions](../decisions.md) D54; screens [N29](../screens.md#n29-outage-banners-and-queue-mode)
- **Build:**
  - A one-page card for each venue from the PDF job, printed from Close the night ("Print break-glass card") to keep at each desk, in English and Spanish.
  - What it says: when our cloud is down, take cards with Tap to Pay in Stripe's Dashboard app on a manager's phone signed in to West 4's Stripe account; note the room or tab and the time of each payment; if Stripe is down too, take cash; afterwards, match the payments in Unmatched payments and work through Review after outage.
  - Which managers are ready: each with a Dashboard login and a supported phone, from the go-live checklist.
- **Acceptance:**
  - [x] Night prints the card, and it names Andy and Abhishek as ready for Tap to Pay.
  - [x] It says to take cash if Stripe is down too.
  - [x] A Tap to Pay payment taken by following it lands in Unmatched payments. (Simulated: M7-14's test of a Dashboard Tap to Pay payment with no row of ours, `apps/api/src/routes/payouts.int.test.ts`; the live one on a manager's phone is M8-07's drill.)
- **Tests:** a golden PDF test; the drill in M8-07.
- **Notes:** Spec gap: West 4's desks have only receipt printers; cautious default: a letter-size PDF to print ahead of time, plus a short version for the receipt printer.
  - **Built (M8-06).** `apps/api/src/payments/break-glass.ts`: the card's facts (the venue, who's ready for Tap to Pay: an owner or manager with both go-live checks confirmed, M4-29's `setup_checks`; who isn't yet), the letter-size HTML (one page in English, then one in Spanish: when our cloud is down, Tap to Pay in Stripe's Dashboard app on a manager's phone signed in to the venue's Stripe account, note the room or tab, amount and time; if Stripe is down too, take cash; afterwards Unmatched payments then Review after outage; who's ready; a blank log of payments taken; when it was printed) and the short version wrapped to the receipt printer's 32 columns. Routes `GET /break-glass-card`, `GET /break-glass-card/pdf` (`{ pdf, filename }`, printed by the menu PDF job's Chromium renderer, tagged, outside any transaction) and `POST /break-glass-card/print` (print job `break_glass` on the front-desk printer, laid out like a receipt; migration `0110_break_glass_print.sql`), owners and managers only (added to [API](../spec/08-api.md)). Close the night has a Break-glass card panel: who's ready (or "No manager is ready for Tap to Pay yet" pointing at Admin → Payments), "Print break-glass card" (saves `break-glass-card.pdf`) and "Print the short version on the receipt printer"; loading and error states; English and Spanish (`breakGlass.*`). Tests: `break-glass.test.ts` (unit), `routes/break-glass.int.test.ts` (the golden PDF test: the real PDF read back with pdf.js against `payments/fixtures/break-glass-card.golden.txt`, words only so fonts can't move it; `UPDATE_GOLDEN=1` rewrites it), and the e2e "Close the night: the break-glass card…".
  - **Cautious defaults.** The ticket's: a letter-size PDF to print ahead of time plus a short receipt version. Both languages print together (English page, Spanish page; English then Spanish on the receipt), so every desk's copy serves every staff member. The card is generated on demand, so it always names who's ready now; it isn't stored. Ligatures are off in the PDF so its text reads back exactly. No phone numbers or other venue facts are printed; none were given.
  - **Checks.** `pnpm check --e2e`: everything passed except, in the full run only, `chaos.int.test.ts` (a 60 s hook timeout while the e2e servers ran) and three e2e tests (desktop replay of three rounds, the bar POS void in 4 taps under 6 s, the M2 phone scenario with Room 7 to cleaning); each passes run alone, and none touches this ticket's code.
  - **For M8-07.** Print the card for the drill and follow it on each manager's phone; record whether the payments land in Unmatched payments.

### M8-07 · Run the four outage drills at West 4

- **Status:** blocked
- **Size:** M
- **Depends on:** M8-01 to M8-06; the router and both S710s installed at West 4, ahead of the full install
- **Spec:** [Testing and operations](../spec/13-testing-operations.md) · Tests (Outage drills); [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Outages; [Scope and architecture](../spec/01-scope-architecture.md) · When the venue's internet drops, When our cloud is down; [Open technical questions](../spec/14-open-questions.md); [milestones](../milestones.md#the-go-live-gate) · the go-live gate, item 4
- **Build:** `docs/runbooks/outage-drill.md` and a drill report for each run, during closed hours. Queued orders go on practice checks (the bar computer in device training), while every card payment is a small live one, on the real readers from a live staff phone or by Tap to Pay, refunded after matching:
  1. **The internet down with the Wi-Fi up:** unplug the line with the router's LTE on. Expect the amber banner, and record whether each reader keeps taking cards and whether it moves to cellular while the Wi-Fi has no internet.
  2. **The access point off:** expect both readers to move to cellular and keep taking cards, room tablets to go offline and alert the manager, and screens on the Wi-Fi to show their banner.
  3. **The router's LTE off too:** expect the pink banner on the bar computer, queue mode behind a code, taps on the readers driven from a staff phone on cellular, and replay as asked to wait after reconnect.
  4. **Our cloud down:** block our API's hostnames at the router and on the staff phones while Stripe stays reachable. Expect the pink banner and queue mode, a break-glass Tap to Pay on each manager's phone, and afterwards every one in Unmatched payments, matched, and every offline order on Confirm replayed orders or Review after outage.
- **Acceptance:**
  - [ ] Each drill shows its banner: amber, the banners of the devices that lost Wi-Fi, pink, pink. *(not yet: on site: needs the router and both S710s at West 4; the banners themselves pass the smoke tests (M8-01))*
  - [ ] Queue mode takes orders behind a code, and replay lands them as asked to wait, with nothing charged twice. *(not yet: on site; rehearsed locally in `outage-drill.int.test.ts` (the same queue twice lands once) and the M8-04/M8-05 smoke tests)*
  - [ ] Anything that fails the checks is on Review after outage. *(not yet: on site; rehearsed locally (a round for a paid check lands on Review after outage))*
  - [ ] A break-glass tap on Andy's phone and one on Abhishek's land in Unmatched payments and are matched. *(not yet: on site: needs real Tap to Pay on both managers' phones on West 4's live Stripe account; rehearsed locally with recorded taps)*
  - [ ] The report records what the readers did in drill 1, which answers the open Stripe question. *(not yet: on site: only the real readers can answer it)*
- **Tests:** the drills themselves, timed, with screenshots kept in the report.
- **Notes:** Open question (Stripe): does a reader switch to cellular when the Wi-Fi stays up but the internet behind it is down? Drill 1 answers it; record the answer for the founder to close in [Open technical questions](../spec/14-open-questions.md). The router's own failover is also tested monthly (M8-02). Pull the router and reader part of M9-07's install forward for these drills.
  - **Built (M8-07, locally).** The runbook `docs/runbooks/outage-drill.md`: what must be ready first, the four drills step by step with what to expect and what to record, and the afterwards (refunds, Stripe check, the report). The report script `pnpm --filter @west4/api outage:record -- --date <date>` (`apps/api/src/ops/outage-record.ts`, the evidence in `apps/api/src/ops/outage-drill.ts`, read-only as the table owner): a table per drill for people to fill in (times, banners, each reader's behaviour, screenshots, the open Stripe question), then what the system recorded that night (connection events from `venue_events`: backup internet, venue and device offline/online, vendor health, replay failures, unmatched payments; the offline queue and how replay landed it; the break-glass payments with the check each was matched to). Findings, which make it exit non-zero: an offline order that landed more than once, one still waiting on Confirm replayed orders, offline cash not posted, a break-glass payment still unmatched. `docs/drills/README.md` says where reports go (`docs/drills/<date>-outage.md`, screenshots beside it). The local rehearsal `apps/api/src/ops/outage-drill.int.test.ts` runs the drills' software side on the demo seed: the simulated router onto LTE and back, a queue replayed twice (lands once), a round for a paid check on Review after outage, two break-glass taps in Unmatched payments, then accept/cancel and match, and the report has no findings. Screens are already covered by the M8-01 to M8-06 smoke tests; no screen changed.
  - **Cautious defaults.** Break-glass payments are found as external payments on the night's business date (or adjusting it); the report can't tell whose phone took each, so it leaves a column to fill in. Drill 4 blocks our hostnames with the router's own domain block list and keeps staff phones on the venue Wi-Fi with cellular data off, since the spec doesn't say how to block them.
  - **Left for on site (the founder and Andy, closed hours, about two hours).** (1) Install the router and both S710s at West 4 (M9-07's router and reader part, pulled forward), with cellular on in West 4's Terminal Configuration. (2) Finish the runbook's "Before you start": the router's monthly failover test passed, both managers ready for Tap to Pay on the go-live checklist, the offline codes cached on both phones, the break-glass card printed, the bar computer in device training. (3) Run the four drills as `docs/runbooks/outage-drill.md` says, with screenshots. (4) Refund every live drill payment, run `outage:record` until it has no findings, commit the report and screenshots, then tick the Acceptance lines and set this ticket done. (5) Drill 1's answer closes the Stripe question in [Open technical questions](../spec/14-open-questions.md): the founder records it there.


### M8-08 · Send the private help alert and keep the incident log

- **Status:** done
- **Size:** M
- **Depends on:** M3-09 (the room page), M1-22 (staff phones with push), M2-28 (Admin → Safety)
- **Spec:** [API](../spec/08-api.md) · Guest room (`/help`), Safety (incidents), Live events (`incident.opened`, `incident.updated`); [Data model](../spec/04-data-model.md) · `incidents`, `incident_notes`; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Safety; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · The board and staff phones (Help alert); [Security and data retention](../spec/12-security-retention.md) · How long we keep things (incidents 3 years); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · What each module hides (Safety & ID records); [decisions](../decisions.md) D58; screens [N20](../screens.md#n20-help-alert-manager-needed-pin-and-incident-log), [N36](../screens.md#n36-admin--safety), [Board](../screens.md#board) note 10, [Staff](../screens.md#staff) notes 10 and 19
- **Build:**
  - The discreet "Need a manager, privately?" link on the room page on guests' own phones only, never on a room tablet or any room screen. `POST /v1/public/room-session/help` opens an incident (the room, session, guest and `reported_via`).
  - Managers' and owners' phones only: a push, and the incident with its room, time and kind; [I'm on it] (`POST /incidents/{i}/ack`); notes that go to the incident log and are never edited (`/notes`); close (`/close`). `incident.opened` and `incident.updated` go to managers' and owners' channels only.
  - The Board's channel gets only how many are open, for a "Manager needed" pin with a count and no room and no reason.
  - The incident log on managers' and owners' phones, kept 3 years (`keep_until`), and `POST /incidents` for a manager to log one by hand (see Notes).
  - Admin → Safety gains the help alert (who gets it: every manager and owner) and the incident log.
  - With Safety & ID records off, the help link, the pin and the log hide, and their routes answer `404 module_off`.
- **Acceptance:**
  - [x] A guest in Room 9 taps "Need a manager, privately?": Andy's and Abhishek's phones get Room 9, the time and the kind; Maya's and Diego's phones get nothing; Room 9's tablet shows nothing.
  - [x] The Board shows "Manager needed · 1" with no room and no reason; Andy taps [I'm on it] and adds a note; closing it clears the pin.
  - [x] A bartender's or front-desk session can't read any incident.
  - [x] A closed incident is kept for 3 years.
- **Tests:** the principal and venue-wall suites over the incident routes and events, including a check that the Board's channel never carries a room or reason; Playwright at phone and desktop sizes; the language test.
- **Notes:** Spec gaps: `incidents` has `reported_by` and `reported_via`, but the API lists no route to log an incident by hand (build `POST /incidents` for managers and owners, and add it to the API's table); the guest's confirmation after tapping the link has no wording; [N36](../screens.md#n36-admin--safety)'s "help alert and incident log settings" aren't settings keys (cautious default: no new keys; the module switch turns it on or off).
  - **Built (M8-08):** migration `0111_incidents.sql` (`incidents`, `incident_notes`; row-level security forced; the app can insert and read, update only the status columns, never delete; notes are insert-only). `apps/api/src/rooms/incidents.ts` and `routes/incidents.ts`: `POST /v1/public/room-session/help` (guest phones only; a room tablet is refused), `GET`/`POST /incidents`, `/ack`, `/notes`, `/close`, all behind Safety & ID records (the token route checks the module itself, since it has no venue in its path). Pushes go to every manager's and owner's phone ("Manager needed · Room 9 · 10:41 PM · A guest feels unsafe"). `GET /board` gains `manager_needed` (a count, null with Safety off); `GET /room-session` gains `help_link`. Staff: the Incidents tab on managers' and owners' phones (`screens/Incidents.tsx`), the "Manager needed · n" pin on the Board, the help alert and the log in Admin → Safety. Guest: the discreet link and its sheet on the room page.
  - **Events:** `incident.opened`/`incident.updated` go to the managers' audience with no room on them; the board's count rides a new `incident.count` event (the venue as its id, the open count as its version) on the staff audience, added to spec 08's Live events row. `POST /incidents` added to spec 08's Safety row.
  - **Cautious defaults:** the kinds are the canvas's three (`unsafe`, `someone_needs_help`, `other`); the guest's confirmation uses the canvas wording ("Sent to the managers", "A manager is coming to find you…", "In an emergency, call 911"), but the intro says "Only the managers see…" rather than the canvas's "tonight's managers", because every manager and owner gets it. A second tap from the same guest while their alert is open answers the same incident with no second push. `keep_until` is set at close: the close plus the rule pack's `incidentsYears` (3) in venue time; open incidents have none and are kept. No new settings keys (the module switch turns it all on or off). The pin stays until the incident is closed (I'm on it doesn't clear it).
  - **Later:** the nightly retention job (spec 12) must delete incidents past `keep_until`; none exists yet. The generic wall and principal suites see these routes as module-off at their test venues, so `incidents.int.test.ts` covers the role refusals, other-venue ids and the board's channel directly.
  - **Phone tabs and checks.** With Incidents a manager's phone has 15 tabs; at 390 px the bar overflowed the page, so a tab's side padding went from 8 px to 4 px (`styles.css`), and every phone screen fits again in English and Spanish. `pnpm check` passed whole; in `pnpm check --e2e`, 150 passed and the phone tests failed on that overflow; after the fix the 23 that failed (including the api clock test and the desktop replay, which failed only in the full run) pass when run again.

### M8-09 · Keep the license register with renewal reminders

- **Status:** blocked
- **Size:** M
- **Depends on:** M2-13 (`POST /files`), M1-31 (Admin), M1-06 (jobs), M1-18 (email), M1-22 (push)
- **Spec:** [Data model](../spec/04-data-model.md) · `licenses`, `files`; [API](../spec/08-api.md) · Safety (licenses), Files (license copies: PDF, JPEG or PNG up to 20 MB); [milestones](../milestones.md#must-fix-items-and-where-they-close) GA-M10, GA-S8; [blueprint](../blueprint.md) · Start now (performance licenses); screens [N35](../screens.md#n35-admin--licenses), [AdminDesk](../screens.md#admindesk) note 20
- **Build:**
  - `licenses (kind, number, holder, authority, starts_on, expires_on, fee_cents, conditions, file_id, reminded_at)` with `kind` in `liquor`, `ascap`, `bmi`, `sesac`, `gmr`, `local`, `health`, `other`; `GET`, `POST` and `PATCH /licenses`.
  - Admin → Licenses, a new section (passkey; owner and managers): the register, each license with its number, holder, expiry, fee, conditions and a copy.
  - A daily job reminds the owner and managers 60, 30 and 7 days before `expires_on`, by email and push, each reminder once.
- **Acceptance:**
  - [ ] Admin → Licenses holds West 4's ASCAP, BMI, SESAC, GMR and liquor licenses, each with its number, holder, expiry, fee, conditions and a PDF copy. *Blocked on the owner: the register is built and tested with test fixtures (`licenses.int.test.ts`, the e2e), but West 4's real numbers, holders, dates, fees, conditions and copies come from the paper licenses and are never made up; until they're entered the screen says "Not on file yet: ASCAP, BMI, SESAC, GMR, Liquor".*
  - [x] On the simulated clock, a license 30 days from expiry sends the reminder once to Abhishek and Andy, and the 7-day reminder later.
  - [x] A 25 MB upload or a Word file is refused by storage.
- **Tests:** clock tests for the reminder windows; file-limit tests; the principal suite.
- **Notes:** Spec gap: [N35](../screens.md#n35-admin--licenses) says the reminder "texts or emails" and the data model says it "reminds the owner and managers"; cautious default: email and push, since the venue's texting number is for guests.
  - Built: migration `0112_licenses.sql` (`licenses`, forced row-level security, audited; the seed loads none and wipes it before `files`); `apps/api/src/licenses/licenses.ts` (register, reminder windows, the daily job `licenses.remind` at 10:00 AM on each venue's clock, bulk pool); `apps/api/src/routes/licenses.ts` (`GET`/`POST /v1/venues/{v}/licenses`, `PATCH /v1/venues/{v}/licenses/{l}`: owners and managers, action `admin.access`, so a passkey session only); the `license_reminder` email; push keys `licenses.push.<kind>`; Admin → Licenses (`apps/staff/src/screens/admin/Licenses.tsx`), after Safety.
  - Cautious defaults: reminders by email and push (as the ticket says), to every active owner and manager, each in their own language. One reminder per window: `reminded_days` (added beside `reminded_at`; spec 04 updated) holds the narrowest window sent, so a license entered 20 days out gets only the 30-day reminder, an already-expired one gets the 7-day reminder once, and a new `expires_on` (a renewal) starts them over. A day the job misses is caught up the next morning. On staging, an address outside the email allow-list is skipped rather than failing the run. Every field but the kind may be empty; the screen shows "Not entered".
  - The license copy rules (PDF, JPEG or PNG up to 20 MB) were already in `FILE_RULES` from M2-13; this ticket adds the tests (`files.int.test.ts`) and checks a copy is a `license_copy` upload before attaching it.
  - The wall suite's job count is now 11 (the reminder job carries venue B's id in its payload and finds nothing).
  - `pnpm check --e2e`: everything passed but three older tests that only failed in the 17-minute full run and pass alone (the api project's "after a fresh seed" clock check, which drifted past 10:4x, and the desktop queue-mode and replay tests).

### M8-10 · Let the owner approve support grants, and enforce them

- **Status:** todo
- **Size:** L
- **Depends on:** M1-35 (Console sign-in with FIDO2 keys), M1-05 (row-level security), M1-07 (audit triggers), M1-19 (owner passkey sessions)
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Support access, The database walls; [Security and data retention](../spec/12-security-retention.md) 7; [API](../spec/08-api.md) · Support access; [Data model](../spec/04-data-model.md) · `support_grants`, `audit_log` (`support_grant_id`); [Testing and operations](../spec/13-testing-operations.md) · On call; screens [N39](../screens.md#n39-admin--console), [Console](../screens.md#console) notes 2 and 3
- **Build:**
  - Console (`apps/console`): request access to a venue with a reason, a scope (read, or write for one named action) and a length up to 60 minutes; "Waiting for West 4 to approve"; the open grant with its time left and [End now].
  - `support_grants (staff_id, requested_by, reason, scope, status, approved_by, second_approver, starts_at, ends_at, revoked_at)`.
  - Admin → Console, owner only (managers don't see it), in a passkey session: the reason, scope and length, [Approve] and [Decline], and ending it at any time (`GET /support-grants`, `POST /support-grants/{g}/approve`, `/decline`, `/revoke`). A banner shows in Admin while a grant is open.
  - The support session carries its `support_grant_id`, and every transaction runs `SET TRANSACTION READ ONLY` on masked views (no ID scans, no guest phone numbers). An approved write allows only its one named action, once; the rest stays read-only. Every audit row records both identities. The session ends at `ends_at` or on revoke.
  - The principal and venue-wall suites run as a support principal too.
- **Acceptance:**
  - [ ] A read grant for West 4 opens only after Abhishek approves it in Admin → Console, and Andy's Admin has no Console section.
  - [ ] During the grant, guests show masked phone numbers and no ID scans, and every write fails as read-only.
  - [ ] A write grant for one named action allows it once; a second try, and any other write, fail.
  - [ ] The session ends by itself at 60 minutes, and Abhishek's End now ends it at once.
  - [ ] Every audit row written during the grant names our staff member and the grant.
- **Tests:** row-level security and masked-view tests as a support principal; a time-box test on the simulated clock; the principal suite.
- **Notes:** The Console canvas and the API's table say the owner "or a manager" approves; build owner only, as [Tenancy and access](../spec/02-tenancy-access.md), the milestone and [Console](../screens.md#console) note 3 say.

### M8-11 · Run the Console's emergency actions with a second approver

- **Status:** todo
- **Size:** M
- **Depends on:** M8-10; M4-12 (the reconciler), M4-11 (reader actions); M3-13 (print jobs and reprints); M7-12 (the close)
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Support access (the emergency path); [Testing and operations](../spec/13-testing-operations.md) · On call; [Security and data retention](../spec/12-security-retention.md) 7; screens [N39](../screens.md#n39-admin--console), [Console](../screens.md#console)
- **Build:** the four emergency actions in the Console, and nothing else: re-sync a payment (the payment state machine run against Stripe for one payment), cancel a reader action (`cancel_action` on one reader), requeue a print (a reprint of one job) and close a stuck night. Each needs a reason and a second approver on our side (another staff member in their own FIDO2 session), is time-boxed, writes audit rows with both identities, and tells the venue's owner the moment it opens, by email and push. Closing a stuck night runs the normal close; our staff may clear only stale items with named fixes (clock out a shift left open, with a reason; clear a stale draft; expire an approval whose target is gone), and never skip an uncounted drawer, an open tab or an open room.
- **Acceptance:**
  - [ ] Requeueing a print for West 4 waits for a second person on our side, then prints "REPRINT 2", and Abhishek is told at once who did it and why.
  - [ ] Nobody can approve their own emergency action.
  - [ ] No other action runs through the emergency path.
- **Tests:** integration tests with two Console principals; notification tests; audit-row tests.
- **Notes:** Spec gap: what "close a stuck night" may change isn't said; cautious default above.

### M8-12 · Run the nightly retention job and detach saved cards on schedule

- **Status:** todo
- **Size:** L
- **Depends on:** M1-06 (jobs), M1-05 (roles), M2-06 (guests and bookings), M2-22 (messages), M2-23 (consents), M2-25 (waitlist), M2-13 (files), M5-09 (cards saved at booking), M6 (singers, cards saved on bar tabs)
- **Spec:** [Security and data retention](../spec/12-security-retention.md) · How long we keep things; [Data model](../spec/04-data-model.md); [Stripe setup](../spec/06-stripe-setup.md) 10; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · the rule pack's `retention`
- **Build:** a nightly job per venue, under its own role, driven by one policy table:
  - Pseudonymize guests after 24 months without a visit, and bookings, waitlist entries and enquiries after 3 years; delete messages and consents 4 years after the last text; keep opt-outs as a hash of the number.
  - Delete print job payloads after 30 days, webhook payloads after 90 days, logs and error reports after 30 days (our providers' settings too), idempotency keys after 7 days, `venue_events` after 72 hours and unattached uploads after 24 hours.
  - Delete singers 30 days after their last song unless they still owe money.
  - Purge message bodies at Twilio after 30 days; our own copy follows the messages row.
  - Detach saved cards at Stripe 30 days after the booking closes, and cards saved on bar tabs 7 days after the tab closes.
  - Keep checks, lines, payments, refunds and night closes at least 3 years; time punches, tip pools, shares and the tip ledger 6 years; the audit log 6 years; incidents 3 years.
  - Drop expired monthly partitions, and log what it removed as counts per kind, never the data.
- **Acceptance:**
  - [ ] On the simulated clock, a guest last seen 24 months and a day ago is pseudonymized, and one seen yesterday isn't.
  - [ ] A print payload from 31 days ago is gone, and one from 29 days ago stays.
  - [ ] The card saved on a bar tab closed 8 days ago is detached on the sandbox, and one closed 6 days ago isn't.
  - [ ] A singer 31 days past their last song who still owes money isn't deleted.
  - [ ] Each run's log lists what it removed, by kind and count.
- **Tests:** a clock test for each kind; Stripe sandbox detach tests; Twilio test credentials; a rerun test (a second run removes nothing new); the venue-wall suite over the job.
- **Notes:** Backups keep 35 days of point-in-time restore, so pseudonymized rows live on in backups that long; M8-20 re-applies erasures after a restore. Spec gap: the job "drops expired monthly partitions", but no table is named as partitioned; cautious default: delete by rows, and partition a table only when its size needs it.

### M8-13 · Erase a guest on request

- **Status:** todo
- **Size:** M
- **Depends on:** M5-08 (guests' details and consents from booking), M5-09 (cards saved at booking); M2-09 (the Twilio subaccount), M2-22 (messages); M6 (singers)
- **Spec:** [Security and data retention](../spec/12-security-retention.md) · Erasing a guest, How long we keep things (opt-outs); [API](../spec/08-api.md) · Guests (`POST /guests/{g}/erase`); [Data model](../spec/04-data-model.md) · `guests`, `consents`, `messages`, `singers`; [Song systems and texts](../spec/11-song-systems-texts.md) · Consent and timing
- **Build:** `POST /guests/{g}/erase` for owners and managers, in a passkey session: blank the name, phone and email; detach the guest's saved cards at Stripe; purge message bodies that aren't under a legal hold, here and at Twilio; keep checks, payments and the audit log, which carry no contact details; keep an opt-out as a keyed hash of the number, so an erased guest is never texted again; set `erased_at`. A singer who asks is erased the same way once their tab owes nothing. Each erase is recorded in an erasure log that M8-20 re-applies after a restore.
- **Acceptance:**
  - [ ] Erasing a guest who texted STOP blanks their details, detaches their saved card on the sandbox, purges their message bodies here and at Twilio, and keeps the opt-out as a hash.
  - [ ] A later booking made with that number sends no text to it, because the opt-out hash matches.
  - [ ] After Marcus T.'s check is paid, erasing him keeps check #1042, its payments and its audit rows, with no contact details on them.
  - [ ] A singer who still owes money can't be erased until their tab owes nothing.
- **Tests:** integration tests on the Stripe sandbox and with Twilio test credentials; a test that the audit rows written by the erase hold no values for the erased fields; the principal suite.
- **Notes:** Spec gap: nothing marks a message as under a legal hold; cautious default: messages tied to a booking or check with an open dispute are held.

### M8-14 · Destroy each night's ID-scan key after 7 days

- **Status:** todo
- **Size:** S
- **Depends on:** M2-12 (`id_checks` with scan fields encrypted by a key per venue and business date)
- **Spec:** [Security and data retention](../spec/12-security-retention.md) 6, How long we keep things (scanned ID fields); [Data model](../spec/04-data-model.md) · `id_checks`; [milestones](../milestones.md#must-fix-items-and-where-they-close) GA-S7; [Open technical questions](../spec/14-open-questions.md)
- **Build:** a daily job that destroys the key for each venue and business date 7 days after that date, in the key service, so no copy of that night's scan fields can be read, backups included. The count stays: `id_checks` rows keep who checked, when and how, and "ID ✓ 12 of 12" still shows. Each destruction is logged.
- **Acceptance:**
  - [ ] On the simulated clock, a scan from Fri Sep 25 decrypts before the job runs on Fri Oct 2 and fails after.
  - [ ] Room 9's "ID ✓ 12 of 12" still shows after the key is gone.
  - [ ] A backup restored to a scratch copy can't read that night's scan fields either.
- **Tests:** clock tests; a restore test against a scratch copy.
- **Notes:** Open question (lawyer, gate): how long scanned ID fields may be kept. 7 days is the default until then, and it lives in the rule pack's `idScan.keepDays`.

### M8-15 · Bill our plan on Stripe Billing

- **Status:** todo
- **Size:** M
- **Depends on:** our company entity and Stripe platform account (the M4 wait); M4-03 (billing events stored for M8); M1-31 (Admin); M2-04 (rooms and archiving)
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Plan billing; [Stripe setup](../spec/06-stripe-setup.md) 6 (the Our billing endpoint) and 7 (the billing key); [Data model](../spec/04-data-model.md) · `venue_subscriptions`, `organizations.billing_customer_id`; [blueprint](../blueprint.md) · Proposed plans; [milestones](../milestones.md#admin-by-milestone) · Admin by milestone (Payments: our plan); [Open technical questions](../spec/14-open-questions.md)
- **Build:**
  - A Customer per organization on our own platform account, used only with the billing key, and a subscription per venue: the plan's price plus a per-room item whose quantity counts every room that isn't archived (14 at West 4; a room switched off tonight still counts). The quantity follows rooms being added or archived. `venue_subscriptions (venue_id, plan, stripe_subscription_id, room_quantity, status)`.
  - The billing webhook endpoint, `POST /v1/hooks/stripe/platform`, with its own signing secret: `customer.subscription.updated` and `deleted`, `invoice.paid` and `invoice.payment_failed`.
  - Admin → Payments (owner only): our plan, the next invoice and the payment method, through Stripe's hosted pages.
  - A failed plan payment shows a banner in Admin; after 14 days Admin is read-only (every Admin write is refused with the reason) while the board, rooms, bar and payments keep working. Nothing switches off during opening hours.
- **Acceptance:**
  - [ ] West 4's subscription counts 14 rooms, and archiving a room lowers the quantity.
  - [ ] A failed plan payment on our test venue shows the banner in Admin.
  - [ ] 14 days later, in staging on a Stripe test clock and our simulated clock, Admin is read-only on the test venue, while its board, rooms, bar and payments keep working.
  - [ ] Paying the invoice clears the banner and Admin works again.
- **Tests:** Stripe Billing test clocks; webhook signature and live-mode tests; a test that no board, room, bar or payment route reads the billing status.
- **Notes:** Plan prices are proposals until the founder decides after the pilots ([blueprint](../blueprint.md) · Open decisions); whether West 4 is billed during the gate is the founder's call. Open question (founder, with the lawyer): the company entity that holds our platform account. Spec gap: no error code for a read-only Admin; add one to the API's list.

### M8-16 · Watch production: telemetry, error tracking and the status page

- **Status:** todo
- **Size:** M
- **Depends on:** M1 (every service), M3-16 (the order-to-alarm path), M4-05 (payments)
- **Spec:** [Testing and operations](../spec/13-testing-operations.md) · Watching production; [Scope and architecture](../spec/01-scope-architecture.md) · Targets; [Security and data retention](../spec/12-security-retention.md) 12, How long we keep things (logs and error reports 30 days)
- **Build:**
  - OpenTelemetry metrics, logs and traces from `apps/api`, the job workers, `apps/staff`, `apps/desktop` and `apps/guest`, with logs kept 30 days.
  - Error tracking with personal data stripped before it leaves: names, phone numbers, emails, tokens and card details.
  - Dashboards for the published targets: 99.9% a month for ordering, payments and printing during opening hours; order to bar alarm under 3 seconds for 95% of orders; 99.5% of card payments not failing on our side; the data-loss and recovery targets. Burn-rate numbers for M8-17's alerts.
  - A public status page for ordering, payments, printing and texts.
- **Acceptance:**
  - [ ] A traced room order shows its path from the room page to the bar device's alarm, with the time it took.
  - [ ] An error raised with a guest's phone number in its message reaches the tracker with the number stripped.
  - [ ] The status page shows each part and updates during M8-07's drills.
- **Tests:** a test that fails if any fixture phone number, email or token appears in an exported error or log; a trace test for the order path.
- **Notes:** —

### M8-17 · Page on money risk with runbooks, and put two people on call

- **Status:** todo
- **Size:** M
- **Depends on:** M8-16; M7-14 (payout matching); M6 (the capture sweep); M1-06 (jobs and dead letters), M1-16 (heartbeats and grouped device alerts)
- **Spec:** [Testing and operations](../spec/13-testing-operations.md) · Watching production, On call; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Heartbeats; [Security and data retention](../spec/12-security-retention.md) 4 (payouts matched every night)
- **Build:**
  - Alerts that page us only when a target is burning or money is at risk: payment failures, a failed capture sweep, money jobs in the dead-letter queue, a database failover, webhook lag over a minute, a payout that doesn't reconcile, and a target's burn rate.
  - Device problems stay with the venue's manager, grouped by M1-16 into one "venue offline" alert; a device problem pages us only when a money path is at risk, such as both readers offline during opening hours.
  - Every alert links its runbook in `docs/runbooks/`, one per alert.
  - A paging tool with an escalation policy: a page nobody acknowledges within 10 minutes goes to the second responder. The rota names both.
- **Acceptance:**
  - [ ] A second responder is on the rota, and a test page nobody acknowledges in 10 minutes reaches them.
  - [ ] Every alert rule links a runbook that exists.
  - [ ] Both readers going offline at the test venue during opening hours pages us, while one quiet room tablet only alerts the manager.
  - [ ] A payout that doesn't reconcile pages us.
- **Tests:** alert-rule tests with forced conditions; the escalation test; a link check over the runbook links.
- **Notes:** Support hours are a founder decision ([blueprint](../blueprint.md) · Open decisions); M9-16 extends on-call to every opening hour.

### M8-18 · Run a synthetic order and reader payment every 5 minutes

- **Status:** todo
- **Size:** S
- **Depends on:** M8-16, M8-17, M7-04 (the sandbox path for practice payments); M3-08 and M3-06 (joining a room and ordering); M4-11 (reader payments)
- **Spec:** [Testing and operations](../spec/13-testing-operations.md) · Watching production; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `venue_flags` (our own test venue); [Scope and architecture](../spec/01-scope-architecture.md) · Targets
- **Build:** every 5 minutes during New York opening hours, a job on our own test venue in production joins a room, places an order, measures the time until a synthetic bar device's alarm rings, accepts it, and takes a simulated-reader payment on the sandbox through M7-04's practice path, so it never touches live money or the live webhook endpoints. Results feed M8-16's targets, and a failure raises its alert with its runbook.
- **Acceptance:**
  - [ ] The check runs every 5 minutes during West 4's hours (4:00 PM to 4:00 AM on weekdays, 2:00 PM to 4:00 AM on Saturdays and Sundays) and not outside them.
  - [ ] Breaking the reader path raises the alert on the next run.
  - [ ] The test venue never shows in West 4's reports, and its rows stay behind the venue wall.
- **Tests:** a clock test for the schedule, both daylight-saving nights included.
- **Notes:** Spec gap: "New York opening hours" isn't defined for a check that serves every venue; cautious default: the union of every live venue's hours, which with West 4 alone is West 4's own.

### M8-19 · Close the security baseline (GA-M9)

- **Status:** todo
- **Size:** M
- **Depends on:** M1-19 (sign-in), M1-37 (the venue-wall suites), M1-07 (audit), M4-01 (restricted keys), M4-03 (webhook endpoints), M4-15 (the payment page and its changed-script check), M5-05 (booking's public forms), M8-16
- **Spec:** [Security and data retention](../spec/12-security-retention.md) 1 to 15; [Tenancy and access](../spec/02-tenancy-access.md) · Approvals (on the record); [milestones](../milestones.md#must-fix-items-and-where-they-close) GA-M9; [Open technical questions](../spec/14-open-questions.md)
- **Build:**
  - Dependency and container scanning in CI, failing a merge on high and critical findings.
  - Alerts on unusual activity to us: refund spikes and sign-ins from new countries. Alerts to the venue's owner: voids after a cash payment and refunds over a set amount.
  - The key-rotation runbook for the Stripe restricted keys, Twilio, the email provider and webhook secrets (at most 7 days of overlap, and after any staff change), and a first rotation drill.
  - The breach runbook with its named person: we tell the venue immediately and within 72 hours; the venue tells residents and the state within 30 days. The data processing addendum's wording waits for the lawyer.
  - The PCI pieces: each venue's responsibility matrix and our signed confirmation for the payment page, drafted now and final once the assessor answers; a failing run of M4-15's weekly changed-script check pages us.
  - Radar rules where the venue's account allows them, and our own decline-rate alarm per venue, which M5-05 left to M8.
  - A GA-M9 evidence table: each of the 15 items in Security and data retention, where it's built, and its test.
- **Acceptance:**
  - [ ] A void on Jess P.'s tab after one share of its split ($16.33) was paid in cash alerts Abhishek.
  - [ ] A sign-in to Andy's account from a new country alerts us.
  - [ ] A key rotation drill completes with at most 7 days of overlap and no failed payments.
  - [ ] A burst of declined cards on West 4's booking page raises the decline-rate alarm.
  - [ ] A failing weekly run of M4-15's script check pages us.
  - [ ] The evidence table has an entry for each of the 15 items.
- **Tests:** alert tests with forced conditions; CI scanning in place; the rotation drill report.
- **Notes:** Spec gap: "refunds over a set amount" has no settings key or value; cautious default: every refund alerts the owner until one is set. Open questions (gate): the breach duties in the data processing addendum (lawyer) and which PCI validation we file (assessor), both collected in M9-13.

### M8-20 · Restore one venue from a scratch copy, and drill it monthly

- **Status:** todo
- **Size:** L
- **Depends on:** M1-05 (row-level security and the audited migration role), M1-07 (audit triggers), M4-04 (the money core), M8-13 (the erasure log)
- **Spec:** [Testing and operations](../spec/13-testing-operations.md) · Backups and restore, Releases (the audited migration role); [Scope and architecture](../spec/01-scope-architecture.md) · Targets (data loss and recovery), When our cloud is down (a lost region); [Security and data retention](../spec/12-security-retention.md) · How long we keep things (backups)
- **Build:**
  - Infrastructure: continuous point-in-time backups for 35 days, copied continuously to a second region.
  - A per-venue restore tool: restore the cluster to a scratch copy at a point in time, read one venue's rows from it, and apply them to production without touching other venues. Settings and the menu come back as new versions; money rows are only inserted, never overwritten, each audited, as the audited migration role. Then a job pulls Stripe and Twilio activity since the restore point (payments, refunds, disputes, payouts and messages) through the usual state machines, and the erasure log is applied again.
  - The monthly drill runbook: timed, and checking that the row-level policies and roles are in place, the app boots on the restored data, and the counts match Stripe. The yearly region failover runbook (a scripted warm standby and a DNS cutover).
- **Acceptance:**
  - [ ] The drill restores our test venue from a scratch copy while another venue keeps working; the other venue's rows are unchanged, compared by hash.
  - [ ] The restored venue's payments match Stripe's PaymentIntents for the window in count and amount.
  - [ ] The drill's time is recorded against the recovery targets.
  - [ ] A guest erased after the restore point stays erased after the restore.
- **Tests:** the drill itself, monthly; an integration test of the restore tool on staging.
- **Notes:** Spec gap: a restore could bring back guests erased or pseudonymized after the restore point; cautious default: re-apply the erasure log after every restore.

### M8-21 · Load-test a Friday night for 20 venues

- **Status:** todo
- **Size:** L
- **Depends on:** M8-16; M3-06 and M3-16 (orders and the alarm), M4-05 (payments), M6 (tabs), M7-18 (a heavy report)
- **Spec:** [Testing and operations](../spec/13-testing-operations.md) · Tests (Friday-night load test), Capacity; [Scope and architecture](../spec/01-scope-architecture.md) · Targets
- **Build:**
  - A load harness in the repo against a staging copy with 20 venues seeded from the demo seed. Each runs a Friday peak of room orders, bar rounds, tabs and payments, with Stripe mocked at delays sampled from real sandbox calls and Twilio mocked; then a reconnect storm, every device reconnecting at once; and a heavy report (the 8-week trends) during the peak. Synthetic bar devices measure order to alarm.
  - The capacity guards in place: 5-second limits on statements and idle transactions for the app role, reports on the replica, staff routes rate-limited per venue, a token bucket in front of Stripe, and night-close captures staggered across venues.
- **Acceptance:**
  - [ ] With 20 venues peaking together, the bar alarm still rings within 3 seconds for 95% of orders (the published target), and the run reports the slowest.
  - [ ] The reconnect storm and the heavy report don't push the alarm past the target.
  - [ ] No ordering or payment request fails on our side during the run.
- **Tests:** the load test itself, rerun before the gate starts and after any change to the event relay or sockets.
- **Notes:** Spec gap: peak volume per venue isn't given; cautious default: the busiest 20 minutes of M7-19's staging nights, per venue.

### M8-22 · Put West 4's texts live on its 10DLC campaign

- **Status:** todo
- **Size:** S
- **Depends on:** West 4's 10DLC brand and campaign approval; M2-09 (the Twilio subaccount), M2-23 (STOP and HELP); M5-08 (the marketing opt-in with proof)
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Texts through Twilio (Accounts, Consent and timing, Abuse); [Security and data retention](../spec/12-security-retention.md) 8; [milestones](../milestones.md#must-fix-items-and-where-they-close) GA-M3; [blueprint](../blueprint.md) · Start now (10DLC)
- **Build:**
  - West 4's brand and service campaign registered through Twilio's own 10DLC process, and its number in the campaign's messaging service; status shown in Admin → Phone & texts.
  - Production texts real numbers only once the campaign is approved; staging still texts only our own test phones.
  - A marketing campaign only when Marketing texts is on (off at West 4).
  - Tests that prove the marketing rules even though both marketing texts are off: their own opt-in with proof, sending only between 8 AM and 9 PM in the recipient's time zone (from the area code, checked against the venue's), and opt-outs honored at once. SMS pumping protection on and +1 numbers only.
- **Acceptance:**
  - [ ] A Booking confirmed text from production reaches a real phone on the approved campaign.
  - [ ] STOP stops every text to that number at once and sends one confirmation; HELP answers with West 4's name and number.
  - [ ] On a test venue with Marketing texts on, a marketing send at 9:05 PM in the recipient's time zone is refused.
- **Tests:** integration tests with Twilio test credentials; clock tests for the sending window across time zones.
- **Notes:** GA-M3 closes here (STOP in M2, the opt-in in M5). Open question (lawyer): whether review-ask and birthday texts are marketing; nothing waits on it, since both stay off.

### M8-23 · Run the one-room mic power trial (K1)

- **Status:** todo
- **Size:** M
- **Depends on:** West 4's written approval; Playbox's answer on the equipment warranty; M1-15 and M1-16 (devices and heartbeats), M2-11 (check-in), M2-19 (cleaning), M4-20 (close-out)
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Mic power trial; [Data model](../spec/04-data-model.md) · `devices` (`mic_outlet`); [decisions](../decisions.md) D83; [blueprint](../blueprint.md) · Open decisions (Mic-receiver outlet trial); [Open technical questions](../spec/14-open-questions.md); screens [AdminDesk](../screens.md#admindesk) note 10
- **Build:**
  - Our own switched outlet on one room's wireless-mic receiver, never on the song player: a `devices` row of kind `mic_outlet`, paired and watched with heartbeats like any device, listed in Admin → Printers & devices.
  - On at check-in; off at close-out or cleaning; left on whenever our server can't be reached. The outlet switches off only on a fresh, signed command from us and back on when it loses contact, so an outage never silences a room.
  - Behind a venue flag for the one room, and a trial log of each switch.
- **Acceptance:**
  - [ ] With the flag on for one room, check-in turns the mic receiver on and close-out turns it off.
  - [ ] Blocking our server turns the outlet back on.
  - [ ] Nothing ever changes the song player's power.
  - [ ] The trial isn't part of the gate, and M8-24 doesn't wait for it.
- **Tests:** device tests with a lost connection and a stale command; the principal suite over the outlet's device key.
- **Notes:** Open question (Playbox): does the outlet affect the equipment warranty? The trial starts only after that answer and West 4's written approval. Pick an outlet whose firmware turns on when it loses contact and accepts only signed commands; only our own hardware, and nothing that touches Playbox's player.

### M8-24 · Close GA-M3, GA-M8, GA-M9 and GA-M10, and sign off M8

- **Status:** todo
- **Size:** S
- **Depends on:** M8-01 to M8-22
- **Spec:** [milestones](../milestones.md#must-fix-items-and-where-they-close) · GA-M3, GA-M8, GA-M9 and GA-M10, GA-S4, GA-S6, GA-S7 and GA-S8
- **Build:** a walk through each M8 done-when line, with its evidence (the drill reports, test runs, screenshots) linked here, and the must-fix rows: GA-M3 (M8-22), GA-M8 (M8-01 to M8-07), GA-M9 (M8-19's evidence table), GA-M10 (M8-09; the play log shipped in M6).
- **Acceptance:**
  - [ ] Each M8 done-when line has a passing test, a drill report or a recorded walk.
  - [ ] GA-M3, GA-M8, GA-M9 and GA-M10 are marked closed in M9-14's must-fix tracker.
- **Tests:** none of its own.
- **Notes:** M8-23 (the mic trial) isn't part of the gate or this sign-off.

## Coverage

Every "Ships" item, done-when line, Admin section and must-fix item that milestones.md gives M8, and where it lands.

| From milestones.md                                                                                          | Tickets                                                                     |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Ships · Offline and outages: the banners and "Online · synced 4 s ago"                                    | M8-01                                                                       |
| Ships · Offline and outages: the router as a device reporting the line or LTE                              | M8-02                                                                       |
| Ships · Offline and outages: the read-only board and tabs from the desktop cache                           | M8-03                                                                       |
| Ships · Offline and outages: queue mode behind an offline code, rounds "queued · not charged"             | M8-04                                                                       |
| Ships · Offline and outages: replay as asked to wait, "Confirm replayed orders (3)", "Review after outage" | M8-05                                                                       |
| Ships · Offline and outages: the one-page break-glass card                                                 | M8-06, M8-07                                                                |
| Ships · Safety: the help alert, "Manager needed", the incident log kept 3 years                            | M8-08                                                                       |
| Ships · The license register (C6)                                                                          | M8-09                                                                       |
| Ships · The minimal Console, part 2: support grants                                                        | M8-10                                                                       |
| Ships · The minimal Console, part 2: the emergency actions                                                 | M8-11                                                                       |
| Ships · Data jobs: the nightly retention job, detaching saved cards on schedule                            | M8-12                                                                       |
| Ships · Data jobs: guest erase                                                                             | M8-13                                                                       |
| Ships · Data jobs: destroying each night's ID-scan key after 7 days                                        | M8-14                                                                       |
| Ships · Our plan billing                                                                                   | M8-15                                                                       |
| Ships · Watching production: metrics, logs and traces, error tracking, the public status page              | M8-16                                                                       |
| Ships · Watching production: alerts with runbooks                                                          | M8-17                                                                       |
| Ships · Watching production: the synthetic order and reader payment every 5 minutes                        | M8-18                                                                       |
| Ships · Backups and load: the per-venue restore and its monthly drill                                      | M8-20                                                                       |
| Ships · Backups and load: the Friday-night load test                                                       | M8-21                                                                       |
| Ships · Texts go live                                                                                      | M8-22                                                                       |
| Ships · The one-room mic power trial (K1)                                                                  | M8-23                                                                       |
| Ships · Canvas boards: Board, Rail, Bar, Night, Staff, Console and AdminDesk                               | M8-01, M8-03, M8-04, M8-05, M8-06, M8-08, M8-09, M8-10, M8-11, M8-02, M8-15 |
| Done when · The outage drills pass at West 4                                                               | M8-07, M8-01, M8-02, M8-03, M8-04, M8-05, M8-06                             |
| Done when · A help alert from Room 9 reaches only the managers' phones                                     | M8-08                                                                       |
| Done when · The restore drill brings one venue back from a scratch copy                                    | M8-20                                                                       |
| Done when · In the load test (20 venues peaking together)                                                  | M8-21                                                                       |
| Done when · A support grant opens only after the owner approves it                                         | M8-10, M8-11                                                                |
| Done when · The retention job deletes or pseudonymizes what's past its time                                | M8-12, M8-13                                                                |
| Done when · A license inside its reminder window sends the reminder                                        | M8-09                                                                       |
| Done when · A failed plan payment on our test venue shows the banner                                       | M8-15                                                                       |
| Done when · A second responder is on call                                                                  | M8-17                                                                       |
| Admin · Printers & devices: the router (M8)                                                                | M8-02                                                                       |
| Admin · Safety: the help alert and incidents (M8)                                                          | M8-08                                                                       |
| Admin · Payments (owner only): our plan (M8)                                                               | M8-15                                                                       |
| Admin · Licenses                                                                                           | M8-09                                                                       |
| Admin · Console (owner only)                                                                               | M8-10                                                                       |
| Must-fix · GA-M3 (marketing texts and 10DLC)                                                               | M8-22, M8-24                                                                |
| Must-fix · GA-M8 (offline mode)                                                                            | M8-01, M8-02, M8-03, M8-04, M8-05, M8-06, M8-07, M8-24                      |
| Must-fix · GA-M9 (the security and PCI baseline)                                                           | M8-19, M8-10, M8-11, M8-14, M8-16, M8-24                                    |
| Must-fix · GA-M10 (the license register)                                                                   | M8-09, M8-24                                                                |
| Should-have · GA-S4 (the mic power trial)                                                                  | M8-23                                                                       |
| Should-have · GA-S6 (the help alert and the incident log)                                                  | M8-08                                                                       |
| Should-have · GA-S7 (destroying the ID-scan keys)                                                          | M8-14                                                                       |
| Should-have · GA-S8 (the license register)                                                                 | M8-09                                                                       |

**Size:** 24 tickets: 5 S, 14 M and 5 L, about 53 to 72 working days at the ranges' low and high ends, against the 3–4 weeks in milestones.md.
