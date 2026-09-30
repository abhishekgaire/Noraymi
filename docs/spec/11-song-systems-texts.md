## Song systems and texts

Phase 1 works with any song system because the clock, the bar queue and song charges all live in our product; adapters add control later, one vendor at a time. Control and catalogs come only through a vendor's own API or a written agreement: we never scrape or reverse-engineer a vendor's system.

**The adapter.** Each song system sits behind one interface. A venue's setup lives in `song_systems (venue_id, system, kind, control, config)`: `system` is the product the venue runs, `kind` is the adapter we connect with, and `control` is full (the adapter drives the player), queue only (our bar queue feeds the player) or manual (staff run the player). The clock, orders, song charges and play log work at every level. Secrets stay in the secrets manager, not the database.

```ts
interface SongSystemAdapter {
  kind: "none" | "karafun" | "openkj" | "playbox" | "singa";
  can: {
    startSession: boolean;
    endSession: boolean;
    lockRoom: boolean;
    volumeCap: boolean;
    songEvents: boolean;      // tells us when a song starts
    phoneRequests: boolean;   // takes requests from our bar queue
  };
  startSession(room: RoomRef, until: Date | null): Promise<void>;
  endSession(room: RoomRef): Promise<void>;
  setVolumeCap?(room: RoomRef, level: number): Promise<void>;
  onSongStarted?(handler: (e: { room: RoomRef; title: string; artist: string; at: Date }) => void): void;
}
```

| Song system | Adapter | When | What it does |
| --- | --- | --- | --- |
| Any player, or none | `none` | Phase 1, every venue | Our clock and bar queue; staff tap "started" to charge a song and log the play |
| KaraFun Box | `karafun` | First adapter in phase 2 | Uses KaraFun's venue API to schedule sessions and control rooms; song-start events aren't documented, so the staff tap stays for per-song charges until they are. KaraFun Pro has no API and runs as `none` |
| OpenKJ | `openkj` | Second | Serves the endpoints of OpenKJ's open request server, so a KJ's OpenKJ pulls requests from our bar queue |
| Playbox (West 4) | `playbox` | Once Playbox signs a written agreement | Drives the controls its Playbox Remote app already has (queue, skip, volume, key), plus room lock and a song-start signal if Playbox adds them. Until then West 4 runs as `none`, with our own room-screen countdown and staff alerts, and trials the mic power outlet in one room (below). Its song catalog comes only from Playbox or West 4 |
| Singa Box and Pro | `singa` | Only through a partner deal | Starts and ends Singa's timed sessions from our bookings. Singa has no public API and links only to booking partners it picks, and it sells its own booking add-on, so until a deal staff set the session and code in Singa's admin page. Its 3-request cap per guest and song history without singer names stay either way |
| Karaoki, kJams and other KJ software | `none` (manual) | Phase 1 | The KJ reads our bar queue and loads songs by hand. Karaoki's own requests work only on the local network and kJams scripting is 32-bit only, so no adapter is planned |
| TJ Media, Kumyoung, JOYSOUND, DAM, Thunderstone | `none` | Phase 1 | The player runs on its own while our room clock, orders and billing run beside it. TJ Media is the noraebang standard in Koreatown and Queens, and none of these publishes English integration docs, so an adapter waits for a vendor or reseller agreement |

Every started song writes a `song_plays` row per room or tab, the play log that answers licensing questions.

**Mic power trial.** For players with no API, a vendor-neutral fallback uses only our own hardware: a switched outlet on the room's wireless-mic receiver, never on the song player. It turns on at check-in and off at close-out or cleaning, so a party can't keep singing while the room waits for its next guests. It stays on whenever our server can't be reached: the outlet switches off only on a fresh command from us and back on when it loses contact, so an outage never silences a room. It's paired and watched like any other device. Phase 1 trials it in one West 4 room, only with West 4's approval and after asking Playbox whether it affects their equipment warranty; the Playbox agreement stays the real fix.

**Bar mode.** Bar mode is on at West 4, with the offer "Buy a drink, get a song": each drink bought earns one song credit, which posts as a $0.00 song line when the song starts. West 4 hasn't set a price for a song without a credit, so Admin shows "Song price · not set · songs need a drink credit".

- **Joining.** Singers join from the singer's queue page on their phones, reached from the website's "Sing at the bar" and the QR code on the Up next TV, or staff add them at the bar. Each gives a display name and a phone number confirmed once with a code, and gets a tab only once they owe something (`singers`).
- **Rotation.** Songs rotate round-robin by singer, one song per singer per round at West 4, the limit set in Admin. A staff override, moving a song up or down, needs a reason and is logged.
- **Credits.** A drink rung on a singer's tab earns a credit by itself; a drink bought at the bar without a tab earns one when the bartender picks the singer on the sale. With no song price, a song without a credit is flagged "Needs a drink credit" and can't be started until the singer has one. A cut-off from alcohol never stops anyone singing.
- **Started and Skip.** Staff tap Started as each song begins: it posts the song line to the singer's tab ($0.00 when it uses a credit), or uses the credit of a singer with no tab, and writes the play log. Skip is free, and a prepaid credit comes back. An adapter that reports song starts can mark Started instead.
- **Alerts.** The queue page shows each singer's place, counting the singers still to start before them. At 2, a push says "2 singers before you". When the singer before them starts, a push says "You're up next at the bar · come to the stage", and the You're up next service text goes out: "You're up next at the bar. Come to the stage when this song ends." A push needs the singer's phone to allow it; the open page always shows the alert.
- **Screens.** The song queue on the desktop app, opened from "Song queue · 6" on the bar POS, from the bar orders screen and from the side menu, shows who's singing now, who's up next in order, the round, each singer's credits and flags, Started, Skip, move up or down with a reason, and + Singer for someone at the bar. The Up next TV at the bar shows who's singing now, the next 5 singers and a QR code to join, and never a phone number. The singer's queue page has joining, the song search, My songs, their place in line and their credits. All three follow `song_queue.updated`.
- **Send the singer a drink.** A guest or staff member sends a drink as a gift order, charged to the sender's tab, that rings the bar like any order. It checks the alcohol window and the receiving singer's tab, so a cut-off singer can't be sent alcohol, and the bartender checks the singer's ID at hand-off.
- **Promotions.** A song credit from "buy a drink, get a song" is a zero-price song line; a free drink with a song is refused by the promotion checks until the lawyer answers ([Open technical questions](14-open-questions.md)).

