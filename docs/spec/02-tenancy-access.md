## Tenancy and access

Every row belongs to one venue, and Postgres itself refuses to return a row outside the current venue, so one bad query can't leak another venue's data.

**The hierarchy.** An organization is the business and legal entity; it owns one Stripe account and one or more venues. A venue is one location, such as West 4, and owns its rooms, menu, devices, tabs and settings. A user is a person; a membership gives that user a role at one venue, so an owner of two venues has two memberships. Owner reports can read across an organization's venues, but every write names one venue.

**Who can call what.** Every route declares which of these principals may call it, and a test calls every route as every principal:

| Principal | How it signs in | What it can reach |
| --- | --- | --- |
| Owner or manager | Email plus a passkey or an authenticator app; two-step sign-in can't be turned off | Their role's permissions. Sessions last 12 hours and lock after 30 idle minutes; large refunds, exports, team changes and card-fee changes ask for the passkey again. Admin (settings, team changes and exports) opens only in the passkey session; a PIN never opens it, on any device |
| Staff member | Invite link and phone number confirmed once, then their badge or name and PIN on a shared screen, or their PIN on their own phone | Their role's permissions |
| Shared device (bar computer, front desk) | Paired by a manager with a one-time code; its key is a non-extractable WebCrypto key that signs every request | With nobody signed in: badge and PIN unlock, heartbeats, and a channel that carries only room numbers and ring state, so room orders still show and chime while the screen is locked |
| Room tablet | Paired to one room, in managed kiosk mode (Guided Access or device management on iPad, lock-task mode on Android) | Only its room's current session, through a filtered room channel. It has no PIN pad |
| Guest in a room | Trades the room code once for a 128-bit session token in an httpOnly cookie | That one room session: totals, orders and calls. The host's token adds cancelling and locking |
| Guest with a booking | A manage link carrying a 128-bit token, stored hashed | That one booking |
| Guest with a link (waitlist spot, receipt, pay link) | A 128-bit token in the link, stored hashed, that expires | That one waitlist spot, receipt or payment |
| Singer in the bar queue | A display name and a phone number confirmed once with a code | Their own queue entries, and their tab once they owe something |
| Printer | Its own CloudPRNT or Server Direct Print credential | Its own print jobs |
| Up next display | Paired like a shared device | The queue display channel only |
| Our support staff | Our single sign-on with a FIDO2 key into the Console, then a grant the venue's owner approved | What the grant allows, on masked views |

**PINs.** Shared screens show name tiles: staff tap their name, then enter their PIN, so every try counts against one person and two people can have the same PIN without either finding out. Staff PINs have 4 digits; manager and owner PINs have 6. Common and sequential PINs, such as 1234, 1111, 0000 and 2580, are refused. Staff choose their own PIN from the invite link on their own phone, and a reset sends a new link there, so nobody can set someone else's PIN at a shared screen. A PIN is never texted, emailed or shown to anyone. Five wrong tries lock that person on that device for 1 minute, then 5, then 15. Ten wrong tries in a row on one device, across any names, pause PIN sign-in there until a manager pairs it again, and the manager's phone gets an alert. The device's alarm and heartbeat channel keeps working, so this can't silence the bar alarm. A PIN is stored as Argon2id over `HMAC(pepper, venue_id ‖ membership_id ‖ PIN)`, with the pepper held in the key service, so a copy of the database can't be guessed offline. No device caches PIN hashes.

**Badges.** On shared screens a badge tap is the fast way in, and name and PIN are the fallback. A badge is an NXP NTAG 424 DNA tag in a card, key fob or wristband, paired to one membership in Admin → Team by tapping it on the reader and switched off there when it's lost; deactivating a membership switches off its badges with everything else. Every tap gives a SUN message, the tag's AES-128 answer to that one read, which the server checks against the tag's key and a read counter that must go up, so a copied tag or a replayed read is refused. The desktop app reads badges from a USB NFC reader at the bar computer and at the front desk. A badge session rings drinks, opens and closes tabs, takes payments and accepts orders; refunds, cash counts and no-sale ask for the PIN again, and Admin needs a passkey. Someone else's tap takes over the screen at once, and each person's unsent drinks stay theirs. There are no fingerprint readers: New York's Labor Law §201-a bars requiring employees to be fingerprinted, and a badge tap, at about a second, is faster than a PIN anyway.

