#!/usr/bin/env bash
# SessionStart hook: the next ticket and the repo state, so a fresh session
# needs no backlog grep. Its stdout becomes context, so it stays short.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
next="$(grep -B2 '^- \*\*Status:\*\* todo' docs/backlog/M1-foundations.md | grep -m1 '^### ' | sed 's/^### //')"
doing="$(grep -B2 '^- \*\*Status:\*\* doing' docs/backlog/M1-foundations.md | grep -m1 '^### ' | sed 's/^### //')"
echo "West 4 · branch $(git rev-parse --abbrev-ref HEAD 2>/dev/null) · last commit: $(git log -1 --format='%h %s' 2>/dev/null)"
[ -n "$doing" ] && echo "Ticket in progress: $doing"
echo "Next todo ticket: ${next:-none in M1}"
[ -n "$(git status --porcelain 2>/dev/null)" ] && echo "Working tree: uncommitted changes ($(git status --porcelain | wc -l | tr -d ' ') files)"
echo "Use /ticket <id> to work a ticket; pnpm check runs every suite in one line each."
exit 0
