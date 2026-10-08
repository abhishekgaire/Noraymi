# Radar rules for venue accounts (spec 12 · 8)

Radar's custom rules can't be set through the API; they're added by hand in each venue's Stripe account (Dashboard → Radar → Rules), and only where the account's plan allows custom rules (Radar for Fraud Teams). Every account gets Radar's default machine-learning blocking regardless. Our own per-venue decline-rate alarm ([runbook](../runbooks/decline-rate.md)) covers every account either way.

Rules to add for online payments (the booking deposit and Pay my share), card-present payments are left alone:

| Rule | Why |
| --- | --- |
| `Block if :cvc_check: = 'fail'` | Card testing guesses details |
| `Block if :address_zip_check: = 'fail'` | Same, where the form asks for a ZIP |
| `Review if :card_count_for_ip_address_daily: > 3` | One IP trying many cards |
| `Block if :declined_charges_per_ip_address_hourly: > 5` | A burst of declines from one IP, matching our alarm |
| `Block if :risk_level: = 'elevated' and :amount_in_usd: < 5` | Small test charges (our deposits are never this small) |

Record, per venue, whether the rules are on and the date, in the venue's row of the [PCI responsibility matrix](pci-responsibility.md). West 4: not yet (needs the venue's live account).
