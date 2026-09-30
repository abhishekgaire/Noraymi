# CLAUDE.md

A POS and operations platform for karaoke venues, built for many venues from day one. The first venue is West 4 Boho Karaoke (186 W 4th St, New York): 14 private rooms, a bar with bar-style karaoke, open until 4 AM.

**Current state:** the repo holds the plan and the spec only, with no code yet. Phase 1 is broken into tickets in `docs/backlog/`, and the code gets built from them in order, starting with M1-01.

## Where things are

| Need | Go to |
| --- | --- |
| The next thing to build | `docs/backlog/README.md`. Take the first `todo` ticket, in milestone order, whose dependencies are `done`. |
| How a feature must work | `docs/spec/` (start at `docs/spec/README.md`) |
| The plan, each milestone's done-when, and the go-live gate | `docs/milestones.md` |
| What a screen must do, and where to ignore the canvas | `docs/screens.md` |
| The exact words staff and guests see | `docs/glossary.md`. The spec's vocabulary table is in `docs/spec/10-staff-screens-bar-pos.md`. |
| The one Friday night that staging and every test use | `docs/demo-seed.md` and `seed/west4-friday.json` |
| Expected money results the rules must reproduce | `seed/money-cases.json` |
| Why something is the way it is | `docs/decisions.md` (D1–D84, newest first) |
| Product scope and phases | `docs/blueprint.md` |
| Questions still open, and who answers them | `docs/spec/14-open-questions.md` |
| How the screens look | `design/canvas/`. See `design/README.md` to open it. |

`docs/archive/` holds the reviews and research the decisions came from. It's history, not instructions.

## Which document wins

1. **The spec** (`docs/spec/`) decides how everything works.
2. **The blueprint** decides what's in which phase.
3. **The design canvas** shows how screens look. It's frozen at v39 and predates the Sep 28 decisions. Wherever it disagrees with the spec, or a state isn't drawn, build what the spec says; `docs/screens.md` lists every difference.

If the spec is silent or contradicts itself, don't invent an answer. Ask the founder, or, if the ticket names a cautious default, build that as a setting and note it in the ticket. When a decision changes, add a row to `docs/decisions.md` naming the one it replaces, then update the spec in the same commit.

## Rules that never bend

- **Money** is an integer number of cents, never a float. Percentages round half up to the cent. A divided amount hands its leftover cents out by largest remainder, so the parts always add up.
- **Business date.** Every sale, payment, shift and drawer move gets one: local time minus the 6:00 AM cutover, in `America/New_York`, stored as `timestamptz`. Billing counts real minutes through daylight saving.
- **Tenancy.**
  - Row-level security is forced on every venue table.
  - No query, job or event may cross venues.
  - Every route gets a test as every principal.
- **Outside calls.**
  - Never call Stripe, Twilio or any other outside service inside a database transaction.
  - Every outside write carries an idempotency key.
  - An unknown payment result is settled by the reconciler ("Checking with Stripe · don't retry"), never by a retry.
- **Card data** never touches our servers or logs. Readers are Stripe Terminal, server-driven. Online payments use the Payment Element on its own origin.
- **Alcohol rules are enforced on the server** for every route that can create an alcohol line: the 4 AM stop, cut-offs, 86'd items and ID checks. Screens only show the result.
- **Room orders** are sold at Accept. Delivered never charges. After 4 AM, alcohol orders nobody accepted are cancelled automatically.
- **Approvals** are decided on the approver's own phone, never by the person asking.
- **Words on screen** come from the glossary and the spec's vocabulary table. Staff screens ship in English and Spanish, so no UI text is hard-coded outside the i18n catalogs.
- **Integrations are partnerships only.** Never scrape or reverse-engineer a third-party system (Playbox, TJ, KaraFun or any other).
- **Legal points in the spec were verified by the owner's advisers.** Don't change them. An open question gets the cautious default as a setting until it's answered.
- **Never invent venue facts** such as an occupancy limit, license numbers or a song price. Leave them empty with a hint in the UI.

## How to work a ticket

