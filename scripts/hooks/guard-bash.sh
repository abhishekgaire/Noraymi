#!/usr/bin/env bash
# PreToolUse hook on Bash: refuses commands that would pull a big file into
# the conversation whole. Exit 2 blocks the call and hands the message back.
input="$(cat)"
cmd="$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)"
case "$cmd" in
  *"cat seed/"*|*"cat docs/spec/"*|*"cat docs/archive"*|*"cat design/"*|*"cat docs/screens.md"*|*"cat docs/blueprint.md"*|*"cat docs/decisions.md"*|*"cat pnpm-lock"*)
    echo "Blocked: that reads a large file whole. Use scripts/spec-section.sh <file> '<heading>' for one section, or grep -n / sed -n 'a,bp' for a range." >&2
    exit 2 ;;
  *"git diff"*)
    case "$cmd" in *"--stat"*|*"--name-only"*|*" -- "*) ;; *)
      echo "Blocked: git diff without --stat prints whole files. Use git diff --stat, or git diff -- <one file>." >&2; exit 2 ;;
    esac ;;
esac
exit 0
