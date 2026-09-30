# West 4 Karaoke platform

One system that runs a karaoke venue's whole night:

- booking and deposits
- private rooms billed by the minute
- ordering from guests' phones
- the bar POS with card tabs that grow
- bar-style karaoke with a singer queue
- staff sign-in, tips and the end-of-night close
- the venue's own website

It's built for many venues, and West 4 Boho Karaoke (186 W 4th St, New York) is the first.

**Status (Sep 29, 2026):** planned and specified, with no code yet. Phase 1 takes West 4 live. It runs as nine milestones and 233 tickets, ending at a 4-week gate of live nights without a money error.

## Start building

This repo is meant for building in a terminal with [Claude Code](https://docs.claude.com/en/docs/claude-code/overview). From the repo root:

```
claude
> Read CLAUDE.md, then start ticket M1-01.
```

[CLAUDE.md](CLAUDE.md) has the rules, the definition of done and how to work a ticket. The first ticket, [M1-01](docs/backlog/M1-foundations.md), creates the monorepo, its tooling and the commands.

## What's here

| Path | What it is |
| --- | --- |
| [docs/README.md](docs/README.md) | Map of every document |
| [docs/spec/](docs/spec/README.md) | Technical spec, one file per area. It decides how everything works |
| [docs/milestones.md](docs/milestones.md) | Phase 1 plan: nine milestones, what each ships, when it's done, the estimate and the go-live gate |
| [docs/backlog/](docs/backlog/README.md) | 233 tickets with build steps, acceptance checks and tests |
| [docs/screens.md](docs/screens.md) | Build guide for every screen, plus the 39 screens and states the canvas doesn't draw |
| [docs/blueprint.md](docs/blueprint.md) | Product blueprint: venue types, modules, New York rules, business model, phases |
| [docs/decisions.md](docs/decisions.md) | Dated decision log |
| [docs/glossary.md](docs/glossary.md) | Domain terms and the exact words on screen |
| [docs/demo-seed.md](docs/demo-seed.md) and [seed/](seed/) | The one Friday night that staging and every test run on, and 104 money test cases |
| [design/](design/README.md) | The 27 clickable screen prototypes (frozen reference) |
| [docs/archive/](docs/archive/) | The Sep 28 reviews and the research behind the decisions |

## Stack (from the spec)

| Part | Built with |
| --- | --- |
| API and job workers | TypeScript on Node.js 22 with Fastify |
| Database | PostgreSQL 16 with row-level security per venue |
| Staff app | React and Vite, for phones and the desktop |
| Desktop app at the bar and front desk | Electron, for printing, cash drawers and the offline view |
| Guest web | Next.js |
| Payments | Stripe Connect and Stripe Terminal S710 readers (server-driven) |
| Texts | Twilio |

Details are in [Scope and architecture](docs/spec/01-scope-architecture.md).
