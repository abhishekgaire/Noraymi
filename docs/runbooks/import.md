# Import a venue's records from its old system (M9-01)

The import tool loads the files a venue exports from its old system into our records: future bookings with their deposits, guests, consents, the menu, the team (people and roles only), and nightly totals for the reports' trends ([milestones](../milestones.md#m9--cutover-and-going-live) · Imports). M9-02 to M9-05 build out each kind; M9-06 runs the dry run that proves nothing is lost.

**Partnerships only.** Import only files the venue makes with its old system's own export tools, or pulls through that system's documented API under the venue's own account. Never scrape the old system or reverse-engineer it. If it has no export, the venue exports by hand into the same columns.

**Never commit a real export.** The files hold guests' names and numbers. Keep them in a private location outside the repo, read them from there, and delete the local copy after the cutover. The made-up fixtures in `packages/db/test-fixtures/import/` are the only export files in the repo.

## Run it

```
pnpm db:import -- --venue <slug|id> --mapping <dir>/mapping.json --dry-run --out evidence/import
pnpm db:import -- --venue <slug|id> --mapping <dir>/mapping.json --out evidence/import \
  --cutover-date <YYYY-MM-DD> --links-out <private dir>/manage-links.csv --link-base https://west4karaoke.com
```

- The export files sit next to the mapping file. `DATABASE_URL` names the database (a staging copy for a rehearsal).
- `--dry-run` does the whole import inside one transaction, writes the report, then rolls everything back. Only the run's row in `import_runs`, with its report, is kept.
- A live run loads in batches (`--batch`, 500 by default), each its own short transaction as the audited migration role (`app_migrator`), walled to the one venue. Every row is audited under `import:<run id>`.
- Running the same files again changes nothing: each record's reference in the old system is kept in `import_refs`, and a record already imported is skipped. The cutover delta is just a re-run with the newer files. A record whose values changed in the old system since the last run is listed under "changed … not applied" for a manager to fix by hand; the run then doesn't reconcile.
- The command exits non-zero when a file is refused, a row has a problem, or the result doesn't reconcile.
- `--cutover-date` is the business date the imported deposits are recorded and journaled on (today's by default).
- `--links-out` writes each imported booking's manage link (`legacy_ref,link`) to a file only you can read, for the cutover texts. The links are secrets: they're printed nowhere and stored only as hashes, so without this file a manager reissues a guest's link instead. Delete the file once the texts are out.

## Bookings still to come and their deposits (M9-02)

A booking whose status is `pending` or `confirmed` is one still to come. It gets:

1. **A real room.** The room the old system named when it's free and fits the party; otherwise the smallest free room that fits, as staff assignment would. Its block covers the booked time plus the room's cleaning minutes. A booking that fits no room isn't dropped: it goes on the manager's list (`GET /v1/venues/{v}/bookings/no-room`, managers and the owner) with its deposit, and the report names it (`fits no room, on the manager's list: file:line ref`). Seat it by hand with a staff booking, and settle its deposit as below.
2. **Its terms.** The `policies` file holds the words each guest accepted on the old site; each becomes a `policy_versions` row of kind `imported_terms` (text and hash), never the venue's own deposit policy. A booking names its terms (`policy_ref`) and when the guest accepted them (`accepted_at`); its refund cut-off is its start minus the terms' `refund_hours`. Terms that name no refund window give no cut-off.
3. **Its deposit**, in `deposit_cents` (what the Calendar and the board show) and `deposit_legacy_cents`, and as an `external` payment of the booking, captured, recorded on the cutover date. It never goes near Stripe: the money is on the old system's processor. Check-in applies it like any deposit. It's never an Unmatched payment and never counts as a deposit taken on the cutover night.
4. **A manage link** (see `--links-out`).

Other statuses (seated, finished, cancelled, no-show) are kept as history: the booking in the room it named, with no block, no payment and no link.

**The opening journal.** The deposits of the bookings still to come that a run loaded (placed or on the manager's list) go into customer deposits on the cutover date, against "Deposits held by the old system": debit that, credit customer deposits, the same cents. It's kept on the run (`import_runs.opening_journal`) and, with `--out`, written as `opening-journal-<run>.csv` in QuickBooks' journal format for the accountant. A cutover delta's new deposits get their own entry. The report's deposits line shows the total, the part held as old-system payments, and the part with bookings on the manager's list; the run reconciles only when those add up and the journal balances.

## The menu (M9-04)

The menu goes in through the same save path as Admin → Menu, so the rule pack's promotion checks run on every item and package:

- **`menu`**: one row per thing sold. Rows that share `item_ref` are one item's variants (a pint and a pitcher); without it, each row is its own item. The rows of one item must agree on its name, category, alcohol flag, button name, station and grid section, and the rows of one category on its tax category (`drink` or `food`; required, from the export or the mapping's `defaults`, never guessed). `button_name` is the short label on the bar POS grid (24 characters at most); `station` is `bar` by default.
- **`modifiers`**: one row per choice in a modifier group of an item (`item_ref`, `group`, `name`, `price_delta`, `required`, `min_choices`, `max_choices`, `is_default`).
- **`packages`**: `name`, `price`, `hourly`, `private_function_only`, `shown`, and `contents` as `ITEM:qty; ITEM` (no quantity means as many as the guests want).

**Promotion checks first.** Before a live run commits anything, the whole menu is loaded and checked in a transaction that's rolled back. An item or package the checks refuse (free alcohol, an hourly package with alcohol, alcohol in a package without a fixed quantity, a private-function package the pack doesn't allow) stops the import with `file:line the rule pack's promotion checks refuse "<name>": <reason>`, and nothing loads. Fix it with the owner (a real price, a fixed quantity) and run again.

