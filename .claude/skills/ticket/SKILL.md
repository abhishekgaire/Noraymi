---
name: ticket
description: Work one backlog ticket (for example /ticket M1-16) the CLAUDE.md way, with the least context: read only what the ticket names, build, run pnpm check, write the notes, record the token cost and commit.
---

# Work a ticket: /ticket <ID>

The ID is `$ARGUMENTS` (for example `M1-16`). Follow these steps in order. Every step is written to keep tokens down without cutting the build.

## 1. Open the ticket, not the file

- Note the `<total_tokens>` marker from the latest system reminder: this is the ticket's starting figure.
- Print the ticket alone: `scripts/spec-section.sh docs/backlog/<milestone file> '### <ID> '` (the M1 file is `docs/backlog/M1-foundations.md`).
- Set its Status to `doing` with one `sed` on the ticket's own block.

## 2. Read only what it names

- For each spec link in the ticket, print that section, never the file: `scripts/spec-section.sh docs/spec/<file> '<section name>'`. For a line range, `sed -n 'a,bp'`. The hooks block `cat` on the big docs for this reason.
- For UI tickets, also the ticket's `docs/screens.md` entry and the glossary terms it uses, the same way.
- If a fact is missing or the spec contradicts itself, stop and ask, or take the cautious default the ticket names and write it in Notes. Never invent a venue fact.
- Money and time rules: write the tests first from the `seed/money-cases.json` groups the ticket names. Read cases with a short `python3 -c` filter on the group, not the whole file.

## 3. Build it, once

- Write files with heredocs or the Write tool. To change an existing file, run `pnpm exec prettier --write <file>` first, then edit with the exact on-disk text (`sed -n` the lines to see them). A replace that silently misses costs a whole test cycle.
- While iterating, run only the test file you're on: `pnpm exec vitest run --project <name> <path>` or `--config vitest.integration.config.ts --project <name> <path>`, with `--reporter=dot`.
- Filter every command's output (`grep -E`, `tail`, `head`). The output hook reminds you when you don't.
- Make independent tool calls in one message.

## 4. Check everything, once

- `pnpm check` (add `--e2e` when screens changed). One line per suite; on a failure it prints the failing names only. Fix, then run just the failing suite (`pnpm check unit`), then `pnpm check` again.
- Migrate the local database when a migration was added: `pnpm db:migrate` filtered to `applying|nothing`.

## 5. Close the ticket

- Every Acceptance line ticked (`- [x]`) with a test behind it; anything that can't be checked yet stays `- [ ]` with a one-line reason.
- Notes: what was built and where, every cautious default and why, what differs from the spec, what a later ticket must pick up. If the behaviour differs from the spec, change the spec in the same commit and add a `docs/decisions.md` row.
- Add a `Tokens:` line to Notes: the difference between the starting figure and the current `<total_tokens>` marker, rounded to the thousand, labelled "context growth".
- Update CLAUDE.md's Commands section if a command was added or renamed.
- Commit as `<ID>: <ticket title>` with a short body, then `git push -q origin main`.

## 6. Report

Tell the founder, in plain words for someone new to programming: what the ticket does for the venue, what was built, what differs from the ticket, the token figure, and the next ticket. No file dumps. Then, unless told to keep going, suggest `/clear` before the next ticket: a fresh session with the SessionStart hook is the cheapest way to start one.
