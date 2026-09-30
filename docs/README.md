# Docs

Every document in this repo and what it's for. If two of them disagree, [which document wins](spec/README.md#which-document-wins) settles it: the spec first, then the blueprint, then the canvas.

## To build

| Document | Use it for |
| --- | --- |
| [Milestones](milestones.md) | The phase 1 plan: nine milestones in build order, what each ships, its done-when checks, the estimate, the must-fix items and the go-live gate |
| [Backlog](backlog/README.md) | 233 tickets, one file per milestone, each with its spec links, build steps, acceptance checks and tests |
| [Spec](spec/README.md) | How everything works, one file per area. Start at its index |
| [Screens](screens.md) | For each canvas screen: what it becomes, and every place to build differently from the drawing. Also the screens and states the canvas doesn't have |
| [Glossary](glossary.md) | Domain terms, order statuses, role names and the exact words staff and guests see |
| [Demo seed](demo-seed.md) | The one Friday night (Sep 25, 2026, 10:41 PM) that staging and every end-to-end test use. The data is in [`seed/west4-friday.json`](../seed/west4-friday.json) |
| [Money cases](../seed/money-cases.json) | 104 expected results, in cents, that the money rules must reproduce |

## To understand

| Document | Use it for |
| --- | --- |
| [Blueprint](blueprint.md) | What we're building and for whom: venue types, modules, settings, New York rules, integrations, business model and phases |
| [Decisions](decisions.md) | Each decision's date, the reason and where it's specified |
| [Open technical questions](spec/14-open-questions.md) | What's still open, who answers it and which milestone waits on it |
| [Design canvas](../design/README.md) | How to open the 27 prototypes, and what each one is |

## History

[`archive/`](archive/) keeps the inputs behind the decisions:

- the Sep 28 flow, completeness and competitive reviews
- the Sep 26 gap review
- the Sep 28 fix brief
- the research on staff-first bar POS design and the karaoke POS gap analysis

They record why things changed. They aren't instructions: where they disagree with the spec, the spec is current.