1. Set the ticket's Status to `doing`.
2. Read every spec link in the ticket. For UI work, also read its `docs/screens.md` entry and the glossary terms it uses.
3. For money and time rules, write the tests first, from the `seed/money-cases.json` groups the ticket names.
4. Build what the ticket says, no more. If you find a gap or a contradiction, stop and ask, or take the cautious default the ticket names and write it in its Notes.
5. Run lint, typecheck and the tests. When every Acceptance line passes, set Status to `done` and record anything that changed in Notes.
6. Commit with the ticket ID first, for example `M1-03: force row-level security on venue tables`.

## Definition of done

- Every Acceptance line in the ticket passes, and each is checked by an automated test wherever it can be.
- **Tests:**
  - Unit tests for rules.
  - Integration tests against Postgres with row-level security on, and against Stripe test mode with simulated readers when payments are touched.
  - End-to-end (Playwright) tests for screens that changed, starting from a fresh load of the demo seed.
- Lint, typecheck and every test pass locally and in CI.
- **Money:** the relevant `seed/money-cases.json` groups pass, and no float touches an amount.
- **Staff screens:**
  - English and Spanish strings.
  - The glossary's words.
  - Every state the spec lists: loading, empty, error, and offline where it applies.
  - Touch targets of at least 44 px.
- **Security:** every new table has row-level security and a venue-wall test. Secrets come only from the environment. Nothing sensitive is logged.
- **Docs:** if the behavior differs from the spec, the spec changes in the same commit (with a `docs/decisions.md` row if a decision changed). The ticket's Status and Notes are up to date.

## Planned layout (M1-01 creates it)

```
apps/api        Fastify API and job workers (TypeScript, Node.js 22 LTS)
apps/staff      staff app: React + Vite, phone and desktop layouts, service worker
apps/desktop    Electron shell around the staff app: USB print host, drawer kick, alarm, encrypted offline cache
apps/guest      guest web: Next.js (site, booking, waitlist, room join and ordering, bill and Pay my share, singer queue, receipts)
apps/console    minimal internal Console: React + Vite on its own hostname
packages/db     plain SQL migrations, row-level security policies, seed loader, test helpers
packages/rules  pure money and time rules, tested against seed/money-cases.json
packages/shared settings and API types, cent helpers, i18n strings (English and Spanish)
```

Tooling: pnpm workspaces, TypeScript strict, ESLint and Prettier, Vitest, Playwright, Docker Compose (Postgres 16 and an S3-compatible store), GitHub Actions, Stripe test mode with simulated Terminal readers, the Stripe CLI, and Twilio test credentials.

## Commands

M1-01 creates these. Update this list whenever a command is added or renamed.

```
pnpm install          # install everything
docker compose up -d  # Postgres 16 and the local S3 store
pnpm db:migrate       # apply migrations (pnpm db:reset rebuilds the local database)
pnpm seed             # load the demo seed; the simulated clock is Fri Sep 25, 2026, 10:41 PM
pnpm dev              # run the apps
pnpm lint && pnpm typecheck && pnpm test
pnpm e2e              # Playwright end-to-end tests
```

## The demo seed

"Now" is **Fri Sep 25, 2026, 10:41 PM** in New York, on business date Fri Sep 25. Staging, tests and every demo use it.

**Room 9** (Marcus T., party of 12) is the worked example:

| Line | Amount |
| --- | --- |
| Room time, 161 min × $2.00 | $322.00 |
| Drinks | $158.00 |
| Tax (8.875%) | $42.60 |
| Gratuity (20%, before tax) | $96.00 |
| **Total** | **$618.60** |
| Deposit | −$120.00 |
| **Left to pay** | **$498.60** |

Never read the device clock for demo data. Use the seed's simulated clock.

## The design canvas

`design/canvas/*.dc.html` are the clickable prototypes: 27 screens with their demo data in each file's script. To open them, run `cd design/canvas && python3 -m http.server 8765` and go to `http://localhost:8765/Board.dc.html`. Don't edit them; they're a reference, not a spec.