**Roles.** One list everywhere: Owner, Manager, Bartender, Front desk and Staff (a runner). At West 4, Abhishek G. is the owner, Andy C. the manager and Maya S. the bartender, and Diego R. works the front desk and covers the bar while Maya is on break. The defaults are below, and Admin → Team, the sign-in screen's home links and the bar POS all follow them. A venue's changes live in `role_permissions (role, action, allowed, needs_approval)`, and the API checks them before every write, never only in the screens. The duty picked at clock-in (Bar, Front desk, Runner, Manager) feeds the tip pool; permissions come from the role.

| Action | Owner | Manager | Bartender | Front desk | Staff (runner) |
| --- | --- | --- | --- | --- | --- |
| Take payments (card and cash), room close-out | ✓ | ✓ | ✓ | ✓ | — |
| Bar POS: quick sale and bar tabs | ✓ | ✓ | ✓ | ✓ when covering the bar (Admin can switch it off) | — |
| Accept room orders at the bar, 86 an item | ✓ | ✓ | ✓ | ✓ when covering the bar | — |
| Check in, waitlist, bookings, guest texts | ✓ | ✓ | ✓ | ✓ | Check-in and waitlist only |
| Carry runs (I've got it, Delivered, Couldn't serve) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Comp or void within the reason-only limit | ✓ | ✓ | ✓ | ✓ | — |
| Cut off a tab, a room or a guest | ✓ | ✓ | ✓ | ✓ | — (a runner returns the order with a reason, and a manager decides) |
| Approve (comps and voids over the limit, refunds, clock pauses, tips over 25%, paid-outs, a lower party size after gratuity) | ✓ | ✓ | — | — | — |
| Ask for a refund | ✓ | ✓ | — | — | — |
| Count a drawer | ✓ | ✓ | ✓ (bar drawer) | ✓ (front-desk drawer) | — |
| Close the night, reports | ✓ | ✓ | — | — | — |
| Admin (needs a passkey; a PIN never opens it) | ✓ | ✓ (no Payments, Team or Console) | — | — | — |
| Shares tips and gratuity | — | — | ✓ | ✓ | ✓ |

In Admin, Payments is the Stripe account, payouts and our plan; Team is people, roles, invites, PIN resets, badges, languages and training mode; and Console is where the owner approves support access from our staff. Managers get every other section.

**The reason-only limit.** A comp or void of up to **$25 each and $75 a shift per person** needs only a reason (`pos.reasonOnly`: 2500 and 7500 cents at West 4). The shift total is one running sum per person across every screen that can comp or void (the bar POS, Room, DeskRoom and the board), and practice checks in training mode don't count. Over either limit, the comp or void needs approval.

**Approvals.** A comp or void over the reason-only limit, a refund, a room-clock pause, a tip over the review limit in `pay.tipReview` (over 25% at West 4), a cash paid-out over the limit, a lower party size after the gratuity applies, and charging a saved card without the guest's confirmation all need approval.

- **Decided on the approver's own phone,** in their passkey-protected session, never on the requester's device and never by the requester. Nobody approves their own request.
- **Routing.** A request goes to the manager on duty. The manager on duty's own requests go to another manager or the owner (Andy's go to Abhishek), and the owner's go to a manager. A tip over 25% on a paper slip goes to the manager on duty, or to the owner if that manager entered the slip.
- **The Approvals inbox.** The manager's phone shows "Approvals · N": each request's line, amount, reason, who asked and when, with [Approve] and [Decline]. The requester's screen shows "Waiting for Andy", then the decision.
- **Nothing waits.** The line shows who it's waiting for, and staff keep working. A tab waiting on an approval is skipped by "Charge the remaining tabs" until it's decided.
- **On the record.** Request and decision both go on the record (`approvals`), and a comp or void within the limit still needs a reason. A nightly exceptions report lists every comp, void and refund, approved or not, and voids after a cash payment or refunds over a set amount alert the owner.

**Languages.** Phase 1 ships the staff screens in English and Spanish. Each person picks theirs in Admin → Team (a Language column) or on their own sign-in ("English · Español"), stored as `memberships.locale`, and menu items keep their menu names. Every staff string lives in a string catalog from the first milestone, never in code, and CI fails a build with a staff string missing in either language. The languages a venue offers are in the `languages` setting. Korean and Chinese staff screens are phase 2.

