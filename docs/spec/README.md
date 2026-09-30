# Technical spec index

Sep 29, 2026 · the technical spec for phase 1 of the karaoke-venue POS and operations platform: West 4 Boho Karaoke (186 W 4th St, New York) goes live on a backend built for many venues. These files are the source of truth from now on. The build order is in [milestones](../milestones.md).

## The files

| File | What's in it |
| --- | --- |
| [01 · Scope and architecture](01-scope-architecture.md) | What phase 1 ships and what waits, the parts and the stack, the targets, and what happens when the internet or our cloud goes down |
| [02 · Tenancy and access](02-tenancy-access.md) | Venue walls in Postgres, who can call what, PINs and badges, the default roles, the reason-only limit, approvals, languages, offboarding and support access |
| [03 · Settings, rule packs and modules](03-settings-rule-packs-modules.md) | Every settings key and its type, when a change starts, the New York rule pack and promotion checks, modules with their dependencies and what each hides, and plan billing |
| [04 · Data model](04-data-model.md) | Every table, and the money core in SQL |
| [05 · Money rules](05-money-rules.md) | How every amount is worked out, with Room 9 worked through |
| [06 · Stripe setup](06-stripe-setup.md) | Connected accounts, onboarding, readers, safe-to-repeat calls, webhooks, keys, payouts and disputes |
| [07 · Payment flows](07-payment-flows.md) | Deposits, room close-out, Pay my share, bar tabs with growing holds, songs, refunds and the card fee |
| [08 · API](08-api.md) | Conventions, the phase 1 endpoints and live events |
| [09 · Devices, printing and offline](09-devices-printing-offline.md) | Pairing, the bar alarm, tickets, cash drawers, tablets, phones, heartbeats, and what happens offline |
| [10 · Staff screens and the bar POS](10-staff-screens-bar-pos.md) | The rules every staff screen follows, the bar POS, the words on every staff screen, and the timed targets |
| [11 · Song systems and texts](11-song-systems-texts.md) | Song-system adapters, the mic power trial, bar mode, the songbook, and texting through Twilio |
| [12 · Security and data retention](12-security-retention.md) | The security baseline, training mode, how long we keep each kind of data, and erasing a guest |
| [13 · Testing and operations](13-testing-operations.md) | Environments and the demo seed, the tests, the staff trial, drills, watching production, on-call, backups and releases |
| [14 · Open technical questions](14-open-questions.md) | What's still open, who answers, and which milestone each blocks |
| [15 · Sources](15-sources.md) | The Stripe docs, laws, standards and research behind the spec |

## Other docs

| Doc | What's in it |
| --- | --- |
| [Milestones](../milestones.md) | The phase 1 build plan, the estimate, the go-live gate and the must-fix table (GA-M1 to GA-M11) |
| [Blueprint](../blueprint.md) | The product: modules, the settings each venue controls, the rule pack, integrations, the business model and the five phases |
| [Decisions](../decisions.md) | Each decision, when it was made and why |
| [Screens](../screens.md) | The screens and what each one shows |
| [Glossary](../glossary.md) | The product's words and what they mean |
| [Demo seed](../demo-seed.md) | West 4 at Fri Sep 25, 2026, 10:41 PM: the facts every screen, staging and the end-to-end tests share |
| [Design canvas](../../design/canvas/) | The 27 clickable prototype boards, frozen before the Sep 28 decisions |
| [Archive](../archive/) | The reviews, briefs and research that led here; history, never a source |

## Which document wins

1. **This spec** decides how the product works.
2. **The [blueprint](../blueprint.md)** decides what the product is and in which phase each part ships. Where it disagrees with the spec, the spec wins and the blueprint gets fixed.
3. **The [design canvas](../../design/canvas/)** shows how the screens look. Where a board disagrees with the spec or the blueprint, or a state has no board, build what the spec says.

[Decisions](../decisions.md) records why: each decision's date, the finding behind it and where it's specified. To change a decision, add a row there that names the one it replaces, then change the spec.

## Conventions

- **Money** is an integer number of cents with `currency: "usd"`, never a float. A percentage applies to a total and rounds half up to the cent, and a divided amount hands its leftover cents to the largest remainders, so the parts always add up.
- **Business date.** Every sale, payment, shift and drawer move belongs to the night it happened in: its local time minus the venue's day cutover (6:00 AM at West 4), stamped when the row is written. A 2:30 AM sale on Saturday belongs to Friday's business date. Day-of-week rules count minutes from midnight at the start of the business date, so 12:30 AM is minute 1,470.
- **Time zone.** West 4 runs on New York time (`America/New_York`). Timestamps are stored as `timestamptz` and shown in the venue's time zone. Closing times and the alcohol window follow the wall clock through daylight saving, while billing counts the minutes that actually pass.
- **Codes.** C, F and K are findings of the Sep 28 [completeness](../archive/review-completeness-sep28.md), [flows](../archive/review-flows-sep28.md) and [competitive](../archive/review-competitive-sep28.md) reviews; GA-M, GA-S and GA-N are the [gap analysis](../archive/research/karaoke-bar-pos-gap-analysis.md) items; D is a [decision](../decisions.md); and M1 to M9 are the [milestones](../milestones.md).
- **Cross-references.** A section named in plain text, such as "Money rules 5" or "Tenancy and access · Approvals", is that part of the spec file with that name.
- **Words.** Plain, short words and US spelling. The words staff and guests see are fixed in [Staff screens and the bar POS](10-staff-screens-bar-pos.md) and the [glossary](../glossary.md): "Ask the room to wait", "Charge the remaining tabs" and "badge or name and PIN", for example.