**After it loads**, as after an Admin save: `menu.changed` goes out, the menu PDF renders again, and the bar's grid gets a new version starting at the next business date (nothing moves mid-shift). Buttons already on the grid stay where they are; each new bar item takes the first free slot of its section: the export's `pos_section`, or the section its category's name starts with (Beer, Soju, Cocktails, Shots, Spirits, Wine, Soft…, Bottles, Buckets). Favorites stay the owner's pick. An item with no section, or whose section is full, is listed (`not on the bar grid: …`) for the owner to place in Admin → Bar POS. If a draft layout is open in Admin → Bar POS, the import publishes nothing and says so; publish or discard the draft, then place the new items there.

## Guests and their consents (M9-03)

Guests belong to the one venue they're imported into; nothing is shared across venues. A phone number must be a +1 number: another country's number is left out of the guest (the guest is still imported) and listed in the report (`imported, listed: file:line …`), since we text only +1 numbers. Service texts go to the number the guest gave.

Each consent becomes one of four things, and the report counts them (`Consents in the files: …`):

- **A marketing opt-in with its proof** is imported as consent. Proof is all four of: the form it was given on (`source`), its wording (`text_version`), the IP address (`ip`) and the time (`given_at`). It's stored with source `import:<mapping source> · <form>`.
- **A marketing opt-in missing any of that proof** isn't imported as consent. The report lists it with what's missing (`not imported as consent, no proof (missing …)`). Never fill in proof the old system didn't keep; that guest simply isn't opted in to marketing.
- **An opt-out** is imported as an opt-out and honored at once. An SMS opt-out, whether the old site recorded it for promotions or for every text, is kept as an opt-out of every text, so a guest who opted out on the old site gets no text from us.
- **An opt-in to service texts** is imported as it is; service texts need no proof.

West 4's two marketing texts stay off either way (the Marketing texts module).

**Refunding or keeping an old deposit** (cautious default until the founder confirms where the old deposits are held): refund it in the old system, then record it here as a refund of the `external` payment with the old system's reference; a kept one becomes the usual `fee` check with a `forfeit` line. The old site's manage links can't carry over; M9-09 redirects them.

## What stops an import before anything loads

