## Data model

Phase 1 needs about 100 tables. Money is stored in integer cents and every timestamp is `timestamptz`, shown in the venue's time zone. Every money, shift and drawer row carries the `business_date` it belongs to. Every venue-owned table carries `venue_id` under the venue policy in [Tenancy and access](02-tenancy-access.md), has `unique (venue_id, id)`, and is referenced by foreign keys that name the venue. The roles are `owner`, `manager`, `bartender`, `front_desk` and `staff` everywhere.

**Venue, people and platform**

| Table | Key columns | Notes |
| --- | --- | --- |
| `organizations` | legal_name, stripe_account_id, billing_customer_id | One Stripe connected account each |
| `venues` | org_id, name, slug, address, time_zone, day_cutover, rule_pack_id, stripe_location_id | West 4 is one row. The occupancy limit is the `safety.occupancyLimit` setting, not a column |
| `rule_packs` | id, version, effective_on, data, approved_by (two people), signature | Venues can read, never write |
| `users` | name, email, phone_e164, mfa_required | People, across venues |
| `memberships` | user_id, venue_id, role, status, pin_verifier, pin_digits, locale, tip_eligible, occupation_code, eligibility_set_by, eligibility_set_at, training, deactivated_at | Role: owner, manager, bartender, front_desk or staff. The PIN is stored as Argon2id over a peppered HMAC. locale is English or Spanish at launch. training puts the person in training mode (below) |
| `role_permissions` | role, action, allowed, needs_approval | A venue's changes to the default permissions |
| `pin_lockouts` | membership_id, device_id, failures, locked_until | Per person and device |
| `staff_badges` | membership_id, uid_hash, key_version, last_counter, label, paired_by, paired_at, last_tap_at, disabled_at | NTAG 424 DNA badges. A tap counts only with a valid SUN message and a counter above the last one seen; a lost badge is switched off in Admin → Team |
| `approvals` | kind, target_kind, target_id, amount_cents, reason, payload, requested_by, requested_device_id, requested_at, routed_to, approver_id, decided_device_id, status, decided_at | Kinds: comp and void (over the reason-only limit), refund, clock_pause, tip_review (a tip over 25% or $50, or entered 2 hours late), paid_out (over the limit), party_size_down (a lower party size, or removing the gratuity, after the gratuity applies), card_on_file (charging a saved card without the guest), over_hold (a new order on a tab whose hold raise was declined), drawer_handover (the incoming manager accepting the house drawers; routed to them, not the manager on duty). Status: pending, approved, declined, expired (what it was for is gone, such as a closed tab). routed_to is the manager on duty, or an owner when the manager on duty asked, so the requester's screen shows "Waiting for Andy". Decided on the approver's own phone, never on the requester's device and never by the requester; payload holds what happens on approval. The manager's Approvals inbox lists the pending ones |
| `devices` | kind, name, public_key, room_id, station, protocol, secret_hash, user_id, cash_drawer_id, network, clock_skew_ms, app_version, consecutive_failures, training, last_seen_at, disabled_at, revoked_at | Kinds: bar_computer, front_desk, room_tablet, reader, printer, nfc_reader, router, staff_phone, up_next_display, mic_outlet (the one-room K1 trial: a switched outlet on the wireless-mic receiver, never the song player). A USB printer or NFC reader reports through its host computer. cash_drawer_id pairs a shared screen with the drawer its cash goes into: at West 4, the bar computer with the bar drawer and the front-desk computer with the front-desk drawer. training puts everything rung there in training mode, for a new hire. Revoking a device ends its sessions at once |
| `seed_ids` | slug, entity, row_id, loaded_at | The demo seed's slugs (`room_9`, `maya`, `dev_router`) beside the UUIDs the loader gave them, so a test finds a row by name. Staging and local dev only; the loader refuses production |
| `venue_settings` / `venue_modules` / `venue_flags` | See [Settings, rule packs and modules](03-settings-rule-packs-modules.md) | Versioned; modules have a state |
| `venue_subscriptions` | plan, stripe_subscription_id, room_quantity, status | Our plan billing |
| `integrations` | kind, status, external_id, config, connected_at | Twilio, Google, QuickBooks, email, song system |
| `support_grants` | staff_id, requested_by, reason, scope, status, approved_by, second_approver, starts_at, ends_at, revoked_at | Support access the venue approved |
| `audit_log` | actor, approver, support_grant_id, action, target, changed_fields, old_values, new_values, request_id, at, prev_hash, hash | Written only by triggers |
| `venue_events` | seq, type, entity_id, entity_version, at | Live events, kept 72 hours |
| `jobs` | kind, dedupe_key (unique), priority, run_at, attempts, max_attempts, locked_until, last_error, status | Claimed with SKIP LOCKED |
| `files` | kind, storage_key, content_type, bytes, sha256, uploaded_by, uploaded_at, attached_at | Damage, slip, paid-out and lost-item photos, license copies, songbook CSVs, PDFs and dispute evidence. Uploaded straight to storage through a presigned POST /files, which checks each kind's file types and size limit ([API](08-api.md)). A file counts once a row that needs it (a damage line, a slip tip, a license) attaches it; an unattached upload is deleted after 24 hours |
| `webhook_events` | provider, venue_id, event_id (unique), type, received_at, processed_at, payload | Makes every webhook run once |
| `idempotency_keys` | venue_id, principal_id, key, route, request_hash, state, response, created_at | Inserted before the work starts; kept 7 days |
| `domains` | hostname, status, verified_at, tls_status | A venue's own domain; filled in phase 2 with the website builder |
| `site_versions` | version, status, content, created_by, published_at, published_by | Status: draft or published. The builder saves into one draft, Publish makes it live, and every published version is kept so a publish can be undone |

