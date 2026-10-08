# Move west4karaoke.com to the new site (M9-09)

The guest web takes over west4karaoke.com from the old site. Every old page keeps answering, West 4's email keeps arriving, and the links in texts sent after the move open on the new site ([milestones](../milestones.md#m9--cutover-and-going-live) · M9 Ships). The founder makes every DNS change at West 4's registrar; nothing here changes DNS by itself.

## What the old site has today

Read on Oct 8, 2026 with `pnpm --filter @west4/guest check:domain -- --host west4karaoke.com`, from public DNS and the old site's own sitemap:

- The site is on Wix. `west4karaoke.com` answers 301 to `www.west4karaoke.com`, which is a CNAME to Wix.
- Email is Google Workspace: five `aspmx.l.google.com` MX records, one SPF record and one DMARC record. No DKIM record was found at the `google` selector; confirm the selector in the Google Admin console (Apps → Gmail → Authenticate email) before the move.
- The sitemap lists five URLs: `/`, `/menu`, `/menu?menu=menu`, `/room` and `/reservation`. They're in `apps/guest/legacy-redirects.ts`.

## The old URLs

`LEGACY_PAGES` in `apps/guest/legacy-redirects.ts` is the list; the guest web's proxy answers each one:

| Old URL | On the new site |
| --- | --- |
| `/`, `/menu`, `/menu?menu=menu` | The same page, 200 |
| `/reservation` | 301 to `/book` |
| `/room` | A joined guest's room when the phone has its room cookie; otherwise 302 to `/#rooms` (a 302 so no browser remembers it for the day it joins a room) |
| Old manage-booking links | 301 to `/booking-moved`, which gives West 4's phone number; their tokens can't carry over |
| Anything on `www.west4karaoke.com` | 301 to the same path on `west4karaoke.com`, when `SITE_HOST=west4karaoke.com` |

Before the move, add every other old URL to the list, from West 4's own accounts only (never crawl anyone else's site):

1. The Wix dashboard's page list, including hidden and unlinked pages.
2. Google Search Console for west4karaoke.com: Pages → Indexed, and Links → Top linked pages.
3. The site's analytics: every landing page with a visit in the last 12 months.
4. An old booking confirmation email: the manage link's path goes in `LEGACY_MANAGE_PREFIXES`.

`pnpm check unit` then proves each one lands on a page the new site serves.

## A week before

1. Lower the TTL on the `west4karaoke.com` and `www` records to 300 seconds. Leave every MX, SPF, DKIM and DMARC record alone.
2. Save the email records: `pnpm --filter @west4/guest check:domain -- --host west4karaoke.com --dkim <selector> --save evidence/domain/before.json --no-urls`.
3. Set up production's hostname and certificate (`infra/README.md`, Production), and issue the TLS certificate for `west4karaoke.com` and `www.west4karaoke.com` with DNS validation, so it's ready before the switch.
4. Set the production guest web's `SITE_VENUE=west4karaoke` and `SITE_HOST=west4karaoke.com`, and the API's `GUEST_APP_URL=https://west4karaoke.com`, so Booking confirmed (`/b/…`) and Receipt (`/receipt/…`) links name the new site.
5. On staging, run the redirect check against the staging guest host: `pnpm --filter @west4/guest check:domain -- --host <staging guest host>`.

The venue's own domain is set by these settings in phase 1. The `domains` table in the data model ([04](../spec/04-data-model.md)) is filled in phase 2 with the website builder, and doesn't exist yet; there's no row to create.

## The move

1. Run the final delta import (M9-06; [import](import.md)) with the newest export, so bookings made on the old site before the move are on the board. Check its report reconciles.
2. Switch the old site's booking form off in the Wix dashboard, at the same moment.
3. Point `west4karaoke.com` and `www` at production, as `infra/README.md` names them. Change nothing else in the zone.
4. When the new records show (`dig +short west4karaoke.com`), run `pnpm --filter @west4/guest check:domain -- --host west4karaoke.com --dkim <selector> --expect evidence/domain/before.json`. It fails when an email record changed, the certificate isn't valid, or any old URL answers 4xx or 5xx.
5. Send a test email to a West 4 address from outside, and reply to it.
6. Open the first Booking confirmed link and the first Receipt link sent after the move; each opens on west4karaoke.com.
7. Keep the output in `evidence/domain/`.

## Rollback

If the check fails and can't be fixed on the spot: point the two records back at Wix (`www` CNAME `cdn3.wixdns.net`; the apex A records the Wix dashboard names), switch the old booking form back on, and tell the founder. Bookings made on the new site meanwhile stay on the board; staff call those guests. With the TTL at 300 seconds, the rollback reaches most phones in five minutes.

## Afterwards

Raise the TTLs back to an hour after a week with no problems. Keep the Wix site unpublished, not deleted, until a full month of live nights passes (M9-17).
