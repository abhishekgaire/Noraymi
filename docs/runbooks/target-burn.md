# A published target is burning its error budget

**Rule:** `target-burn` · pages us during opening hours · clears when the burn stops.

**What fired.** One of the published targets (spec 01 · Targets) is spending its error budget too fast, on both a long and a short window: 14.4× (1 hour and 5 minutes) or 6× (6 hours and 30 minutes). Either:

- a CloudWatch alarm on ordering, payments or printing availability (99.9% a month), or
- the alert sweep's order-to-bar-alarm check (95% under 3 seconds), over the venues open now.

Outside opening hours a CloudWatch burn opens a ticket-severity page that wakes nobody.

**Why it matters.** Orders, payments or printing are failing for guests and staff.

## First five minutes

1. Acknowledge the page.
2. The CloudWatch dashboard: which part, since when, which routes (5xx).
3. A deploy in the last hour? Roll it back.

## Fix

- **5xx on one part**: the API's logs for the failing route; the database; the vendor (Stripe, the printers' CloudPRNT polls).
- **Order to alarm slow**: the bar computer's chime polls every 5 seconds (M3-16), so up to 5 seconds is expected until it rings on the `order.ringing` event (M8-16's finding). Check the bar computer is online.
- Post on the status page if guests see it.

**Over when** the burn drops below the threshold (CloudWatch OK, or the sweep no longer finds it).