**Offboarding.** Deactivating a membership revokes, in one step, its device keys, sessions, sockets and push subscriptions, and keeps its records. Personal phones are devices of kind `staff_phone`, so they're revoked the same way. An owner who loses access recovers with a single-use recovery code or through a second owner, after a 48-hour delay with notice to every manager.

**Support access.** Our staff request access in the Console, whose minimal version ships in phase 1, with a reason, a scope (read, or write for one named action) and a length of up to 60 minutes. The venue's owner approves it in Admin → Console, and can end it any time. The session carries its `support_grant_id` and runs `SET TRANSACTION READ ONLY` on masked views (no ID scans, no guest phone numbers); an approved write allows only the one named action, once, and the rest of the session stays read-only, and every audit row records both identities. An emergency path allows only the listed support actions (re-sync a payment, cancel a reader action, requeue a print, close a stuck night), needs a second approver on our side and notifies the owner the moment it opens.

**The database walls.** Every venue-owned table has a `venue_id` column and the same policy. The API connects as `app_rw`, a role without `BYPASSRLS`, keeps each transaction short and sets the venue first. If the venue is missing, the query errors instead of returning everything:

```sql
alter table checks enable row level security;
alter table checks force row level security;

create policy venue_isolation on checks
  using (venue_id = current_setting('app.venue_id')::uuid)
  with check (venue_id = current_setting('app.venue_id')::uuid);

-- owner reports: only report tables get this policy, never guests, messages or id_checks;
-- it applies only in a read-only transaction that an owner-report route marked with app.scope = 'org'
-- (a replica is always read-only, so read-only alone isn't enough), for venues where the user is an active owner
create policy org_read on checks for select
  using (current_setting('transaction_read_only') = 'on'
         and current_setting('app.scope', true) = 'org'
         and venue_id = any (owner_venues()));   -- a definer function over active owner memberships

-- the app role never gets update on money columns, delete, truncate, references or trigger
grant select, insert on checks to app_rw;
grant update (status, revision, version, paid_at) on checks to app_rw;

-- foreign keys name the venue too, because foreign-key checks bypass row security
alter table check_lines add foreign key (venue_id, check_id) references checks (venue_id, id);

-- per request, inside one short transaction:
begin;
select set_config('app.venue_id', $1, true);   -- true = this transaction only
select set_config('app.user_id', $2, true);
select set_config('app.request_id', $3, true);
-- ... the request's queries ...
commit;
```

- **Requests that arrive without a venue** (login, device claim, PIN unlock, public slug, code and token routes, Stripe and Twilio webhooks, jobs) find it through narrow `SECURITY DEFINER` functions owned by a role that can't log in, each with a pinned `search_path`. Each takes a secret and returns only ids: `resolve_device`, `resolve_room_session`, `resolve_booking_token`, `resolve_stripe_account` and `resolve_sms_number`. The request then sets the venue as usual.
- **Jobs** carry `venue_id`. A worker claims one through a definer function with a lease (`locked_until`) in a short transaction, then runs each step like a request: its own short transactions with that venue set, and no Stripe or Twilio call inside any of them. A failed job retries with exponential backoff and jitter, from 5 seconds up to 10 minutes, until its kind's `max_attempts`, then goes to the dead letters. Scheduled work fans out as one job per venue.
- **Tables without `venue_id`** get their own policies: `users` shows a user to themselves and to members of the current venue, `organizations` shows the current venue's, `webhook_events` is insert-only for an ingest role and gets its `venue_id` once resolved, and `idempotency_keys` is keyed by venue and caller.
- **Audit rows** are written by `SECURITY DEFINER` triggers from the request's `app.*` settings and `now()`, never by the app. They store ids, field names and old and new values, except guest contact details, which are marked changed without their values, and are hash-chained per venue, with each day's last hash exported to write-once storage. Any DDL or TRUNCATE raises an alert.
- **Tests.** A suite calls every endpoint as venue A with venue B's ids and expects "not found", and runs the same checks against jobs and webhooks.

Migrations run as the table owner, and batched backfills run as an audited migration role (Testing and operations).