1. **A PIN or a card number.** A file with a column named like a PIN or password (PIN, Staff PIN, Passcode…) or like card data (Card Number, CC#, CVV, Expiry Date, PAN…), or with a card number anywhere in any cell (13 to 19 digits that pass the card checksum), is refused whole, whether or not the mapping reads that column. Ask the venue to export again without that column. Staff set new PINs on their own phones (M9-08).
2. **A problem in any row.** Every problem is listed as `file:line reason`: an empty required field, a value the mapping doesn't know, an amount that isn't dollars and cents, a time that happens twice or never on a daylight-saving night, a repeated record, a room the venue doesn't have, a guest the guests file doesn't have. Fix the export or the mapping and run again.

## The report

One line per kind: how many records are in the venue's database, with cents where the kind carries money (deposits, menu prices, nightly net sales), then what was in the files and how many were new, already imported, or changed. People are counted by role and consents by kind, channel and given or revoked. The last line says whether every record and cent in the files is in the venue. `--out` also writes the report as JSON.

## The mapping file (version 1)

One mapping per source system and export layout. When the venue's export changes, write a new mapping; the code doesn't change.

```json
{
  "mapping_version": 1,
  "source": "west4-oldsystem-2026-10",
  "description": "What exported these files, and when.",
  "files": {
    "bookings": {
      "file": "reservations.csv",
      "format": "csv",
      "money_unit": "dollars",
      "columns": { "legacy_ref": "Reservation #", "guest_ref": "Customer #", "room": "Room" },
      "values": { "status": { "Arrived": "checked_in", "Confirmed": "confirmed" } },
      "defaults": { "status": "confirmed" }
    }
  }
}
```

- `format` is `csv` or `json` (an array of objects); by default it follows the file's extension.
- `columns` maps our field to the export's column name. `values` maps the export's words to ours, field by field; a word missing from the map is a problem. `defaults` fills a field the export has no column for.
- `money_unit` is `dollars` (`$1,234.50`, the default) or `cents` (whole numbers). Amounts never pass through a float.
- Times may carry an offset (`2026-09-25T19:00:00-04:00`) or be local wall-clock times (`2026-09-25 19:00`), read in the venue's time zone. A booking's business date comes from its start, with the venue's 6:00 AM cutover.

| Kind | Required fields | Optional fields |
| --- | --- | --- |
| `guests` | legacy_ref, name | phone, email, locale |
| `people` | legacy_ref, name, role (owner, manager, bartender, front_desk, staff) | email, phone, locale |
| `menu` | legacy_ref, name, category, price, alcohol, tax_category (drink, food) | item_ref, station (default `bar`), pos_section, button_name, variant (default `Regular`), sort |
| `modifiers` | legacy_ref, item_ref, group, name | price_delta, required, min_choices, max_choices, is_default, sort |
| `packages` | legacy_ref, name, price | hourly, private_function_only, contents, shown |
| `policies` | legacy_ref, text | refund_hours, published_at |
| `bookings` | legacy_ref, guest_ref, room (a room name), party_size, starts_at, ends_at | deposit, status (default `confirmed`), policy_ref, accepted_at |
| `consents` | guest_ref, channel (sms, email), kind (texts, marketing) | legacy_ref, given_at, ip, revoked_at, revoked_via (keyword, staff, guest_page), source (the form it was given on), text_version (its wording) |
| `nightly_totals` | business_date, net_sales | rooms, bar |

What each kind becomes, today: a guest is a `guests` row (locale English when the export has none); a person is a user (linked to an existing user with the same email) with an **invited** membership in the role, no PIN and no badge; a menu row is a priced variant of its item, in its category (above); a booking is a `bookings` row with source `import`, its `legacy_ref`, and the deposit the old system took in `deposit_legacy_cents` (one still to come also gets its room, terms, payment and link, above); a consent is a `consents` row; a nightly total is a `legacy_nightly_totals` row. M9-05 adds the invites.

## West 4

West 4's old system and its export format aren't known yet (spec gap, see the M9-01 ticket). When the files arrive: write `mapping.json` for them, run a dry run on a staging copy, and compare the report with the old system's own counts and totals.
