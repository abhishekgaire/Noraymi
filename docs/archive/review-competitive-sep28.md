# Competitive review: karaoke venue software

Sep 28, 2026 · Independent review of the blueprint (rev 68), the spec (rev 182) and the design canvas

**Scope.** What a karaoke venue can buy today, in eight competitor groups, compared with what we plan to ship. The new research covers karaoke and KTV systems, software for venues that sell time (pool tables, bowling lanes, golf bays, escape rooms), nightlife reservation tools, and the bar-POS features the earlier research left out. It builds on the earlier report *Staff first bar POS design* and its notes (Toast, Square, Clover, Lightspeed, TouchBistro, SpotOn, Aloha, Japanese and Chinese KTV practice) and on the earlier gap analysis, and doesn't repeat them. Legal points are out of scope; where a gap touches the law, it says "after the owner's lawyer approves" and nothing more.

**How to read "Us".** Nothing of ours is live yet. **P1** means it's in the phase 1 build for West 4 (designed or prototyped on the canvas, per the spec's seven phase 1 milestones), **P2** productize, **P3** pilots, **—** not in the plan. Vendor figures are marked as vendor claims.

## The short answer

- **The design beats everything documented at one job:** running private rooms and a bar on one check. That means per-person room time with a first-hour minimum and per-minute overage, deposits applied at check-in, room orders the bar must accept with ID status, card holds that grow, last call in one confirmation, and New York's closing-hour stop on every channel. No competitor group documents all of that together.
- **"Better than any other POS for karaoke venues" doesn't hold yet, for four reasons.** (1) Nothing is live, and Toast, Square and SpotOn take cards offline. (2) KaraFun, Singa and TJ Media's own POS already lock, start and time the song player, and we can't do that for Playbox (West 4) or TJ (Koreatown). (3) Flushing KTVs and Koreatown noraebang expect things we don't plan: booking-host commissions, stored-value cards, bottle keep, WeChat Pay, TJ time control. (4) Toast, Square, SpotOn and iTab ship breadth we lack: gift cards, loyalty, campaigns, inventory, kitchen screens, one-device handhelds.
- **The three biggest gaps:** K1, the song player locking and starting from our clock; K2, guests paying their own share from their phones; K3, packages and add-ons prepaid in the booking.
- **Phase 1 at West 4 should add four small things:** pay-my-share (K2), "you're up" alerts and a KJ songbook upload for bar mode (K6), "Order again" on the room page (K16), and a one-room trial of a clock-switched outlet on the mic receiver (K1) while Playbox hasn't signed. It should also reserve five things in the phase 1 data model (K4, K5, K9 ×2, K13) so they don't need rewrites later.
- **Time billing itself isn't unique.** Pool-hall, bowling and Chinese KTV software already bill by the exact minute and per person. The edge is the karaoke combination, and the pitch should say that instead.

## What this adds to the earlier research

