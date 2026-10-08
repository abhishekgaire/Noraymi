# Drill records

One file per drill, made from a script's output and completed by hand:

- **Live payment drill:** `<business date>.md`, made with `pnpm --filter @west4/api drill:record` as `docs/runbooks/live-payment-drill.md` says. None yet: the first drill runs once West 4's Stripe onboarding is finished and both S710s are registered.
- **Outage drill:** `<business date>-outage.md` with its screenshots in `<business date>-outage/`, made with `pnpm --filter @west4/api outage:record` as `docs/runbooks/outage-drill.md` says. None yet: the drills run once the router and both S710s are installed at West 4.
- **Restore drill (monthly):** `<date>-restore.md` with the evidence JSON from `restore:venue --drill`, as `docs/runbooks/restore-drill.md` says. None yet: the first runs once the backup plan is applied on staging (`terraform apply` in `infra/staging`).
- **Region failover drill (yearly):** `<date>-region.md`, as `docs/runbooks/region-failover.md` says.