The `BarModeSettings` type is defined once, in [Settings, rule packs and modules](03-settings-rule-packs-modules.md).

**Songbook.** The singer's song search and the website's song search read `song_catalog`. It's loaded from a file the song vendor supplies under the written agreement the blueprint lists, or from a KJ songbook upload in Admin → Bar mode: a CSV with title, artist and code. West 4's Playbox catalog comes only from Playbox or from West 4, and is never scraped. Until a catalog exists, the website's section shows only its heading and the venue's own song count, with no search box, and singers type a title and artist. Search goes through `GET /v1/public/venues/{slug}/songs?q=`.

**Texts through Twilio**

- **Accounts.** Each venue gets its own Twilio subaccount and brand registration, so one venue's texts can't get another venue suspended. One campaign carries service texts; marketing gets its own campaign only when that module is on.
- **Numbers and delivery.** Texts come from the venue's number in Admin → Phone & texts. Each message is written as `sending` before the call to Twilio, so a retried job never sends twice, and Twilio's status callbacks move it to sent, delivered or failed. A Room ready text that fails shows "Not delivered · Call" on the waitlist.
- **Two-way inbox.** Replies arrive by webhook into `conversations`, each tied to its booking, waitlist spot or room session, with an unread state and an assignee. `message.received` updates the board, the badges and the phone of the manager on shift. Staff can type free text only as a reply in an open service conversation, and links and promotions are blocked there.
- **Templates.** `message_templates` holds every text the product sends, each tagged service or marketing and edited in Admin → Texts; the list is below. Review asks and birthday texts count as marketing until the lawyer rules, so they never go out with receipts.
- **Consent and timing.** Service texts go to the number the guest gave for that booking or waitlist spot. Marketing texts need their own opt-in, stored with proof (the form, its wording, the IP address and the time), and go out only between 8 AM and 9 PM in the recipient's time zone, taken from the area code and checked against the venue's, which is how the TCPA and GBL §399-z measure it. STOP, and opt-outs written any other reasonable way, are honored at once: incoming texts are checked for opt-out wording, staff can mark one with a tap, and one confirmation goes back. HELP gets the venue's name and phone number.
- **Abuse.** Only +1 numbers, with Twilio's SMS pumping protection on and rate limits per number prefix.

**The automatic texts.** Admin → Texts, the desktop Messages screen and the phone's Messages list exactly these 14: 12 service texts and 2 marketing texts, and both marketing texts stay off until they have their own opt-in.

| # | Text | Kind | Sent | What it says (quoted where West 4's wording is set) |
| --- | --- | --- | --- | --- |
| 1 | Booking confirmed | Service | Right away | "Booked. Room for 6 at 9:30 PM, Sat Sep 26. A 20% gratuity is added to room tabs. Deposit $60 paid, comes off your bill. Free to cancel until Fri 9:30 PM: west4karaoke.com/b/…" |
| 2 | Reminder | Service | The afternoon of the booking | |
| 3 | Room code | Service | At check-in, to the host | The room's new 5-character code and the join link |
| 4 | Room ready | Service | When staff offer a waitlist party a room | "Your room is ready: Room 11. You have 10 minutes to claim it at the front desk." |
| 5 | Offer expiring | Service | 5 minutes left on the offer | |
| 6 | Please wrap up | Service | 10 minutes before the end, when someone is booked next | |
| 7 | Booked time ending | Service | 10 minutes before the end, when nobody is booked next | "…Nobody's booked after you, so you can stay on by the minute until we close at 4 AM." |
| 8 | Receipt | Service | After paying | The receipt link |
| 9 | Deposit refund | Service | When a deposit is refunded | |
| 10 | Payment link | Service | For a staff or big-party booking, or after an off-session charge fails | |
| 11 | Running late reply | Service | When staff answer a guest who says they're running late | |
| 12 | You're up next (bar mode) | Service | When 1 singer is ahead: the singer before them has started | "You're up next at the bar. Come to the stage when this song ends." |
| 13 | Review ask | Marketing | Off until it has its own opt-in | |
| 14 | Birthday | Marketing | Off until it has its own opt-in | |

"The bar needs a few minutes" and "On its way" are room-screen messages on the guests' phones and the room tablet, not texts: no step of a room order texts the guest.