1. **Time billing has precedents.** CuePoint bills pool tables by "exact time, 15-minute blocks, or 30-minute blocks" with pause and resume ([CuePoint](https://www.cuepoint.cloud/)). BilliardPOS prorates across rate bands that cross midnight ([BilliardPOS](https://billiardpos.net/en/)). QubicaAMF opens lanes "per lane or per bowler" ([Conqueror X](https://qubicaamf.com.au/conqueror-x-management-system/)). Chinese KTV suites sell per-person hourly rates (按人头钟点费) ([乾元坤和](https://www.qykh2009.com/sol_help_3.html)). The earlier report said no system documents per-minute billing; that holds only for karaoke rooms.
2. **Booking → session → tab already exists as a stack.** KaraFun's API creates sessions from SevenRooms bookings ([KaraFun](https://business.karafun.com/api-integrations)). GoTab opens a tab with the guest's payment ready when a Rex booking checks in, and applies the deposit ([GoTab partners](https://gotab.com/partners/reservations-and-waitlist); [GoTab API](https://docs.gotab.io/reference/reservation-integration)). Singa Booking and the ROLLER–Singa link turn a room on when the booking starts ([Singa](https://singa.com/blog/singa-booking/); [Singa](https://singa.com/blog/karaoke-room-reservation-software/)).
3. **TJ Media sells its own noraebang POS.** TPOS hardware (the TPOS-15H lists at ₩770,000 at a retailer) and an app that shows each room's remaining time and adds time or coins from a phone ([App Store](https://apps.apple.com/kr/app/tj-%EB%85%B8%EB%9E%98%EB%B0%A9-pos/id6447156787); [JY21](https://m.jy21.com/product/tj%EB%AF%B8%EB%94%94%EC%96%B4-tpos-15h-%EB%85%B8%EB%9E%98%EB%B0%A9-%EA%B4%80%EB%A6%AC%EA%B8%B0/858/display/1/)).
4. **A small US rival targets KTVs directly.** VenueTap POS claims "room timers for KTV, screen golf, and private event rooms — per-hour rates by day and time, count-up or count-down billing," QR ordering, a KDS, a kiosk and an in-store hub that keeps selling offline; pricing is by quote, and its public desktop repo has 15 stars ([GitHub](https://github.com/kyunghoon5/venuetappos-desktop); [VenueTap](https://venuetappos.com)). With iTab, it's the closest direct competitor found.
5. **SevenRooms is owned by DoorDash** since June 13, 2025 ([Wikipedia](https://en.wikipedia.org/wiki/SevenRooms)).
6. **WeChat Pay works for US Stripe accounts**, including as a QR code on Terminal smart readers, but it has no manual capture, and Connect direct charges are a private preview ([Stripe](https://docs.stripe.com/payments/wechat-pay); [Stripe Terminal](https://docs.stripe.com/terminal/payments/additional-payment-methods.md?terminal-sdk-platform=server-driven)).

## The competitor groups

| Group | Reviewed | What it does well for karaoke | Where it stops | Price seen |
| --- | --- | --- | --- | --- |
| Restaurant and bar POS | Toast, Square, Clover, SpotOn, Lightspeed | Tabs, handhelds with a built-in reader ([Toast Go 3](https://pos.toasttab.com/hardware/toast-go)), kitchen screens, gift cards, loyalty, SMS campaigns, scheduling, QR order-and-pay, offline card payments | No room sessions: a pool-hall vendor says Square and Clover have "zero concept of table sessions" ([CuePoint](https://www.cuepoint.cloud/blog/best-pos-system-for-pool-halls)); Toast allows one pre-authorized card per check and "cannot currently send multiple increments" ([Toast](https://support.toasttab.com/en/article/Preauthorized-Cards-Decline-When-Closing)) | Toast $0 or $69/terminal; Square $0–$149 plus $20–$30 per kitchen screen ([Square KDS](https://squareup.com/us/en/point-of-sale/restaurants/kitchen-display-system)); SpotOn $0 or $55/station ([SpotOn](https://www.spoton.com/restaurant-pos/nightclub-and-bar/)) |
| Bar, nightlife and karaoke-bar POS | GoTab, iTab, VenueTap | GoTab grows the hold with each order, blocks a guest with an unpaid tab at other GoTab venues and lets guests order, share, split and close tabs on their phones ([GoTab](https://gotab.com/latest/gotabs-loss-prevention-features); [Easy Tab](https://gotab.com/latest/gotab-unveils-easy-tab-a-new-feature-that-helps-servers-and-bartenders-seamlessly-bridge-mobile-order-and-pay-at-table-with-traditional-service)). iTab claims room bookings, "guest timing", room ordering, loyalty and gift cards ([iTab](https://www.itabpos.com/karaoke-bars-restaurants-pos/)) | GoTab documents no room clock. iTab and VenueTap document no billing mechanics, deposits or song control | GoTab $15, $99 or $229/month plus 2.40% + 15¢ ([GoTab](https://gotab.com/compare)); iTab from $65/month; VenueTap by quote ([VenueTap](https://venuetappos.com/pricing)) |
| Karaoke platforms and KJ apps | KaraFun Box, Singa Business, SongbookDB, RequestSongs, KTV SILVER | Session timers, a locked room between sessions, sessions started from bookings, phone remotes and requests, battles and quizzes. KJ apps alert singers, take tips, sell priority and feed Karaoki's rotation | No payments, POS or ordering: Singa's own comparison finds none of six platforms advertise them ([Singa](https://singa.com/blog/best-karaoke-software-for-business/)); Singa Booking's prepayment is "coming soon" ([Singa](https://singa.com/blog/singa-booking/)) | KaraFun Box $199/room/month ([KaraFun](https://business.karafun.com/box/)); Singa from $59/month; SongbookDB $19.95/month (2014 price); RequestSongs takes a 10–17% platform fee |
| Noraebang POS | TJ Media TPOS and TJ 노래방 POS app, USISNET card payments, TJ매니저 | Adds time or coins to TJ machines from the counter or a phone; shows each room's remaining time, payment status and service history; card payment at the machine with a choice of coin or time pricing ([USISNET](https://www.usisnet.co.kr/smain/smain0203.html)) | Korean-market product; no booking, bar tabs or US compliance documented; three phones per TPOS; App Store reviewers report crashes and login problems | TPOS-15H ₩770,000 |
| Chinese KTV suites | K米 (a Star-net Ruijie company), Evideo 视易 song servers, Thunderstone 雷石, 乾元坤和, Nakesoft | Room states with open, transfer and merge; per-person hourly and minimum-spend billing; extensions paid ahead with refunds; bottle keep with expiry reminders; sales-manager commissions; stored-value cards; voucher redemption; online booking and mobile pay; an owner's app ([K米 change log](https://open-doc.ktvme.com/read/jingtong/version_update)) | China market: Chinese-only documents, China wallets and Douyin vouchers ([K米](https://open-doc.ktvme.com/read/fwydd/dyqkf)); no US card processing or New York rules | Not published |
| Booking tools | Bookeo, Resova, Funbutler, Rex, TicketingHub, Square Appointments, Xola | Deposits, cancellation rules, reminders, gift vouchers, discount codes, abandoned-basket recovery, add-ons, day-and-time pricing, split payments | Stop at the booking and hand off to a POS: Rex pairs with GoTab or Square, and Funbutler "connects to your POS" ([Rex](https://www.reservewithrex.com/blog/rex-vs-centeredge-venue-management-platform); [Funbutler](https://funbutler.com/industries/karaoke-booking-software)). No live room clock | Rex from $295/month; Resova $40–$135; TicketingHub 3% per booking ([TicketingHub](https://www.ticketinghub.com/en-US/industries/karaoke-room-booking-software)); Square Appointments Premium $90/month for room resources ([Square](https://squareup.com/au/en/appointments/features/resource-booking)) |
| Timed-venue suites | CenterEdge, ROLLER, QubicaAMF Conqueror X and BES NV, Brunswick Sync, CuePoint, BilliardPOS, golf-bay booking (Golf O'Clock, Trackman, Skedda) | Time billing with rounding, pause and rate bands; equipment that follows the clock (table lights, smart plugs, lane control); ordering from the lane; self-extension by QR; kiosks; memberships, prepaid hours, gift cards and CRM | No song queue, no song-system control, no bar acceptance of room alcohol orders, no New York bar rules. Reviewers call ROLLER "Horrifically overpriced" ([Capterra](https://www.capterra.com/p/164715/ROLLER/reviews/)) and CenterEdge "complicated" ([Capterra](https://www.capterra.com/p/114604/CenterEdge-Advantage/reviews/)) | CenterEdge $300–$800/month, bundled with its payments ([CenterEdge](https://centeredgesoftware.com/pricing/)); CuePoint free to $37.50; BilliardPOS $39–$99; ROLLER by quote |
| Nightlife reservations and CRM | SevenRooms, Tablelist Pro, UrVenue | Minimum-spend tracking against the tab, upgrades sold in the booking, deposits, ticketing, guest lists, CRM tags, promoters, 3D maps, demand pricing. UrVenue books "karaoke rooms to bowling lanes" in one cart ([UrVenue](https://www.urvenue.com/who-we-serve/mixed-use-entertainment-venues/)) | Need a separate POS. Tablelist's own guide says POS systems "are not reservation or guestlist systems" and should be paired with one ([Tablelist](https://www.tablelistpro.com/blog/best-nightclub-software)). G2 reviewers call SevenRooms "very expensive" ([G2](https://www.g2.com/products/sevenrooms/reviews)) | By quote |

## Ranked gaps

Ranked by impact on revenue, staff time and guest experience, weighted by how many venue types feel it. "Phase" is our recommendation.

| ID | Gap | Impact | Who feels it | Phase |
| --- | --- | --- | --- | --- |
| K1 | The song player locks, starts and warns from our clock | High · revenue, staff time | Every room venue | Trial in P1; adapters P2 |
| K2 | Guests pay their own share from their phones | High · staff time at close, guests | Every room venue | **P1** |
| K3 | Packages and add-ons sold in the booking, prepaid | High · revenue | Room venues; Koreatown bottle service most | P2 |
| K4 | Minimum spend per room, tracked live | Medium-high · revenue, guests | VIP rooms, KTVs, bottle service | Data model P1; screens P2 |
| K5 | Gift cards, stored-value cards, prepaid hours | Medium-high · revenue | All; expected in Flushing | Ledger P1; gift cards P2; stored value P3 |
| K6 | Bar mode that tells singers they're up, plus KJ tools | Medium-high · guests, KJ time | Bar-style venues and hybrids (West 4) | Alerts and songbook **P1**; tips, priority P2 |
| K7 | Inventory counts, automatic 86 and pour-cost data | Medium-high · revenue leakage, staff time | All | P2 |
| K8 | Noraebang readiness: TJ machine time and "service time" | High for TJ venues · staff time | Koreatown and Queens noraebang on TJ | P3 |
| K9 | Flushing KTV readiness: host commissions, bottle keep, WeChat Pay, room merges | High for KTVs · revenue, staff time | Queens and Brooklyn Chinese KTVs | Two data-model items P1; rest P3 |
| K10 | Card payments when the venue is offline, and a track record | Medium-high · revenue at risk | All | P1 gate; native app P2 |
| K11 | Guest CRM, loyalty and marketing automation | Medium · revenue | All | Profiles P2; loyalty, campaigns P3 |
| K12 | Booking conversion: codes, split deposits, abandoned bookings, Google | Medium · revenue | Room venues | P2; Google P3 |
| K13 | Time bands for every pricing mode, and billing increments | Medium · revenue, fit | Flat-rate and base-plus-guest venues | Data model P1 |
| K14 | Kitchen display parity | Medium · staff time | Kitchen venues | P2 (planned) |
| K15 | One handheld that takes the order and the card | Medium-low · staff time | All | P2, with the native app |
| K16 | "Order again" on the guest room page | Medium-low · revenue | Every room venue | **P1** |
| K17 | Guests extend, or move to a free room, themselves | Low-medium · revenue | Room venues | P2 |
| K18 | Events and ticketing | Low-medium · revenue | Bar-style and hybrids | P3 |
| K19 | Online ordering, takeout and delivery | Low · revenue | Kitchen venues | Later |
| K20 | Scheduling and labor forecasting | Low · manager time | All | Later (7shifts covers it) |
| K21 | Automatic answers to guest inquiries | Low · staff time | All | Later |

### K1 · The song player locks, starts and warns from our clock

- **Elsewhere.** KaraFun's Blocked Mode makes the iPad "inaccessible, the sound is muted, and no one can sneak in extra songs" until the next session, which unlocks by itself ([KaraFun](https://business.karafun.com/resources-start-karaoke-business/1548-blocked-mode-lock-down-your-karaoke-rooms-between-sessions.html)). Staff "schedule, start, and adjust" sessions from a dashboard ([KaraFun Box](https://business.karafun.com/box/)), and guests "will be notified of their last song, after which they will no longer have access to the song list" ([KaraFun](https://business.karafun.com/resources-start-karaoke-business/1203-how-do-karaoke-boxes-work.html)). Singa "turns on the room when a booking starts, with no manual code entry" ([Singa](https://singa.com/blog/singa-booking/)). TJ's counter app adds time or coins to a room's machine and shows its remaining time ([App Store](https://apps.apple.com/kr/app/tj-%EB%85%B8%EB%9E%98%EB%B0%A9-pos/id6447156787)). Outside karaoke, the clock drives the hardware: BilliardPOS runs "automatic table lights" ([BilliardPOS](https://billiardpos.net/en/)), Skedda switches golf simulators on and off with bookings through a smart plug ([Skedda](https://support.skedda.com/en/articles/12029787-how-to-automatically-turn-your-golf-simulator-on-and-off-with-bookings)), Golf O'Clock integrates "doors, simulators and smart outlets" ([Golf O'Clock](https://golfoclock.com/)), and Chinese self-service KTVs cut power after a delay the manager sets ([Sohu](https://www.sohu.com/a/866156648_121950269)).
- **Us.** Phase 1 runs every song system as `none`: a countdown on our room tablet and alerts to staff. KaraFun is the first adapter in phase 2, Playbox needs a signed agreement, and TJ has no adapter.
- **What it changes.** At West 4 the warning lives on the room tablet and in a "please wrap up" text, not on the TV the party is watching, and after close-out nothing stops the next song while the room waits for a wipe. A KaraFun or TJ room handles both by itself.
- **Close it.** Keep the Playbox talks (already on the blueprint's Start now list) and ship the KaraFun adapter in P2. For players with no API, add a vendor-neutral fallback that uses only our own hardware: a switched outlet or relay on each room's wireless-mic receiver (not the player), on at check-in and off at close-out or cleaning, and left on whenever our server can't be reached. Trial it in one West 4 room during P1, only with West 4's approval and after asking Playbox about equipment warranty.

### K2 · Guests pay their own share from their phones

- **Elsewhere.** Toast Mobile Order & Pay lets guests "evenly split a check across other guests," and a check split on the POS gives each guest "their own itemized check" with its own QR code ([Toast](https://support.toasttab.com/en/article/Toast-Mobile-Order-and-Pay-FAQs)). GoTab guests "close out and split the tab on their own on their mobile device" ([GoTab](https://gotab.com/latest/gotab-unveils-easy-tab-a-new-feature-that-helps-servers-and-bartenders-seamlessly-bridge-mobile-order-and-pay-at-table-with-traditional-service)). Square prints a pay QR on the check on its Plus and Premium plans ([Square](https://squareup.com/help/us/en/article/8456-checkout-with-scan-to-pay)). Brunswick's lane tablets take "immediate payment" ([Brunswick](https://brunswickbowling.com/bowling-centers/equipment-parts-supplies/center-operations/sync/sync-pay/sync-pay-hardware/on-lane-ordering)).
- **Us.** An even split runs share by share on the reader; splitting by item happens on the room tablet, and the card on file is charged only when its owner confirms from the room or the booking link. West 4 has one card reader, at the front desk.
- **What it changes.** A party of 12 leaving at 3:45 AM stops queuing at one reader while other rooms wait to close out.
- **Close it.** "Pay my share" on the room page: each guest picks their items or an even share and pays with Apple Pay, Google Pay or a card through the Payment Element the booking page already uses, with their share of tax and gratuity shown. The booker's card still guarantees the rest. Online card pricing (2.9% + 30¢ against 2.7% + 5¢ in person) makes it a venue setting. It fits milestone 3 of phase 1.

### K3 · Packages and add-ons sold in the booking, prepaid

- **Elsewhere.** SevenRooms upsells "premium table upgrades, welcome drinks or curated tasting menus directly within the online booking flow" and claims a 50% rise in per-cover spend (vendor claim) ([SevenRooms](https://sevenrooms.com/platform/events-experiences/)). Toast Tables charges prepayments and add-ons at booking ([Toast](https://support.toasttab.com/en/article/Get-Started-Toast-Tables-Deposits)). QubicaAMF's web booking takes payment up front with food and drinks pre-ordered ([QubicaAMF](https://www.qubicaamfbowling.com/products/management-operations/conqueror-web-kiosk)), and CenterEdge makes party food "arrive perfectly timed" ([CenterEdge](https://centeredgesoftware.com/products/advantage-events/event-bookings/)). Funbutler sells "drink bundles or extended session time" in the booking, as do Rex and Bookeo ([Funbutler](https://funbutler.com/industries/karaoke-booking-software); [Rex](https://www.reservewithrex.com/industries/karaoke); [Bookeo](https://www.bookeo.com/tours/karaoke-ticket-booking-software/)).
- **Us.** Packages are To build (S2). West 4's parties page lists five drink packages ($70–$680) that guests order once they're in the room; the booking takes only the deposit.
- **What it changes.** The spend is committed before arrival, and the bottle and buckets are waiting when the party walks in. Koreatown bottle packages run $390–$5,200 (blueprint).
- **Close it.** Sell packages from the booking page, checked by the promotion rules already in the rule pack, fired at room start and applied against the deposit. Ship before the Koreatown pilot.

### K4 · Minimum spend per room, tracked live

- **Elsewhere.** SevenRooms is built for "managing minimums and tracking table spend in real time" ([SevenRooms](https://sevenrooms.com/nightclubs-bars/)). K米's order screen shows each room's minimum spend (低消费用), and its room-status feed carries the room minimum ([K米](https://open-doc.ktvme.com/read/jingtong/version_update)). UrVenue sells reservations "with food & beverage minimums" ([UrVenue](https://www.urvenue.com/who-we-serve/bars-and-lounges/)).
- **Us.** Only the big-party rule has a minimum spend, and a shortfall appears as a `min_spend` line at close.
- **What it changes.** Staff and guests see "$84 to your minimum" on the tile and the room page and can order toward it, instead of meeting a surprise line at checkout.
- **Close it.** In the P1 data model, a minimum per room tier, day and band in `prices`; in P2, progress on the tile, room page and receipt.

### K5 · Gift cards, stored-value cards and prepaid hours

- **Elsewhere.** Toast sells physical and eGift cards redeemable on the POS and online ([Toast](https://support.toasttab.com/en/article/getting-started-with-toast-gift-cards)); so do ROLLER, iTab, Resova and Bookeo ([ROLLER](https://www.roller.software/features); [Resova](https://get.resova.com/features/feature/all-features/)). Golf O'Clock and Trackman sell punch cards and prepaid hours ([Golf O'Clock](https://golfoclock.com/); [Trackman](https://www.trackman.com/lp/trackman-booking-payments)). Chinese KTV suites sell stored-value member cards online with top-up offers (会员充值送券) ([K米](https://open-doc.ktvme.com/read/jingtong/version_update); [Nakesoft](https://www.nakesoft.com/hyzx/5422.html)).
- **Us.** N2, To build.
- **What it changes.** A "birthday room for six" gift is sold online in December; a Flushing regular tops up once and pays for rooms from the balance.
- **Close it.** A prepaid-value liability account in the money rules from P1 (issued, redeemed, expired, refunded); gift cards in P2, before the first holiday season after go-live; stored value with top-up offers in P3.

### K6 · Bar mode that tells singers they're up, plus KJ tools

- **Elsewhere.** SongbookDB "BUZZ" alerts singers when their song is ready, takes "Tip the DJ" payments of $1–$10 and offers a kiosk for singers without phones ([PCDJ](https://pcdj.com/songbookdb-tip-the-karaoke-host/)), and its requests reach Karaoki's rotation in one click or automatically ([PCDJ](https://www.pcdj.com/pcdj-songbookdb-partnership/)). RequestSongs texts requesters when "their song is coming up" and lets guests "pay extra to bump requests to the top" ([RequestSongs](https://requestsongs.co/)). Singa shows upcoming singers "with or without time estimates" ([Singa](https://help.singabusiness.com/controlling-the-queue-and-song-requests)).
- **Us.** A phone queue with round-robin rotation and a per-singer limit, the Up next TV and a per-song charge when the song starts. Singers give a phone number, but no text template tells them they're next, so they have to watch the TV or the queue page. The songbook needs a vendor catalog file, so a KJ's own library can't be searched, and Karaoki KJs copy songs from our queue by hand.
- **What it changes.** The KJ stops calling names over the mic, and singers at the rail stop missing their turn.
- **Close it.** In P1: "2 singers before you" and "You're up" as a push on the queue page and a service text, and a CSV upload for KJ songbooks. In P2: tips to the KJ under the venue's tip rules, an optional paid-priority setting (off by default, since it cuts across fair rotation), and Karaoki only through a PCDJ partnership.

### K7 · Inventory counts, automatic 86 and pour-cost data

- **Elsewhere.** When an item's count reaches zero, Toast "automatically changes the inventory status to Out of Stock" ([Toast](https://doc.toasttab.com/doc/platformguide/adminMenuItemInventoryOverview.html)). BinWise compares "theoretical vs. actual usage" from POS sales, sets par levels, turns counts into purchase orders and reads invoices, with 50+ POS integrations ([BinWise](https://home.binwise.com/binwise-pro)). CenterEdge has inventory and recipes ([Rex](https://www.reservewithrex.com/blog/rex-vs-centeredge-venue-management-platform)); BilliardPOS deducts stock on each sale and warns when it runs low; Nakesoft covers stock in and out (进销存).
- **Us.** Not among the 28 modules (it's the gap report's S9). Staff mark items out by hand on the bar orders screen.
- **What it changes.** The last bottle 86s itself on every room screen, and the manager sees which drinks leak money.
- **Close it.** In P2, item counts with automatic 86 on every channel, plus a nightly sales feed or export that BinWise or Backbar can import; full inventory later.

### K8 · Noraebang readiness: TJ machine time and "service time"

- **Elsewhere.** TJ's app shows each room's "remaining time/coins, payment status, service history" and handles "time/coin input sales and service sales" from a phone, for up to three phones per TPOS ([App Store](https://apps.apple.com/kr/app/tj-%EB%85%B8%EB%9E%98%EB%B0%A9-pos/id6447156787)). USISNET lets guests pay by card at the machine and choose coin or time pricing ([USISNET](https://www.usisnet.co.kr/smain/smain0203.html)). TJ매니저 sends text to the machine's screen ([TJ Media](https://www.tjmedia.com/support/app)). Counter staff give free "service time" at their discretion ([Namu Wiki](https://namu.wiki/w/%EB%85%B8%EB%9E%98%EB%B0%A9%20%EC%95%84%EB%A5%B4%EB%B0%94%EC%9D%B4%ED%8A%B8)).
- **Us.** TJ runs as `none`, so staff would set time on the TJ machine and again on our clock. Comps are item lines, and pausing the clock needs approval.
- **Close it.** A partnership with TJ Media or its US distributor for time input and room status, and a "+10 service minutes" action with a reason-only limit (P2). Until then, don't claim to beat TJ's own counter in TJ rooms. Still unverified: whether New York noraebang run TPOS. The app is also listed in the US App Store, so ask during pilot outreach.

### K9 · Flushing KTV readiness: host commissions, bottle keep, WeChat Pay, room merges

- **Elsewhere.** K米's change log shows sales-manager commission reports (销售经理提成), bottle storage for whole or part bottles, tracked by sales manager, with expiry reminders (寄存预过期提醒), online membership sales and top-ups, room transfers and merges (转房, 并房), and extensions paid ahead with refunds ([K米](https://open-doc.ktvme.com/read/jingtong/version_update)). K米 also runs online booking ([K米](https://open-doc.ktvme.com/books/zxyd)) and opens rooms from Douyin vouchers. 乾元坤和 adds charge-to-account (挂帐) and per-person buyouts ([乾元坤和](https://www.qykh2009.com/sol_help_3.html)). Stripe takes WeChat Pay for US accounts, including a QR on the reader, but not with manual capture, and Connect direct charges need an invite ([Stripe](https://docs.stripe.com/payments/wechat-pay)).
- **Us.** A WeChat link on the booking page, with staff re-entering those bookings. No commissions, bottle keep, stored value, room merges or WeChat Pay.
- **Close it.** In the P1 data model: a "booked by / host" field on bookings and sessions, and merging two sessions onto one check with their holds kept. In P3, before the Flushing pilot: a commission report, WeChat Pay at close-out on readers and the pay page (ask Stripe for the capability), stored value (K5), and bottle keep only after the owner's lawyer approves it.

### K10 · Card payments when the venue is offline, and a track record

- **Elsewhere.** Toast keeps taking card payments in offline mode, though not holds ([Toast](https://support.toasttab.com/en/article/Using-Toast-in-Offline-Mode)); Square accepts offline payments that upload within 72 hours ([Square](https://squareup.com/help/us/en/article/7777-process-card-payments-with-offline-mode)); SpotOn's offline mode "automatically kicks in" ([SpotOn](https://www.spoton.com/restaurant-pos/nightclub-and-bar/)); VenueTap's hub "keeps selling through internet outages".
- **Us.** A dual-WAN router and cellular S710 readers keep us online through most outages. If both links or our cloud go down, orders queue under an offline code and cards go through Tap to Pay on a manager's phone. There are no stored offline card payments until a native app (a P2 decision), and no live nights yet.
- **Close it.** The P1 gate already requires an outage drill and 4 weeks without a money error. Decide the native app early in P2, and publish uptime and overnight support.

### K11 · Guest CRM, loyalty and marketing automation

- **Elsewhere.** SevenRooms tags VIPs automatically, sets "Perks for big spenders" and sends email campaigns ([SevenRooms](https://sevenrooms.com/nightclubs-bars/)). Toast Loyalty earns by visit or by dollar ([Toast](https://support.toasttab.com/en/article/Getting-Started-Toast-Loyalty)), and Toast SMS runs "We Miss You", "Big Spender" and post-visit campaigns inside 8 AM–9 PM quiet hours ([Toast](https://support.toasttab.com/en/article/Get-Started-With-SMS-Marketing)). SpotOn runs Marketing Assist and loyalty, Golf O'Clock automates "reminders, win-backs, loyalty credits", and ROLLER and QubicaAMF have CRM and loyalty.
- **Us.** N3, To build. Marketing texts wait for the consent module, and there's no email.
- **What it changes.** West 4's soft Tuesday ($1.9K on the Reports screen) gets a targeted offer to past weekday parties.
- **Close it.** Guest profiles with visits, spend, party size and room, kept apart from ID scans, in P2; loyalty and campaigns in P3, once marketing consent is live.

### K12 · Booking conversion: codes, split deposits, abandoned bookings, Google

- **Elsewhere.** Resova lists "Discount Codes", "Basket Abandonment", "Daily Deals Integration" and "Payment Links" ([Resova](https://get.resova.com/features/feature/all-features/)). Bookeo prices by day and time and runs promotions ([Bookeo](https://www.bookeo.com/tours/karaoke-ticket-booking-software/)). Xola and Bookteq's PaySplit let the party split the payment ([Xola](https://www.xola.com/articles/how-to-find-the-best-online-booking-software-for-tours-and-activities-in-2025/); [Bookteq](https://www.bookteq.com/introducing-payment-splitting-from-bookteq/)). Rex, UrVenue and ROLLER price by demand, and SevenRooms has been on Google Search and Maps since 2018 ([Wikipedia](https://en.wikipedia.org/wiki/SevenRooms)).
- **Us.** Deposits and self-service changes and cancellations. No codes, split deposits, abandoned-booking follow-up or booking channels beyond partner programs.
- **What it changes.** A VIP birthday organizer sends friends a link to pay their part of the $250 deposit, and a Tuesday code fills rooms.
- **Close it.** In P2, codes and dated offers through `price_rules` with the promotion checks, split-deposit links, and an abandoned-booking text only with consent. Reserve with Google through a partner in P3.

### K13 · Time bands for every pricing mode, and billing increments

- **Elsewhere.** BilliardPOS charges "different hourly rates by day of the week and time of day ... overnight bands that cross midnight" and prorates across them ([BilliardPOS](https://billiardpos.net/en/)). CuePoint rounds to exact time, 15-minute or 30-minute blocks, with minimum charges ([CuePoint](https://www.cuepoint.cloud/blog/best-pos-system-for-pool-halls)). K米 sets hourly rates by time slot (时段钟点费), and VenueTap claims "per-hour rates by day and time".
- **Us.** `bands` hold only `perPersonCents`, so a flat-by-size venue ($40 an hour in Flushing) or a base-plus-extra venue (POP's $55–$60 for four, plus $8 a guest) can't have a cheaper afternoon. Billing after the first hour is always per minute.
- **Close it.** Decide in the P1 data model: bands carry the amounts of the venue's own rate mode, plus a billing increment (1, 15, 30 or 60 minutes) and a rounding rule, so every check revision stores them from day one.

### K14–K21 · Smaller gaps

| ID | Elsewhere | Us | Close it |
| --- | --- | --- | --- |
| K14 · Kitchen display parity | Toast's KDS has an expediter screen, all-day counts, recall, production counts, local-network operation in an outage and productivity reports ([Toast](https://support.toasttab.com/en/article/Get-Started-With-the-Kitchen-Display-System)); Square's has timers, alerts, an expeditor mode and prep-time reports | Kitchen module To build: stations, holds, coursing, package food at room start, allergies, 86 by option | Add all-day counts, recall, local-network fallback and a prep-time report to the kitchen spec before the Flushing pilot (P2) |
| K15 · One handheld for order and card | Toast Go 3 takes "tap, dip, swipe, and NFC payments" with cellular, IP65 and a 5 ft drop rating; SpotOn's handheld opens tabs and closes out "from anywhere"; QubicaAMF's QPad runs lanes, waitlists and food | Staff phones ring room orders and runs; payment needs a separately carried S710; Tap to Pay on staff phones needs a native app | Tap to Pay on staff phones if P2 adds the native app |
| K16 · "Order again" on the room page | Toast Mobile Order & Pay offers "Order Again" on each item, a reorder group and "Quick Reorder" | Staff have Repeat round; guests re-find items in a 127-item menu | **P1**: one "Same again" row on the room page |
| K17 · Guests extend or move themselves | QubicaAMF's "Extend Your Play" by QR at the lane ([RePlay](https://www.replaymag.com/qubicaamf-launches-new-scoring-system/)); Chinese self-service KTVs take pay-to-extend and recalculate fees; Anest takes extension requests from the room | The clock keeps running by the minute if nobody's waiting; otherwise staff text "please wrap up" | P2: "Stay longer" on the room page that offers the next free room when this one is booked |
| K18 · Events and ticketing | SevenRooms ticketed events and prepaid experiences; Tablelist and UrVenue ticketing with QR entry; SpotOn Experiences with deposits ([SpotOn](https://www.spoton.com/solutions/experiences/)) | Private-party enquiries only (N1) | P3, for contests, theme nights and covers |
| K19 · Online ordering, takeout, delivery | Toast Online Ordering; Brunswick Sync online ordering "for takeout"; GoTab, whose reviewers say delivery-app onboarding is hard ([Capterra](https://capterra.com/p/215393/GoTab-POS/reviews/)) | A to-go dining option at the kitchen | Later, for kitchen venues |
| K20 · Scheduling | Toast builds schedules from sales forecasts, with shift swaps and overtime alarms ([Toast](https://pos.toasttab.com/products/restaurant-employee-scheduling-software)); SpotOn Teamwork | Time clock plus a 7shifts export | Later; the integration is enough |
| K21 · Automatic answers to inquiries | ROLLER's Guest Experience Agent claims to "answer every guest inquiry and capture more bookings" ([ROLLER](https://www.roller.software/features)); Golf O'Clock's AI assistant | A two-way inbox with quick replies | Later |

## Where we're clearly better

These are design advantages backed by the competitors' own documents. None is proven until West 4 runs live nights; the earlier report's eleven documented seams against Toast and Square still stand and aren't repeated here.

| # | Advantage | Evidence from competitors' documents | Caveat |
| --- | --- | --- | --- |
| 1 | **Rooms, bar and bookings on one check, priced the karaoke way.** Per-person rate × minutes, headcount minimums, a first-hour minimum, per-minute overage, the deposit applied at check-in, and the math shown on the tile, the room page and the receipt | Toast, Square and Clover have "zero concept of table sessions" ([CuePoint](https://www.cuepoint.cloud/blog/best-pos-system-for-pool-halls)). Square books rooms as appointment resources on the $90 Premium plan, and nothing in its documents bills the time actually used ([Square](https://squareup.com/au/en/appointments/features/resource-booking)). KaraFun and Singa bill nothing ([Singa](https://singa.com/blog/best-karaoke-software-for-business/)), and KaraFun's guide sends venues to Toast or Lightspeed ([KaraFun](https://business.karafun.com/resources-start-karaoke-business/1223-best-apps-to-run-a-karaoke-box-business.html)). Booking tools hand off to a POS. iTab claims "guest timing" and documents no mechanics | Pool, bowling and Chinese KTV software already bill by time and per person, VenueTap claims KTV timers, and KwickOS markets "booking, timed session, and bar on a single check" ([KwickOS](https://kwickos.com/blog/entertainment-venue-pos-membership.html)). The edge is the karaoke-specific combination with New York rules, not time billing |
| 2 | **Room orders that can't be missed or served past the law.** An accept gate with the ID count, aging colors, escalation to phones, the alcohol window on every channel, and a runner's "couldn't serve" path | Toast Mobile Order & Pay orders route by standard print routing, and guests "cannot edit" an order once submitted, where ours can cancel until the bar accepts ([Toast](https://support.toasttab.com/en/article/Toast-Mobile-Order-and-Pay-FAQs)). KaraFun tells venues to "hook up an order system". Anest, Brunswick and QubicaAMF route orders to printers with no acceptance step documented. Toast's auto-close runs at a 4 AM default and books unpaid checks as revenue (earlier report) | Acceptance adds a step at the bar; the timed staff trial must show it stays under 2 minutes on a busy night |
| 3 | **Bar tabs that don't break at 4 AM.** Holds that grow, one tab per card, tips on the reader captured with the tab, and last call in one confirmation | Toast: "Each check can contain only one pre-authorized card" and "pre-authorized checks will not close automatically" ([Toast](https://support.toasttab.com/en/article/Card-Pre-Authorization-FAQs)). Square's holds are fixed, and slip tips settle at $0 after 36 hours; Clover's incremental holds have been "Started" since April 2025 (earlier report) | GoTab also grows holds with each order and blocks guests with unpaid tabs ([GoTab](https://gotab.com/latest/gotabs-loss-prevention-features)), and SpotOn advertises incremental holds, so this is parity with them |
| 4 | **Nothing waits for a manager.** Approvals on the approver's own phone and reason-only limits | Toast asks for a manager passcode or swipe on the same device, and Square for a passcode (earlier report) | SpotOn's brochure advertises remote approvals, so this is parity with SpotOn |
| 5 | **Built for New York's crews and guests.** Staff pick English, Spanish, Korean or Chinese; guest screens in Korean and Chinese | KaraFun Box's interface ships in English, Dutch, French, German, Italian and Spanish ([App Store](https://apps.apple.com/us/app/-/id1594346411)); TJ's apps are Korean and K米's documents Chinese; MenuSifu shows menus in English, Spanish, Chinese or French ([MenuSifu](https://www.menusifu.com/restaurant-type-bar-ktv)) | Korean and Chinese screens are P2 in the blueprint, so West 4 opens in English |
| 6 | **One system at a published price.** $249 + $12 a room ($417 for 14 rooms), month-to-month, website included | The nearest full stacks are three contracts: SevenRooms (by quote) with KaraFun Box ($199 a room) and GoTab ($99–$229), or Rex (from $295) with GoTab. CenterEdge ties its $300–$800 plans to its own payments, and ROLLER and SevenRooms draw price complaints | Rex plus GoTab Pro is about $394 a month, close to ours, so we win on function, not price. KaraFun's fee includes songs; ours doesn't |
| 7 | **Safety in closed rooms.** A discreet help alert from guests' own phones that never shows on the room screen, welfare timers and an incident log | QubicaAMF's "Smart Service Call" and K米's room calls (包厢呼叫) are ordinary service calls; no karaoke, booking or POS document reviewed describes a private alert | Absence from documents isn't proof of absence |
| 8 | **Licensing evidence per room.** A song-play log per room and tab | Singa's song history has no singer names ([Singa](https://help.singabusiness.com/controlling-the-queue-and-song-requests)); KaraFun's dashboard shows most-played tracks ([KaraFun](https://business.karafun.com/box/)) | Without an adapter, the log depends on staff tapping "started" |

## Where "better than any other POS for karaoke venues" doesn't hold today

| Where | Who's ahead today, and how | What closes it | When |
| --- | --- | --- | --- |
| Everywhere | Nothing of ours is live, and 19 of 28 modules are To build. Incumbents have years of hardening and 24/7 support, and Toast, Square and SpotOn take cards offline | The P1 gate (4 weeks without a money error, an outage drill), overnight support, and the native-app decision for offline cards (K10) | P1 gate; P2 |
| Room venues on KaraFun or Singa | KaraFun with SevenRooms and GoTab already chains booking, session and tab; Singa Booking and ROLLER turn rooms on at the booked time | The KaraFun adapter first; Singa through a partner deal (K1) | P2 |
| West 4 and other Playbox venues | Nobody controls Playbox rooms publicly, but Sing Sing Media, Playbox's New York partner, lists its own POS ([Sing Sing Media](https://www.singsingmedia.com/)); if it adds room control, it's ahead at Playbox venues | The Playbox agreement (Start now), and the vendor-neutral outlet on the mic receiver as a fallback (K1) | Trial P1; P2 |
| Koreatown and Queens noraebang on TJ | TJ's own POS adds time and coins to the machine from phones, shows remaining time and takes cards at the machine | A partnership with TJ Media or its US distributor, and "service minutes" (K8). Until then, pitch only the parts TJ lacks: booking, deposits, bar tabs, New York rules | P3 |
| Flushing KTVs | Chinese KTV suites run host commissions, bottle keep, stored-value cards, minimum spend on the order screen, room merges, WeChat booking and mobile pay | K9, K5, K4 and K14 | P3, with two P1 data-model items |
| Bar-style KJ nights | SongbookDB feeds requests into Karaoki's rotation, buzzes singers and takes tips; RequestSongs texts singers and sells priority | Singer alerts and a KJ songbook upload (P1), the OpenKJ adapter (P2), and Karaoki only through PCDJ (K6) | P1; P2 |
| Breadth against Toast, Square, SpotOn and iTab | Gift cards, loyalty, SMS and email campaigns, automatic 86 from counts, kitchen screens, one-device handhelds, online ordering, scheduling | K5, K7, K11, K14, K15, plus BinWise and 7shifts integrations | P2–P3 |
| VIP and bottle-service rooms | SevenRooms, UrVenue and Tablelist track minimum spend, sell upgrades in the booking, ticket events and tag big spenders | K3, K4, K11, K12, K18 | P2–P3 |

## Phase 1 at West 4

**Add to phase 1** (small, and each matters at West 4 on day one):

1. **K2 · Pay my share** on the room page, reusing the booking page's Payment Element (milestone 3).
2. **K6 · "You're up" alerts** as a queue-page push and a service text, plus a **CSV songbook upload** (milestone 4).
3. **K16 · "Same again"** on the room page (milestone 2).
4. **K1 · One-room trial** of a clock-switched outlet on the mic receiver, only with West 4's approval and a Playbox warranty check, while the Playbox agreement is pending.

**Decide in the phase 1 data model** (no screens yet, because adding these later would mean a rewrite):

1. A minimum spend per room tier, day and band (K4).
2. A prepaid-value liability ledger in the money rules (K5).
3. A "booked by / host" field on bookings and sessions (K9).
4. Merging two sessions onto one check with their holds kept (K9).
5. Bands in every rate mode, with a billing increment and rounding rule (K13).

**Leave for later:** P2 gets K3, K7, K10's native app, K12, K14, K15, K17, gift cards (K5), guest profiles (K11) and the KaraFun adapter. P3, before the pilots, gets K8, K9, stored value, loyalty and campaigns, and K18. K19–K21 come after that.

## Feature matrix

**Legend.** Yes = documented. Part = partly, or only some members of the group (named). No = documented as absent, or outside what the product does. n/d = not documented in what we read. n/a = the product's market or scope makes the row irrelevant (China, Korea, booking-only). For Us: P1, P2, P3 or — (not planned), with the gap ID.

**Groups.** Rest. POS = Toast, Square, Clover, SpotOn, Lightspeed. Bar/KTV POS = GoTab, iTab, VenueTap. Karaoke apps = KaraFun Box, Singa, SongbookDB, RequestSongs. TJ = TJ Media TPOS and apps. CN KTV = K米/Evideo, Thunderstone, 乾元坤和, Nakesoft. Booking = Bookeo, Resova, Funbutler, Rex, Square Appointments, Xola. Timed venues = CenterEdge, ROLLER, QubicaAMF, Brunswick, CuePoint, BilliardPOS, golf-bay booking. Nightlife = SevenRooms, Tablelist Pro, UrVenue.

### Rooms and time

| Feature | Us | Rest. POS | Bar/KTV POS | Karaoke apps | TJ | CN KTV | Booking | Timed venues | Nightlife |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Room board with live clocks and states | P1 | Part (table maps only) | Part (iTab, VenueTap claim timers) | Part (occupancy, device status) | Yes | Yes | No | Yes | Part (table status) |
| Per-person hourly room rate | P1 | No | n/d | No | n/d | Yes | Part (priced at booking) | Yes (per bowler) | No |
| Exact-minute overage | P1 | No | n/d | No | n/d | Part (extensions recalculated) | No | Yes (CuePoint, BilliardPOS) | No |
| Rate bands and billing increments in every rate mode | Part (per-person bands only) · K13 | Part (item prices by time) | Part (VenueTap) | No | Part (up to four price options) | Yes | Yes | Yes | Yes (demand pricing) |
| Minimum spend per room, live | Part (big-party shortfall only) · K4 | n/d | n/d | No | n/d | Yes | No | n/d | Yes |
| Online booking with deposit and cancellation rules | P1 | Yes (Toast Tables, Square Appointments) | Part (GoTab via Rex, SevenRooms; iTab) | Part (Singa Booking; prepay "coming soon") | n/d | Yes | Yes | Yes | Yes |
| Packages or add-ons prepaid in the booking | P2 · K3 | Yes (Toast Tables) | n/d | No | n/d | Part (package rules) | Yes | Yes | Yes |
| Song player locks and starts from the clock | P2 adapters, P1 trial · K1 | No | n/d | Yes | Yes | Yes | Part (via Singa, KaraFun links) | Yes (lights, smart plugs) | Part (SevenRooms → KaraFun) |
| Countdown and last-song warning in the room | P1 on the tablet; TV only via adapter | No | n/d | Yes | n/d | Yes | No | n/d | No |
| Guests extend from the room | Part (soft end) · K17 | No | n/d | n/d | Part (coin top-up) | Yes | No | Yes (QubicaAMF QR) | No |
| Move a party; merge rooms | P1 move; merge — · K9 | Part (Toast's merge drops holds) | n/d | No | n/d | Yes | No | n/d | n/d |

### Ordering, tabs and payments

| Feature | Us | Rest. POS | Bar/KTV POS | Karaoke apps | TJ | CN KTV | Booking | Timed venues | Nightlife |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Guests order from the room | P1 | Yes (Toast Mobile Order & Pay) | Yes | No | n/d | Yes | No | Yes (lane ordering, ROLLER) | n/d |
| Bar accepts alcohol orders, with ID status and aging escalation | P1 | n/d (Toast routes by print routing) | n/d | No | n/d | n/d | No | n/d | No |
| Alcohol stop at the county closing hour on every channel | P1 | n/d | n/d | No | n/a | n/a | No | n/d | No |
| Card holds that grow with the tab | P1 | Part (SpotOn; not Toast or Square) | Yes (GoTab) | No | n/d | n/d | No | n/d | n/d |
| Last call in one confirmation; tips on the reader | P1 | No (Toast, Square) | n/d | No | n/d | n/d | No | n/d | n/d |
| Guests pay their own share from their phones | — · K2 | Yes | Yes | No | n/d | Part (K米 pay) | No | Part (Brunswick lane QR) | Part (Tablelist) |
| Handheld that orders and takes the card | Part (phone plus S710) · K15 | Yes | Yes | No | Part (phone app sells time) | Yes | No | Part (QPad orders; cards n/d) | n/d |
| Card payments while offline | No · K10 | Yes | Part (VenueTap hub) | n/a | n/d | n/d | n/a | n/d | n/a |
| Kitchen display with stations and expo | P2 · K14 | Yes | Yes | No | No | Part (auto-print by station) | No | Yes | No |
| Manager approvals on the approver's phone | P1 | Part (SpotOn; Toast, Square at the device) | n/d | No | n/d | n/d | No | n/d | n/d |

### Bar karaoke, guests and operations

| Feature | Us | Rest. POS | Bar/KTV POS | Karaoke apps | TJ | CN KTV | Booking | Timed venues | Nightlife |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Song requests from phones, with rotation | P1 | No | n/d | Yes | n/d | Yes (in the room) | No | No | No |
| "You're up" alerts, KJ tips, paid priority | — · K6 | No | n/d | Yes | n/d | n/d | No | No | No |
| Per-song charges on the tab | P1 | Part (typed as items) | n/d | Part (tips, paid bumps) | Part (coin rooms sell songs) | n/d | No | No | No |
| Song-play log per room | P1 | No | n/d | Part (most played; no singer names) | n/d | n/d | No | No | No |
| Waitlist with texts | P1 | Yes | Part (iTab) | No | n/d | n/d | No | Yes (QPad, Brunswick) | Yes |
| Gift cards, stored value, prepaid hours | — · K5 | Yes | Yes | No | n/d | Yes | Yes | Yes | n/d |
| CRM, loyalty, marketing automation | P2–P3 · K11 | Yes | Yes | No | n/d | Yes | Part | Yes | Yes |
| Discount codes and demand pricing | Part (dated price rules) · K12 | Part | n/d | No | n/d | Yes (coupons) | Yes | Yes | Yes |
| Events and ticketing | — · K18 | Part (Toast Catering & Events, SpotOn) | n/d | No | n/d | n/d | Yes | Yes | Yes |
| Inventory with automatic 86 | — · K7 | Yes | n/d | No | n/d | Yes | No | Yes | n/d |
| Tip pool and gratuity under New York rules | P1 | Part (SpotOn tip splitting) | n/d | No | n/a | n/a | No | n/d | n/d |
| Staff and guest screens in Korean and Chinese | P2 | n/d | n/d | No (KaraFun Box) | Korean only | Chinese only | Part (Bookeo, 35 languages) | Part (BilliardPOS, 12 languages) | n/d |
| Booking-host commissions; bottle keep | — · K9 | n/d | n/d | No | n/d | Yes | No | No | Part (promoters) |
| WeChat Pay and WeChat booking | Part (a WeChat link) · K9 | n/d | n/d | No | n/a | Yes (China) | n/d | n/d | n/d |
| Discreet help alert and welfare timers | P1 | n/d | n/d | n/d | n/d | Part (room calls) | No | Part (service calls) | No |
| Software price, 14-room venue | $417/month (proposed) | Square $49–$149 + $90 for rooms + $20–$30 per kitchen screen; Toast $0 or $69/terminal | GoTab $15–$229; iTab from $65; VenueTap quote | KaraFun $2,786 with songs; Singa from $59 | TPOS-15H ₩770,000 | n/d | Rex from $295; Resova $40–$135; TicketingHub 3% | CenterEdge $300–$800; CuePoint ≤$37.50; ROLLER quote | Quote |

## Sources

**Our documents and earlier research**

- review/blueprint.md (rev 68), review/spec.md (rev 182; Payment flows, Devices, printing and offline, Staff screens and the bar POS, Song systems and texts, Phase 1 milestones), review/gap_review.md, and the canvas screens (Rail, Board, DeskRoom, Room, Order, Bar, Night, Staff, Waitlist, Parties, DeskReports, AdminDesk, Setup, Console)
- /home/claude/reports/Staff first bar POS design.md and its notes (other_pos_and_ktv.md, toast.md, square_clover.md, staff_sentiment.md, human_factors.md)
- /home/claude/reports/Karaoke bar POS gap analysis.md (the M, S and N codes)

**Karaoke platforms, KJ apps and song vendors**

- [KaraFun Box](https://business.karafun.com/box/)
- [KaraFun: Blocked Mode](https://business.karafun.com/resources-start-karaoke-business/1548-blocked-mode-lock-down-your-karaoke-rooms-between-sessions.html)
- [KaraFun: session management from the dashboard](https://business.karafun.com/resources-start-karaoke-business/1374-session-management-from-the-dashboard.html)
- [KaraFun: how karaoke boxes work](https://business.karafun.com/resources-start-karaoke-business/1203-how-do-karaoke-boxes-work.html)
- [KaraFun: increase profitability](https://business.karafun.com/resources-start-karaoke-business/1224-increase-profitability-making-your-karaoke-box-count.html)
- [KaraFun: best apps to run a karaoke box](https://business.karafun.com/resources-start-karaoke-business/1223-best-apps-to-run-a-karaoke-box-business.html)
- [KaraFun: expert tips for karaoke boxes](https://business.karafun.com/resources-start-karaoke-business/1113-expert-tips-to-run-your-karaoke-box-with-karafun-business.html)
- [KaraFun: API integrations](https://business.karafun.com/api-integrations)
- [App Store: KaraFun Box](https://apps.apple.com/us/app/-/id1594346411)
- [Singa Booking](https://singa.com/blog/singa-booking/)
- [Singa Help: Karaoke Box mode](https://help.singabusiness.com/how-to-use-karaoke-box)
- [Singa Help: queue and song requests](https://help.singabusiness.com/controlling-the-queue-and-song-requests)
- [Singa: reservation software for karaoke rooms (vendor)](https://singa.com/blog/karaoke-room-reservation-software/)
- [Singa: karaoke software for business compared (vendor, Sep 14, 2026)](https://singa.com/blog/best-karaoke-software-for-business/)
- [Singa: private-room karaoke software (vendor)](https://singa.com/blog/best-private-room-karaoke-software/)
- [Singa: US karaoke room pricing (vendor)](https://singa.com/blog/karaoke-room-pricing-us/)
- [Singa: software for karaoke hosts](https://singa.com/business/us/solutions/karaoke-hosts/)
- [PCDJ: SongbookDB tip the karaoke host](https://pcdj.com/songbookdb-tip-the-karaoke-host/)
- [PCDJ: Karaoki and SongbookDB partnership](https://www.pcdj.com/pcdj-songbookdb-partnership/)
- [RequestSongs](https://requestsongs.co/)
- [Karaoke Media: KTV SILVER](https://www.karaokemedia.com/en/karaoke-software-solutions/private-karaoke-rooms/ktv-silver/)
- [Playbox (public site)](https://www.playboxkaraoke.com/)
- [Sing Sing Media (public site)](https://www.singsingmedia.com/)

**Korean noraebang systems**

- [App Store: TJ 노래방 POS](https://apps.apple.com/kr/app/tj-%EB%85%B8%EB%9E%98%EB%B0%A9-pos/id6447156787)
- [TJ Media: TJ매니저 owner app](https://www.tjmedia.com/support/app)
- [USISNET: TJ Media card payment system](https://www.usisnet.co.kr/smain/smain0203.html)
- [JY21: TJ Media TPOS-15H listing](https://m.jy21.com/product/tj%EB%AF%B8%EB%94%94%EC%96%B4-tpos-15h-%EB%85%B8%EB%9E%98%EB%B0%A9-%EA%B4%80%EB%A6%AC%EA%B8%B0/858/display/1/)
- [Namu Wiki: coin noraebang](https://namu.wiki/w/%EC%BD%94%EC%9D%B8%20%EB%85%B8%EB%9E%98%EB%B0%A9)
- [Namu Wiki: noraebang part-time work](https://namu.wiki/w/%EB%85%B8%EB%9E%98%EB%B0%A9%20%EC%95%84%EB%A5%B4%EB%B0%94%EC%9D%B4%ED%8A%B8)

**Chinese KTV systems**

- [K米: about](https://km.ktvme.com/aboutus)
- [K米 service center](https://open-doc.ktvme.com/)
- [K米: 精通 management system change log](https://open-doc.ktvme.com/read/jingtong/version_update)
- [K米: online reservation manual](https://open-doc.ktvme.com/books/zxyd)
- [K米: open a room with a Douyin voucher (title)](https://open-doc.ktvme.com/read/fwydd/dyqkf)
- [Tencent App Store: K米商户通](https://sj.qq.com/appdetail/com.ktvme.kmmanager)
- [Evideo: KTV server](https://yule.evideostb.com/_website/ktvser_106.html)
- [Sohu: Thunderstone KTV profile (Dec 2, 2025, likely promotional)](https://www.sohu.com/a/960747235_122540766)
- [K米: opening rooms (3.8 开房), via the earlier research](https://open-doc.ktvme.com/read/fwydd/kf)
- [K米: waiter ordering app manual, via the earlier research](https://open-doc.ktvme.com/read/fwydd/kftp?wd=%E9%85%8D%E7%BD%AE)
- [乾元坤和: KTV solution](https://www.qykh2009.com/sol_help_3.html)
- [Nakesoft: KTV cashier system](https://www.nakesoft.com/hyzx/5422.html) and [KTV front-desk systems, via the earlier research](https://www.nakesoft.com/hyzx/2787.html)
- [Sohu: self-service KTV automation](https://www.sohu.com/a/866156648_121950269)
- [Anest: karaoke front management system (Japan), via the earlier research](https://anest-n.co.jp/karaoke.html)

**US karaoke-bar and KTV POS**

- [iTab: karaoke bars and restaurants](https://www.itabpos.com/karaoke-bars-restaurants-pos/)
- [VenueTap POS](https://venuetappos.com), [pricing](https://venuetappos.com/pricing), [desktop repo](https://github.com/kyunghoon5/venuetappos-desktop) and [release v1.1.39](https://github.com/kyunghoon5/venuetappos-desktop/releases/tag/v1.1.39)
- [MenuSifu: bar and KTV page](https://www.menusifu.com/restaurant-type-bar-ktv)
- [KwickOS: entertainment venue POS (vendor blog, Jul 28, 2026)](https://kwickos.com/blog/entertainment-venue-pos-membership.html)

**Booking tools**

- [Bookeo: karaoke room booking](https://www.bookeo.com/tours/karaoke-ticket-booking-software/)
- [Resova: all features](https://get.resova.com/features/feature/all-features/)
- [Funbutler: karaoke booking software](https://funbutler.com/industries/karaoke-booking-software)
- [Rex: karaoke reservations](https://www.reservewithrex.com/industries/karaoke)
- [Rex: how to start a karaoke business (vendor)](https://www.reservewithrex.com/blog/how-to-start-a-karaoke-business)
- [Rex vs CenterEdge (vendor-written)](https://www.reservewithrex.com/blog/rex-vs-centeredge-venue-management-platform)
- [TicketingHub: karaoke room booking](https://www.ticketinghub.com/en-US/industries/karaoke-room-booking-software)
- [Square Appointments: resource booking](https://squareup.com/au/en/appointments/features/resource-booking)
- [Square Appointments: cancellation and prepayment policies](https://squareup.com/help/us/en/article/5493-set-a-custom-cancellation-policy-with-square-appointments)
- [Xola: booking software guide (vendor)](https://www.xola.com/articles/how-to-find-the-best-online-booking-software-for-tours-and-activities-in-2025/)
- [Bookteq: PaySplit](https://www.bookteq.com/introducing-payment-splitting-from-bookteq/)

**Timed-venue suites**

- [CuePoint](https://www.cuepoint.cloud/) and [CuePoint: POS for pool halls (vendor)](https://www.cuepoint.cloud/blog/best-pos-system-for-pool-halls)
- [BilliardPOS](https://billiardpos.net/en/)
- [CenterEdge: event bookings](https://centeredgesoftware.com/products/advantage-events/event-bookings/) and [pricing](https://centeredgesoftware.com/pricing/)
- [Capterra: CenterEdge Advantage reviews](https://www.capterra.com/p/114604/CenterEdge-Advantage/reviews/)
- [ROLLER: features](https://www.roller.software/features)
- [Capterra: ROLLER reviews](https://www.capterra.com/p/164715/ROLLER/reviews/)
- [QubicaAMF: Conqueror X](https://qubicaamf.com.au/conqueror-x-management-system/)
- [QubicaAMF: Conqueror Web and Kiosk](https://www.qubicaamfbowling.com/products/management-operations/conqueror-web-kiosk)
- [RePlay: QubicaAMF BES NV (Jul 10, 2025)](https://www.replaymag.com/qubicaamf-launches-new-scoring-system/)
- [Brunswick: OrderNow on-lane ordering](https://brunswickbowling.com/bowling-centers/equipment-parts-supplies/center-operations/sync/sync-pay/sync-pay-hardware/on-lane-ordering)
- [Brunswick: Sync upgrade](https://brunswickbowling.com/company/news/sync-scoring-and-managements-powerful-new-upgrade-adds-powerful-automation-and-center-operations-features)
- [Bowl O'Clock: bowling management software guide (vendor)](https://www.bowloclock.com/blog/bowling-management-software-guide)
- [Golf O'Clock](https://golfoclock.com/)
- [Trackman: booking and payments](https://www.trackman.com/lp/trackman-booking-payments)
- [Skedda: turn a golf simulator on and off with bookings](https://support.skedda.com/en/articles/12029787-how-to-automatically-turn-your-golf-simulator-on-and-off-with-bookings)

**Nightlife and bar tools**

- [SevenRooms: nightclubs and bars](https://sevenrooms.com/nightclubs-bars/)
- [SevenRooms: events and experiences](https://sevenrooms.com/platform/events-experiences/)
- [Wikipedia: SevenRooms](https://en.wikipedia.org/wiki/SevenRooms)
- [G2: SevenRooms reviews](https://www.g2.com/products/sevenrooms/reviews)
- [Tablelist Pro](https://www.tablelistpro.com/) and [best nightclub software 2026 (vendor)](https://www.tablelistpro.com/blog/best-nightclub-software)
- [UrVenue: nightlife and daylife](https://www.urvenue.com/who-we-serve/nightlife-daylife/), [mixed-use entertainment](https://www.urvenue.com/who-we-serve/mixed-use-entertainment-venues/) and [bars and lounges](https://www.urvenue.com/who-we-serve/bars-and-lounges/)
- [GoTab: plan comparison](https://gotab.com/compare)
- [GoTab: loss-prevention features (Feb 8, 2024)](https://gotab.com/latest/gotabs-loss-prevention-features)
- [GoTab: Easy Tab (Jul 18, 2022)](https://gotab.com/latest/gotab-unveils-easy-tab-a-new-feature-that-helps-servers-and-bartenders-seamlessly-bridge-mobile-order-and-pay-at-table-with-traditional-service)
- [GoTab: reservation and waitlist partners](https://gotab.com/partners/reservations-and-waitlist)
- [GoTab API: reservation integration](https://docs.gotab.io/reference/reservation-integration)
- [Capterra: GoTab POS reviews](https://capterra.com/p/215393/GoTab-POS/reviews/)

**Restaurant and bar POS**

- [Toast Go 3](https://pos.toasttab.com/hardware/toast-go)
- [Toast: kitchen display system](https://support.toasttab.com/en/article/Get-Started-With-the-Kitchen-Display-System)
- [Toast: Catering and Events deposits](https://support.toasttab.com/en/article/Catering-and-Events-Deposits)
- [Toast Tables: deposits, prepayments, add-ons and cancellation fees](https://support.toasttab.com/en/article/Get-Started-Toast-Tables-Deposits)
- [Toast Loyalty](https://support.toasttab.com/en/article/Getting-Started-Toast-Loyalty)
- [Toast SMS marketing](https://support.toasttab.com/en/article/Get-Started-With-SMS-Marketing)
- [Toast gift cards](https://support.toasttab.com/en/article/getting-started-with-toast-gift-cards)
- [Toast scheduling](https://pos.toasttab.com/products/restaurant-employee-scheduling-software)
- [Toast Mobile Order & Pay FAQ](https://support.toasttab.com/en/article/Toast-Mobile-Order-and-Pay-FAQs)
- [Toast: menu item inventory](https://doc.toasttab.com/doc/platformguide/adminMenuItemInventoryOverview.html)
- [Toast: card pre-authorization FAQ](https://support.toasttab.com/en/article/Card-Pre-Authorization-FAQs)
- [Toast: pre-authorized cards decline when closing](https://support.toasttab.com/en/article/Preauthorized-Cards-Decline-When-Closing)
- [Toast: offline mode](https://support.toasttab.com/en/article/Using-Toast-in-Offline-Mode) and [offline card payments, no holds offline](https://doc.toasttab.com/doc/platformguide/adminOfflineCCPayments.html)
- Via the earlier research: [Toast: bulk check management](https://support.toasttab.com/en/article/Bulk-Check-Management), [Toast: combining checks](https://support.toasttab.com/en/article/Combining-Checks-1492892550423), [Toast: auto-close at the business-day cutoff](https://support.toasttab.com/en/article/Enable-Auto-Close-or-Auto-Void-for-Check-Reconciliation), [Toast: happy hour menu pricing](https://support.toasttab.com/en/article/Building-Happy-Hour-Menus-w-Menu-Specific-Pricing-1493004445781)
- [Square: Scan to Pay](https://squareup.com/help/us/en/article/8456-checkout-with-scan-to-pay)
- [Square: kitchen display system](https://squareup.com/us/en/point-of-sale/restaurants/kitchen-display-system)
- [Square: offline payments](https://squareup.com/help/us/en/article/7777-process-card-payments-with-offline-mode)
- Via the earlier research: [Square: bar-tab pre-authorization](https://squareup.com/help/us/en/article/8455-enable-and-configure-preauthorization-for-bar-tabs), [Square: settling tips](https://squareup.com/help/us/en/article/8375-settle-payments-and-manage-tips), [Square: comps, voids and passcodes](https://squareup.com/help/us/en/article/8166-comp-void-and-reassign-checks-with-square-for-restaurants), [Clover: incremental authorization request](https://clover.uservoice.com/forums/941725-taking-payments/suggestions/45964759-clover-dining-add-incremental-authorizations)
- [SpotOn: nightclub and bar POS](https://www.spoton.com/restaurant-pos/nightclub-and-bar/)
- [SpotOn: Experiences](https://www.spoton.com/solutions/experiences/)
- Via the earlier research: [SpotOn: incremental authorization (blog)](https://www.spoton.com/blog/bar-tabs-pre-authorization-speed-up-transactions-eliminate-walkouts/), [SpotOn: restaurant POS brochure, remote approvals](https://spoton-prod-websites-user-assets.s3.amazonaws.com/static/uploads/files/Lfe57MiQeSmEpYJMJ50C_SpotOn%20Restaurant%20POS%20%281%29.pdf)
- [BinWise Pro](https://home.binwise.com/binwise-pro)

**Payments**

- [Stripe: WeChat Pay](https://docs.stripe.com/payments/wechat-pay)
- [Stripe Terminal: additional payment methods (server-driven)](https://docs.stripe.com/terminal/payments/additional-payment-methods.md?terminal-sdk-platform=server-driven)
- [Stripe Support: WeChat Pay, Alipay and the executive orders](https://support.stripe.com/questions/wechat-pay-and-alipay-executive-orders)

**Not used as evidence.** LOOP POS ([loopin.one](https://loopin.one/en)) serves only Southeast Asia (F&B and billiard halls). Thunderstone's own site blocks automated reading by robots.txt, so it rests on the Sohu profile above. Sing Sing Media's karaoke-system page wouldn't load, so its POS features are unknown.
