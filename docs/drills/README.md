# Drill records

One file per drill, made from a script's output and completed by hand:

- **Live payment drill:** `<business date>.md`, made with `pnpm --filter @west4/api drill:record` as `docs/runbooks/live-payment-drill.md` says. None yet: the first drill runs once West 4's Stripe onboarding is finished and both S710s are registered.
- **Outage drill:** `<business date>-outage.md` with its screenshots in `<business date>-outage/`, made with `pnpm --filter @west4/api outage:record` as `docs/runbooks/outage-drill.md` says. None yet: the drills run once the router and both S710s are installed at West 4.
