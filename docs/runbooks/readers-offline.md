# Every card reader at a venue is offline

**Rule:** `readers-offline` · pages us · clears when a reader is back.

**What fired.** During the venue's opening hours, every live card reader (not training) has gone two minutes without a heartbeat (spec 09 · Heartbeats; Stripe's own 2-minute rule). One device going quiet only tells the manager ([device-offline](device-offline.md)); losing every reader puts the money path at risk, so it pages us.

## First five minutes

1. Acknowledge the page.
2. Console venue list: is the whole venue offline (router, internet) or only the readers?
3. Stripe's status page: is Terminal down?

## Fix

- **Venue internet down**: the venue's manager follows the outage steps; the router should be on cellular backup.
- **Readers only**: the manager restarts them; check Wi-Fi.
- **Nothing helps**: the manager takes cards with the break-glass card (Tap to Pay in Stripe's Dashboard app) and matches them later under "Unmatched payments" (D54).

**Over when** at least one reader is back online.
