# A burst of declined cards on a booking page

**Rule:** `decline-rate` · pages us · clears when the burst is over.

**What fired.** On one venue's booking page, at least 5 card attempts were declined within 10 minutes, and declines were at least half of the attempts (the alert sweep, `DECLINE_ALARM` in `apps/api/src/ops/alert-sweep.ts`). Attempts are read from `payment_attempts` with a booking.

**Why it matters.** This is what card testing looks like ([Stripe's guide](https://docs.stripe.com/disputes/prevention/card-testing)): someone uses the deposit form to check stolen cards. It costs the venue fees and can get its Stripe account restricted.

## First five minutes

1. Acknowledge the page.
2. In Stripe (the venue's connected account) → Payments, filter declined: one IP or a few, many different cards, small or equal amounts?
3. Check the booking holds: many pending web bookings from the same device or IP?

## Fix

- **Card testing**: turn on the venue's Radar rules if its account allows them ([Radar](../security/radar.md)); block the IPs in Radar's block list; the daily limits per phone, IP and device (spec 12 · 8) apply once M5-05's numbers are set. If it continues, take online booking off for the venue in Admin until it stops, and tell the owner.
- **A real problem** (a bank outage, one issuer declining everything): nothing to block; note it on the page.

**Over when** fewer than 5 declines in the last 10 minutes.