**Rooms, bookings and the clock**

| Table | Key columns | Notes |
| --- | --- | --- |
| `rooms` | name, size_tier, capacity_min, capacity_max, cleaning_min, is_vip, bookable_online, archived_at | 14 at West 4, in four size tiers: small (Rooms 1–5, 3–6 guests), medium (Rooms 6–10, 6–12), large (Rooms 11–13, 12–20) and VIP (20–40). An empty cleaning_min uses the venue's default. Admin → Rooms creates, edits and archives rooms, and never deletes one |
| `room_states` | room_id, state, reason, since, until, set_by | available, in_use, wrap_up, cleaning, out_of_service |
| `room_blocks` | room_id, period (tstzrange), kind, ref_id, expires_at | Bookings, holds (a slot being paid for, a payment link or a waitlist offer), sessions, cleaning, out of service and buyouts, which can't overlap |
| `room_notes` | room_id, text, added_by, added_at, cleared_at | Notes stay with the room, such as "TV remote goes missing. Check under the couch." |
| `room_faults` | room_id, session_id, text, reported_by, reported_at, out_of_service, pause_segment_id, comp_line_id, fixed_by, fixed_at | Reported on the Board or DeskRoom. A fault can take the room out of service, pause the clock (with approval) or comp minutes of room time (a reason-only comp, linked by comp_line_id). Open faults show on the room's tile |
| `bookings` | guest_id, room_id, size_tier, party_size, starts_at, ends_at, business_date, status, source, booked_by, policy_version_id, deposit_cents, accepted_at, accepted_ip, accepted_ua, payment_method_id, refund_cutoff_at, cancelled_by, running_late_until, private_function, legacy_ref, deposit_legacy_cents, pending_until, manage_token_hash | Status: pending, confirmed, checked_in, no_show, cancelled, completed. Source: web, staff, import. Every booking has a real room. booked_by is the staff host or sales manager credited with the party, empty at West 4. pending_until is when an unpaid booking lapses: 10 minutes after an online slot is chosen, or 24 hours after a payment link is sent (never later than the start); until then its room block is a `hold` that expires with it |
| `policy_versions` | kind, version, text, hash, published_at | The exact terms a guest accepted: kind `deposit`, `tab_consent` or `room_card_consent` (M6-13) |
| `closures` | date, kind, opens, closes, note | Special dates and blocked dates, in one list |
| `enquiries` | guest_id, party_size, date, message, status, conversation_id | Party enquiries from the website |
| `room_sessions` | room_id, booking_id, guest_id, check_id, party_size, started_at, booked_end_at, ended_at, business_date, server_user_id, room_code_hash, room_code_enc, wrong_codes, code_alert_at, token_version, host_token_hash, host_lock, ordering_locked, min_spend_cents, alcohol_cut_off_at, alcohol_cut_off_by, alcohol_cut_off_reason, booked_by | The room clock; booked_end_at is soft. ordering_locked is set when the check is presented and cleared if a manager reopens it. A cut-off stops alcohol for the whole room, with who, when and why. min_spend_cents is copied at check-in from the minimum that applies ([Money rules 6](05-money-rules.md)), and empty when none does, as at West 4. "ID ✓ 3 of 4" counts the session's `id_checks` against party_size. Two sessions can share one check (a merge): the second session's check_id points at the first's check, its lines move across as transfers, and its deposit or hold allocations move with them, so both guarantees stay; each keeps its own room and segments. Merges have no screen in phase 1 |
| `room_guests` | session_id, room_id, token_hash, token_version, name, is_host, joined_at, last_seen_at, left_at, alcohol_cut_off_at, alcohol_cut_off_by, alcohol_cut_off_reason | Each phone that joined with the room code (room_id is the room its token was issued in; token_version is the session's then, and a phone whose session moved on gets a fresh token and the new code, sealed in room_code_enc). Pay my share names the guest ("Kevin"), and one guest can be cut off from alcohol while the rest of the room still orders |
| `session_segments` | session_id, room_id, started_at, ended_at, billable_guests, rate_kind, hourly_cents, band_id, increment_min, rounding, paused, reason, approved_by | Room time is billed from these, with the band's billing step (1, 15, 30 or 60 minutes) and rounding (up, nearest or down); West 4 bills by the minute. rate_kind is the venue's rate mode (per person, base plus extra, flat by size) or vip, and hourly_cents is worked out from the band's amounts in that mode. A paused segment bills nothing and needs approved_by |
| `waitlist_entries` | guest_id, party_size, size_tier_needed, joined_at, quoted_min, status, offered_room_id, offer_expires_at, offer_message_id, check_id | Status: waiting, offered, seated, declined, expired, left. An offer holds the room for 10 minutes, and a room-ready text that fails shows "Not delivered · Call" |
| `room_calls` | session_id, kind, created_at, acked_by, acked_at | Another mic, TV, check or other. Each reaches the Board and every staff phone's Calls list; help alerts are incidents instead |
| `lost_items` | room_id, session_id, description, photo_file_id, found_by, found_at, kept_at, claimed_by_name, claimed_at, handed_over_by, disposed_at | The Board's lost and found: "Found in Room 9 · kept at the bar · claimed by …". room_id is empty for something found at the bar |

**Room assignment.** Every booking gets a real room when it's made; the guest sees only the size tier, and staff can reassign it. Assignment takes the smallest free room that fits the party, and a bigger tier only when no booking that needs it would be left without a room. A booking's block covers its booked time plus the room's cleaning minutes, and at check-in it becomes the session's block. A session that stays past its booked end extends its block 15 minutes at a time, only while nothing is booked next, and a booking into that room needs at least the wrap-up notice (10 minutes) plus cleaning before it starts. Switching a room off or marking it out of service re-runs assignment for its future bookings and lists any that no longer fit for a manager. Waitlist offers go only to rooms free for at least an hour, and an offer not taken in 10 minutes expires: a job releases the hold and offers the room to the next party that fits. A room move takes only a room that fits the party and is free for the time needed; it opens a new clock segment there, issues a new room code, rotates the guests' token, tells their phones, and sends the old room to cleaning.

**Menu, orders and songs**

| Table | Key columns | Notes |
| --- | --- | --- |
| `menu_categories` | name, sort, tax_category | Beer, Cocktails, Soju and the rest |
| `menu_items` | category_id, name, button_name, description, alcohol, station, shown, sort, out_until | out_until clears at close, and an item that's out keeps its grid slot, greyed. button_name is the short label on the POS grid; tickets and receipts print the full name |
| `menu_variants` / `menu_options` | item_id, name, price_cents or price_delta_cents, out_until; an option also has group_id and is_default | Every item has at least one variant, which carries its price. An option is one choice in a modifier group, and is_default is the one rung unless changed (Tito's on the rocks). One variant or flavor can be marked out |
| `modifier_groups` | item_id, name, required, min_choices, max_choices | Required choices and shared add-ons, such as Red Bull for $2 |
| `packages` | name, price_cents, hourly, contents, private_function_only, shown, checked_pack_version | Checked against the rule pack on save |
| `price_rules` | name, kind (happy_hour, special, hourly), days, from_min, to_min, target (item ids and how many the price buys), pct_off or price_cents, starts_on, ends_on, shown, checked_pack_version | Happy hours and specials, checked against the rule pack on save |
| `orders` | check_id, session_id, room_guest_id, source, status, cancel_reason, client_order_id, placed_by, placed_at, business_date, version, gift_for_singer_id, gift_for_check_id, same_again_of, held_by, held_at, accepted_by, accepted_at, escalated_at, ready_by, ready_at, claimed_by, claimed_at, delivered_by, delivered_at, returned_by, returned_at, returned_reason, returned_note, return_resolution, cancelled_by, cancelled_at, decline_reason | Status: ringing, held (asked to wait), accepted (being made), ready (made, waiting for a runner), on_the_way (a runner claimed it), delivered, returned, cancelled. cancel_reason: guest, staff, declined, alcohol_closed, cut_off. Source: room (a guest's or the host's phone, with room_guest_id), staff (placed_by is who rang it), gift or offline (queued in an outage, replayed as held). The sale time is accepted_at. claimed_by is the runner who took it; returned_reason is no_id, too_drunk, nobody_there or other, and return_resolution is void_not_made, void_made or remake. See Room orders below |
| `order_items` | order_id, variant_id, item_id, options, qty, unit_cents, name_snapshot, alcohol, tax_category, station, notes | Prices, the alcohol flag, the tax category and the station copied at order time, so a menu edit, the 4 AM stop and the cut-offs all read what was ordered |
| `order_drafts` | membership_id, check_id (empty for a quick sale), device_id, lines, version, updated_at | Unsent drinks, each person's own for each tab, saved as they're rung so a badge swap or a crash loses nothing. Never part of a check; cleared when sent and at the night close |
| `pos_layouts` | station, version, sections (each 25 slots of item ids or empty), published_by, published_at, starts_on | Fixed button positions. A new version starts at the next business date, so nothing moves mid-shift |
| `print_jobs` | device_id, order_id or check_id (neither for a test ticket), kind, station, payload, status, sent_at, failed_at, failure, job_token, reprint_of, reprint_n, created_at, confirmed_at | job_token is the CloudPRNT job token |
| `singers` | display_name, phone_e164, phone_verified_at, token_hash, check_id, joined_at, last_song_at | A bar-mode singer, who joins from their phone or at the bar and confirms the number once by a code. They get a tab only once they owe something, and the Up next TV never shows the number |
| `song_credits` | singer_id, source, check_line_id, payment_id, earned_at, used_by_queue_id, used_at | One song each. Source: drink (West 4's "buy a drink, get a song": each drink bought, on the singer's tab or at the bar, earns one, and check_line_id is that drink) or prepaid (bought at a song price; see prepaid_ledger). Queuing a song holds one (used_by_queue_id), starting it spends it (used_at), and a skip gives it back |
| `song_queue` | singer_id, check_id, title, artist, catalog_id, round, position, status, pay_with, credit_id, price_cents, check_line_id, started_by, started_at, skipped_by, skipped_at, moved_by, move_reason | Round-robin by singer, with the songs-per-round limit from `barMode`. Status: queued, singing, sung, skipped, removed. pay_with is credit or price: Started spends a credit and posts a $0.00 song line, or posts the song price to the singer's tab. With no song price set (West 4), a song needs a credit, and one without is flagged "Needs a drink credit". A staff move up or down records who and why |
| `song_catalog` | vendor, vendor_code, title, artist, language, source_file_id, loaded_at, replaced_at | Loaded from the vendor's file under agreement, or from the KJ's songbook CSV (title, artist, code) uploaded in Admin, which replaces the last upload (its songs get replaced_at, since the app never deletes). Searched by title and artist through a trigram index. Never scraped |
| `song_plays` | session_id or check_id (neither for a singer with no tab), queue_id, singer_id, title, artist, started_at, started_by, source (`staff` or `adapter`) | The play log for licensing; append-only |
| `song_systems` | system, kind, control, config | Secrets live in the secrets manager |

**Room orders.** An order moves ringing → held (optional) → accepted → ready → on_the_way → delivered, with returned and cancelled as the side exits. Each step is its own API call that checks the step before it, so a held order still needs Accept and can never be marked ready or delivered first. Accept is the sale: the order's lines join the check then, and the ticket prints. A staff order from the bar POS or a room tab is accepted as it's placed, then runs the same way. Delivered only ends the run and never charges. A returned order stays on the check until the bar resolves it: void · not made, void · made (the void line's `made` flag marks waste; phase 1 keeps no stock, so nothing moves) or remake (back to accepted with a new ticket, nothing charged again). A guest can cancel only while the order is ringing or held; the bar declines with a reason the guest sees; the 4 AM stop cancels unaccepted alcohol orders as `alcohol_closed`; and a cut-off cancels the ones it covers as `cut_off` ([Money rules 5](05-money-rules.md)). A gift order ("send the singer a drink") goes on the sender's check and names the singer or tab it's for; the alcohol checks run against the receiving tab, and ID is checked at hand-off.

**Same again** needs no table of its own. The room page lists the session's delivered orders, newest first, priced from today's menu, leaving out anything 86'd, outside the alcohol window or blocked by a cut-off. One tap places a new order with `same_again_of` set, and it rings the bar like any other.

**Money.** The core is in SQL below: `checks`, `check_revisions`, `check_lines`, `payments`, `payment_attempts`, `payment_allocations` and `venue_counters`. The rest:

| Table | Key columns | Notes |
| --- | --- | --- |
| `refunds` | payment_id, check_id, amount_cents, reason, status, stripe_refund_id, requested_by, approval_id, approved_by, business_date, adjusts_business_date | One row per payment refunded, never more than that payment captured minus its earlier refunds. Status: pending, succeeded, failed, canceled, from refund.updated and refund.failed; screens show "Refund pending" until it succeeds |
| `disputes` | payment_id, stripe_dispute_id, reason, amount_cents, status, due_by, evidence_file_ids | Evidence goes up through Stripe's Files API |
| `payouts` / `payout_lines` | stripe_payout_id, arrival_on, amount_cents / payout_id, venue_id, payment_id, gross_cents, fee_cents, net_cents | Split by venue through our payments rows |
| `cash_drawers` | name, station, printer_device_id | A drawer on a receipt printer's kick port. West 4 has two: the bar drawer on the bar receipt printer and the front-desk drawer on the front-desk printer. Each shared screen is paired to one (`devices.cash_drawer_id`), and cash taken there goes into it. A drawer per person needs one for each person taking cash at the same time, or a tray swap at shift change |
| `drawer_sessions` | drawer_id, model, owner_id, responsible_id, tray_label, state, opened_at, opening_cents, pulled_at, counted_at, counted_by, witness_id, counted_cents, expected_cents, over_short_cents, note, approved_by, closed_at, handover_id | Model: house (no owner; responsible_id is the manager on duty) or per_person (the owner answers for it), taken from the `drawer` setting when the business date starts, so a switch in Admin starts the next night. With house drawers each drawer has its own session, two at West 4. State: open, pulled (the tray is out and not yet counted), counted, closed; one open session per drawer. Counts are blind: the expected amount shows only after counting, and a count kept while it waits for a note or a second counter can't be changed. A handover closes each house session with its count and opens the next with the same cash (`handover_id`), the incoming manager as `responsible_id`; `approved_by` is set when they accept |
| `drawer_handovers` | business_date, from_user_id, to_user_id, requested_at, requested_device_id, approval_id, state, decided_at | The house drawers changing hands when the manager on duty changes (M7-05). State: pending (one at a time), accepted, declined (the sessions go back to the outgoing manager) |
| `drawer_moves` | drawer_session_id, kind, amount_cents, payment_id, staff_bank_id, taken_by, device_id, reason, approved_by, photo_file_id, paid_to | Sale, refund, paid-out, drop (a staff bank handed in), no-sale, tip-out (`paid_to` is the person paid), each with who took it and at which screen ("Logged to Maya · bar drawer"), which is how a shortage in a house drawer is traced. A paid-out over the limit is written only once approved |
| `staff_banks` | user_id, business_date, cash_cents, dropped_at, dropped_into_session_id | Cash a person holds outside a drawer, such as cash taken on a staff phone at a room close-out. It stays theirs until they drop it into a drawer (a drop move), which the clock-out checklist asks for |
| `night_closes` | business_date, z_number, closed_at, closed_by, totals, export_id | Never reopened. `totals.report` is the Z report as it stood at the close (sales, tax, gratuity, payments, drawers, the tip pool, exceptions, adjustments, the log); it's read back, never recomputed |
| `clear_out_checks` | business_date, due_at, done_by, done_at, note | One per business date. A job raises it at the close plus the drinking-up time (4:30 AM at West 4) with a `clear_out.due` event, and [Done] records "Clear-out check · Andy · 4:31 AM". The night can't close before it's done |
| `tab_cut_off_runs` | business_date, due_at, started_at, finished_at, tabs_charged | One per business date: the tab cut-off job (`tabs.cutOffAt`, 4:30 AM at West 4) runs once a night, and a run killed midway is picked up until it's finished |
| `receipts` | check_id, payment_id, token_hash, channel, sent_at, expires_at, sent_by | Behind every printed, texted or emailed receipt and the web link a paid bill shows (channel print, text, email or web; one web receipt per check). The link token is derived from the row's id with the server's secret and stored hashed, and expires (30 days until the founder decides) |
| `tabs` | check_id, payment_id, state, label, card_brand, card_last4, card_fingerprint, hold_cents, party_size, owner_id, opened_by, opened_at, consent_text_version, consent_read_by, receipt_printed_at, cut_off_at, cut_off_by, cut_off_reason, moved_to_check_id, closed_at, closed_by, reopened_at, hold_declined_at, flagged_over_at, hold_expiry_alerted_at | Seven states, as in the diagram in [Payment flows](07-payment-flows.md): open, tipping (the reader is asking for the tip), awaiting_tip (the paper-slip fallback), captured (paid on the held card), walkout_captured (charged at its balance with no tip, by Charge the remaining tabs or the 4:30 AM cut-off), capture_failed (left for a manager to settle) and closed (paid another way, such as cash, another card or split shares, or moved to a room, when moved_to_check_id shows "Moved to Room 9"). One open tab per card, through a partial unique index on the card fingerprint while open. consent_text_version is the `policy_versions` row of the line read out at opening, and consent_read_by the person who tapped [Read to guest ✓]. owner_id is whose tab it is, handed over at clock-out. A cut-off tab takes no alcohol, moved drinks included. A settled tab (captured, walkout_captured or closed) can be reopened until the night closes, with no hold ("Paid $272.19 · no hold"). hold_declined_at marks a declined hold raise ("Hold raise declined") until another card is added; flagged_over_at is when the tab passed `tabs.flagOverCents` and was shown to the manager on duty, once; hold_expiry_alerted_at is when the manager on duty was told the tab's hold had under 12 hours left before its `capture_before` (two days after opening while Stripe hasn't reported it), once |
| `tab_closings` | tab_id, check_id, payment_id, path, reader_device_id, stripe_reader_id, state, step_no, step_started_at, balance_cents, drinks_cents, gratuity_cents, tip_kind, choices_cents, tip_choice, tip_cents, tip_picked_at, capture_cents, receipt, receipt_step_no, receipt_sent_at, closed_by, created_at, settled_at, slip_printed_at, slip_photo_file_id, tip_entered_by, tip_entered_at, tip_approval_id, walkout, rest_cents, rest_payment_id, evidence, swept_at | One Close of a tab on its hold: the reader asking for the tip (asking, then custom for a typed amount), or the paper slip printed (path and state `slip`, the tab `awaiting_tip`) until a staff phone types the tip in from the signed slip with its photo, waiting on a `tip_review` approval when it needs one, the hold raised first if the total needs it (raising), the capture with Stripe (capturing), then captured, canceled, timed_out or failed (the tab is `capture_failed`). What the guest picked on the reader (the choice, its amount, when and on which reader) stays here with the payment as dispute evidence, with the receipt they asked for. A walkout (`walkout` charge_remaining or cut_off) closes with no tip: it captures the balance up to the hold plus the overcapture allowance, puts anything left (`rest_cents`) on the saved card (`rest_payment_id`), and keeps the drinks with their times in `evidence`; the cut-off job leaves `closed_by` empty. swept_at flags a slip whose tip was never entered, captured by the sweeper at a tip of 0, 12 hours before its hold's `capture_before`. One active Close per tab |
| `tab_card_confirms` | tab_id, check_id, payment_id, amount_cents, reader_device_id, stripe_reader_id, state, asked_by, asked_at, answered_at | Charge the saved card on a reopened tab (M6-12): one question on the bar reader ("Charge $9.80 to Visa ··4417?", Yes or No through collect_inputs) for a waiting card_on_file payment. asking, then yes (the off-session charge runs), no, timed_out (2 minutes), offline or canceled (staff cancelled, or a manager approved first). The answer and when stay with the payment as evidence of the guest's consent. One question at a time per tab |
| `check_cards` | check_id, reader_device_id, stripe_reader_id, state, stripe_customer_id, stripe_setup_intent_id, stripe_payment_method_id, card_brand, card_last4, failure_code, consent_text_version, consent_read_by, started_by, started_at, settled_at | A card tapped for a room (M6-13; Payment flows · Moving a tab into a room): a SetupIntent through the reader (`process_setup_intent`) saves it without charging, after the consent line is read out (a `policy_versions` row of kind `room_card_consent`, and who read it). waiting, then saved (the reader's generated card), failed or canceled; one waiting per check. Once one is saved, the holds of tabs moved into the room are canceled |
| `tab_openings` | payment_id, check_number, name, label, party_size, consent_text_version, consent_read_by, opened_by, membership_id, card_brand, card_last4, card_fingerprint, card_name, state, tab_id, created_at, settled_at | A tab being opened while the bar reader collects the card: waiting, then opened (a new tab with its hold), existing (the card's open tab, with no second hold) or canceled. The check number is taken first, so a declined card keeps it |
| `check_splits` | check_id, share_count, base_cents, created_by, created_at, ended_by, ended_at | A split kept on the server, so a paid share survives leaving the pay screen or switching tabs. base_cents is the amount left to pay when it started (for a room, when the check was presented), and share_count starts at the party size for Pay my share. One open split per check; Stop splitting ends it and keeps the paid shares |
| `split_shares` | split_id, share_no, kind, amount_cents, tax_cents, gratuity_cents, line_ids, room_guest_id, state | Each share, in integer cents ([Money rules 13](05-money-rules.md)), with its own way to pay. Kind: even (1 of N) or items (line_ids). State: open, paying, paid. A guest's Pay my share is a share with their room_guest_id, and payments point at shares through `payment_allocations.share_id` |
| `prepaid_accounts` | kind, code_hash, guest_id, singer_id, issued_at, expires_on, status | Money guests have paid ahead: gift cards (phase 2), stored value and prepaid hours (phase 3), and song credit bought at a song price. Its balance is the sum of its ledger rows |
| `prepaid_ledger` | account_id, kind, amount_cents, payment_id, check_id, by, at, business_date | The prepaid-value liability: issued (money in), redeemed (onto a check), expired and refunded, each posted to the prepaid-value account in the nightly journal |
| `payment_events` | payment_id, from_status, to_status, source, stripe_event_id, at | Every status change in order; source: api, webhook or reconciler |

**Tabs at the cut-off and at close.** The 4:30 AM cut-off job captures every `open` tab at its balance. It leaves a `tipping` tab for up to 2 minutes, until the reader answers, and then treats it as the `open` or `awaiting_tip` tab it has become. It leaves `awaiting_tip` tabs to the sweeper, and never retries a `capture_failed` tab, which alerts the manager on duty instead. Night close needs no `open` or `tipping` tab and allows `awaiting_tip` ones. A `capture_failed` tab doesn't hold up the close: it stays on the manager's list, with its balance, until it's settled, and money collected for it later posts to the current business date with `adjusts_business_date`.

**Staff, guests and records**

| Table | Key columns | Notes |
| --- | --- | --- |
| `time_punches` | membership_id, kind, duty, at, device_id, edited_by, reason | Clock in, clock out and breaks; edits need a reason. Duty: bar, front_desk, runner or manager, asked at clock-in; the tip pool uses it |
| `shifts` | membership_id, business_date, duty, started_at, ended_at, break_minutes, on_duty_since, cash_tips_declared_cents, cash_tips_declared_at | One row per clock-in to clock-out, built from the punches; the tip ledger's `shift_id` and each pool's hours point here, and My tips lists them. A person's reason-only comps and voids are totaled over their open shift, from every screen. The manager on duty is the open Manager shift with the latest `on_duty_since` (set when its person accepts a drawer handover), else the earliest clock-in |
| `tip_pools` | business_date, method, status, exported_at | One per business date, opened with the method in force at its start. Open while the night runs (shares worked out live from the ledger and shifts), closed and final at the close (its shares written once), locked once exported |
| `tip_pool_occupations` | pool_id, occupation, share_pct | The eligible occupations and each one's share |
| `tip_ledger` | user_id, shift_id, business_date, adjusts_business_date, source, amount_cents, check_id, payment_id, refund_id | Source: gratuity, card tip or cash tip. Kept by shift, so each pool member sees their 146-2.17 record in My tips. Insert-only, written in the same transaction as the money: a payment's tip once captured (a later change writes the difference), a check's gratuity once paid, and negative rows for a refund's share of gratuity or a refunded tip. Credited to whoever collected it and their shift (a bar tab's tip to whoever closed the tab); empty when a guest, the cut-off or the sweeper did it. Practice money writes nothing |
| `tip_shares` | pool_id, for_business_date, user_id, duty, minutes, gratuity_cents, card_tip_cents, cash_tip_cents | Gratuity is paid as wages; tips are tips. Insert-only, written as the pool closes. `for_business_date` is the night the money was earned: a late tip pointing at an earlier night is split by that night's people and minutes and recorded in this pool, so the closed pool never changes |
| `guests` | name, phone_e164, email, locale, last_seen_at, erased_at | Per venue, never shared across venues |
| `consents` | guest_id, phone_e164, channel, kind, given_at, source, text_version, ip, revoked_at, revoked_via | Proof of every opt-in and opt-out. An SMS opt-out is kept by number too, since a number can text STOP before it's a guest's, and every send checks it first |
| `conversations` | guest_id, phone_e164, context_kind, context_id, unread, assigned_to, last_inbound_at | The two-way inbox |
| `messages` | conversation_id, direction, template_id, category, body, sent_by, provider_sid, status, read_at, sent_at, stop_confirmation | Status: sending, sent, delivered, failed, received, or stopped (an opt-out stopped it before it went). `stop_confirmation` marks the one confirmation a STOP gets, the only text that goes after an opt-out |
| `message_templates` | key, category, body, on, updated_by | Every text the product sends |
| `id_checks` | session_id or check_id, order_id, checked_by, checked_at, method, scanned_fields, key_id, delete_after | One row per person checked: at check-in, by the runner at the room (order_id), or for a bar tab (check_id). Method: visual (only who checked and when) or scan. A scan is read on the device that took it, through a barcode library that runs there, never through an ID vendor's cloud, and only the rule pack's four fields are kept. Encrypted with a key per venue and business date, destroyed after 7 days; never in the org-wide read scope or any export |
| `incidents` | kind, room_id, session_id, room_guest_id, reported_via, reported_by, at, status, acknowledged_by, acknowledged_at, closed_by, closed_at, keep_until | Help alerts ("Need a manager, privately?") and the incident log. Status: open, acknowledged ("I'm on it"), closed. Only managers' and owners' phones get the room, time and kind; the board gets a "Manager needed" pin with no room and no reason while one is open |
| `incident_notes` | incident_id, text, added_by, added_at | Notes from the manager's phone, added to the incident log and never edited |
| `alcohol_refusals` | session_id or check_id, room_guest_id, order_id, reason, item, refused_by, at | After the alcohol window, cut off, no ID, too drunk |
| `door_counts` | business_date, delta, counted_by, device_id, at | Taps on the front desk's door counter, +1 or −1 for people who come in or leave without checking in, joining the waitlist or opening a tab. The board's "People inside" adds these to open sessions' party sizes, bar tabs and waiting parties, against `venues.max_occupancy`, and warns at 90%; with no limit set it shows "Limit not set · Admin → Safety" |
| `licenses` | kind, number, holder, authority, starts_on, expires_on, fee_cents, conditions, file_id, reminded_at | The license register in Admin → Licenses. Kinds: liquor, ascap, bmi, sesac, gmr, local (such as a cabaret or assembly license), health and other. file_id is a copy of the license. A job reminds the owner and managers 60, 30 and 7 days before expires_on |
| `legacy_nightly_totals` | business_date, totals | History imported from the old system, for trends |

**Phase 2, not in these tables** (as the blueprint plans): room welfare timers (`room_sessions.welfare_check_every_min`), the signed cleaning checklist (`cleaning_checks`), allergen fields (`menu_items.allergens`), package headcount tiers (`packages.tiers`), the volume-cap log (`volume_cap_log`), minimum spend credited against the room fee, and holiday or dated closes in the rule pack.

**Training mode.** A person (`memberships.training`) or a device (`devices.training`) in training mode rings practice checks (`checks.training`). They take their numbers from their own counter (T-0012), print "TRAINING · not real money", never reach live Stripe (card payments go to a simulated reader on Stripe's sandbox), never open a cash drawer, and stay out of Z reports, tax, tips and exports ([Testing and operations](13-testing-operations.md)). Every Z, tax, tip, export, report and reason-only query reads the views `live_checks`, `live_check_lines` and `live_payments`, which leave practice checks out; a lint rule fails report or export code that reads the base tables. Until the founder confirms the open points in M7-03's notes, a practice room session (`room_sessions.training`) writes no `room_blocks` or `room_states` and is seen only on screens in training, and an approval asked from practice work carries `approvals.training`, is marked TRAINING in the inbox and never counts. A practice payment (`payments.training`, set by the check it pays) runs only on the organization's sandbox account (`organizations.stripe_training_account_id`), the venue's sandbox Terminal Location (`venues.stripe_training_location_id`) and its simulated readers (`devices.sandbox`); one payment never covers a practice check and a live one.

**The money core.** A check never changes after the fact: corrections add lines, and each finalize writes a new revision.

```sql
create extension if not exists btree_gist;          -- lets room_blocks exclude overlaps per room

create table room_blocks (
  venue_id   uuid not null,
  room_id    uuid not null,
  period     tstzrange not null,
  kind       text not null check (kind in ('booking', 'hold', 'session', 'cleaning', 'out_of_service', 'buyout')),
  ref_id     uuid,
  expires_at timestamptz,                            -- a hold lapses here (10 minutes for a slot or a waitlist offer,
                                                     -- pending_until for a payment link); a job deletes it
  exclude using gist (venue_id with =, room_id with =, period with &&)
);

create table checks (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  number          bigint not null,                   -- in order per venue, never reused; shown as #1042
  kind            text not null check (kind in ('room', 'bar', 'quick', 'fee')),  -- fee: a kept deposit or no-show charge
  business_date   date not null,
  room_session_id uuid,
  booking_id      uuid,
  status          text not null default 'open' check (status in
                    ('open', 'finalized', 'partly_paid', 'paid', 'reopened', 'void')),
  revision        int not null default 0,            -- the latest finalized revision
  version         int not null default 0,            -- goes up with every line; If-Match uses it
  training        boolean not null default false,    -- practice checks: own counter (T-0012), never live Stripe, never in totals
  opened_by       uuid not null,
  opened_at       timestamptz not null default now(),
  paid_at         timestamptz,
  unique (venue_id, id),
  unique (venue_id, training, number),
  foreign key (venue_id, room_session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, booking_id) references bookings (venue_id, id)
);

create table check_revisions (
  venue_id          uuid not null,
  check_id          uuid not null,
  rev               int not null,
  subtotal_cents    bigint not null,
  tax_cents         bigint not null,
  gratuity_cents    bigint not null,
  total_cents       bigint not null,
  gratuity_basis    jsonb,                            -- the rule, the party size used, the percent
  billing_basis     jsonb,                            -- room time: each segment's rate mode, band amounts,
                                                      -- billing step and rounding
  pay_version       int not null,
  prices_version    int not null,
  rule_pack_version text not null,
  finalized_by      uuid not null,
  finalized_at      timestamptz not null default now(),
  primary key (venue_id, check_id, rev),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);

create table check_lines (
  id                 bigint generated always as identity primary key,
  venue_id           uuid not null,
  check_id           uuid not null,
  kind               text not null check (kind in ('room_time', 'item', 'song', 'fee', 'damage',
                       'min_spend', 'comp', 'void', 'discount', 'gratuity', 'tax', 'card_surcharge',
                       'cash_discount', 'transfer_in', 'transfer_out', 'forfeit', 'refund')),
  revision           int,                              -- computed lines (room time, min_spend, tax, gratuity) belong to a revision
  description        text not null,
  qty                numeric(10, 2) not null default 1,
  unit_cents         bigint not null,
  amount_cents       bigint not null,                  -- negative for credits
  tax_category       text check (tax_category in ('room_time', 'drink', 'food', 'song', 'damage',
                       'fee', 'surcharge')),           -- null on tax and gratuity lines; fee covers fee, forfeit
                                                       -- (kept deposits, no-show charges) and min_spend lines; comps,
                                                       -- voids, transfers and refunds take the category of the line
                                                       -- they reverse or move
  tax_rate           numeric(7, 6),                    -- on tax lines, such as 0.088750
  jurisdiction_code  text,                             -- on tax lines
  taxable_base_cents bigint,                           -- on tax lines
  payment_id         uuid,                             -- card-fee lines belong to one payment
  file_id            uuid,                             -- a damage photo
  source_id          uuid,                             -- the order item, song or segment
  reverses_id        bigint,                             -- the line it reverses; the foreign key below keeps it in the venue
  made               boolean,                          -- comps and voids: true is waste, a flag for reports, never a stock movement
  reason             text,
  added_by           uuid,
  approved_by        uuid,
  business_date      date not null,
  adjusts_business_date date,                          -- a late line: the closed night it belongs to
  rule_pack_version  text,                             -- on tax lines
  added_at           timestamptz not null default now(),
  moved_check_id     uuid,                             -- transfer_in and transfer_out (M6-13): the check on the other side of a move
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, reverses_id) references check_lines (venue_id, id),
  foreign key (venue_id, moved_check_id) references checks (venue_id, id)
);

create table payments (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null,
  booking_id            uuid,
  method                text not null check (method in
                          ('card_present', 'card_online', 'card_on_file', 'cash', 'external', 'prepaid')),
                                                       -- card_online includes a guest's Pay my share; prepaid spends
                                                       -- a prepaid_accounts balance (phase 2)
  stripe_pi_id          text unique,
  status                text not null check (status in ('pending', 'requires_action', 'authorized',
                          'captured', 'capture_failed', 'partly_refunded', 'refunded', 'canceled', 'failed')),
  authorized_cents      bigint,                        -- the current hold on a tab
  amount_cents          bigint not null default 0,
  tip_cents             bigint not null default 0,
  surcharge_cents       bigint not null default 0,
  tendered_cents        bigint,                        -- cash handed over
  change_cents          bigint,
  drawer_session_id     uuid,                          -- where the cash sits: a drawer session
  staff_bank_id         uuid,                          -- or a staff member's bank
  incremental_supported boolean,
  overcapture_supported boolean,
  increments_used       int not null default 0,
  generated_card_pm     text,                          -- the card saved from a tap, when Stripe returns one
  card_brand            text,
  card_last4            text,
  card_funding          text,                          -- 'credit', 'debit' or 'prepaid'
  capture_before        timestamptz,
  mit_reason            text,                          -- why a card on file was charged without the guest
  training              boolean not null default false, -- a practice payment: Stripe's sandbox, never live
  business_date         date not null,
  adjusts_business_date date,                          -- a late tip or charge: the closed night it belongs to
  created_at            timestamptz not null default now(),
  unique (venue_id, id)
);

create table payment_attempts (
  venue_id     uuid not null,
  payment_id   uuid not null,
  attempt_no   int not null,
  check_id     uuid,
  booking_id   uuid,                                 -- a deposit has a booking and no check yet
  portion_key  text not null,                        -- 'full', 'share:<split_share_id>', 'tab', 'deposit'
  action       text not null,                        -- process, collect, confirm, increment, capture, off_session
  reader_id    text,
  idem_key     text not null,                        -- '<payment_id>:<action>:<attempt_no>'
  amount_cents bigint not null,
  state        text not null check (state in ('started', 'unknown', 'succeeded', 'failed', 'canceled')),
  decline_code text,
  started_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  primary key (venue_id, payment_id, attempt_no),
  foreign key (venue_id, payment_id) references payments (venue_id, id)
);
-- one unfinished attempt per check or booking portion, so a second payment for the same amount can't start
create unique index one_open_attempt on payment_attempts
  (venue_id, (coalesce(check_id, booking_id)), portion_key)
  where state in ('started', 'unknown');

create table payment_allocations (
  venue_id     uuid not null,
  payment_id   uuid not null,
  check_id     uuid not null,
  amount_cents bigint not null,
  kind         text not null default 'payment' check (kind in ('payment', 'refund')),  -- a refund's row is negative
  state        text not null check (state in ('in_progress', 'captured', 'released')),
  share_id     uuid,                                 -- the split share it pays, if any
  room_guest_id uuid,                                -- a guest paying their own share: "Paid by a guest · Kevin (share 1 of 12)"
  created_at   timestamptz not null default now(),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
-- amount due, with the check row locked (select ... for update):
--   sum(check_lines.amount_cents) - sum(allocations that are 'captured' or 'in_progress'),
--   where a refund's allocation is negative and a tab hold's allocation follows the tab's lines;
--   amount_due_beside_holds leaves every tab hold on the check out (a room holding the hold of a tab
--   moved into it, M6-13), which is what a payment on that room may take

-- payment_events (in the table above) keeps every status change; payments holds the latest
grant select, insert on checks, check_revisions, check_lines, payments, payment_attempts,
  payment_allocations, payment_events to app_rw;
grant update (status, capture_before,
  increments_used, incremental_supported, overcapture_supported, generated_card_pm,
  card_brand, card_last4, card_funding) on payments to app_rw;
grant update (state, decline_code, resolved_at) on payment_attempts to app_rw;
grant update (state) on payment_allocations to app_rw;
-- amount_cents, authorized_cents, surcharge_cents and tip_cents change only through record_authorization(),
-- record_capture() and set_tip(), definer functions
-- that follow the state machine and write an audit row with old and new values; a cash payment never changes after insert

create table venue_counters (
  venue_id uuid not null,
  name     text not null,                            -- 'check', 'check_training', 'z_report'
  next     bigint not null,
  primary key (venue_id, name)
);
-- in its own short transaction, before any call to Stripe:
--   update venue_counters set next = next + 1
--   where venue_id = $1 and name = 'check' returning next - 1 as number;
```

Tax and gratuity are calculated live for the screens. Finalizing writes revision n + 1: it reverses revision n's computed lines, writes new ones, and records the totals, settings versions and billing basis in `check_revisions`. Presenting a room check finalizes it and locks ordering ([Money rules 6](05-money-rules.md)). Card-fee lines are written when their payment is confirmed. A check number comes from its own short transaction, so a slow Stripe call never holds the counter, and a failed tap voids the check but keeps its number, so the sequence has no gaps. Screens and receipts show it as #1042 (Room 9's check tonight); a training check counts on `check_training` and shows T-0012.
