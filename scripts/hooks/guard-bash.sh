#!/usr/bin/env bash
# PreToolUse hook on Bash: refuses an *unfiltered* dump of a big file into the
# conversation. A command that pipes the file through head, tail, grep, sed,
# awk, wc, cut, python3, jq, sort or uniq is fine, because it prints a slice.
# A deliberate whole-file read is allowed by prefixing the command with
# WEST4_ALLOW_FULL=1. Exit 2 blocks the call and hands the message back;
# nothing is ever edited.
input="$(cat)"
cmd="$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)"

case "$cmd" in *WEST4_ALLOW_FULL=1*) exit 0 ;; esac

big='seed/|docs/spec/|docs/archive|design/|docs/screens\.md|docs/blueprint\.md|docs/decisions\.md|pnpm-lock'
if printf '%s' "$cmd" | grep -q -E "(^|[[:space:];&|(])cat +[^|;&]*($big)"; then
  if printf '%s' "$cmd" | grep -q -E "\| *(head|tail|grep|sed|awk|wc|cut|python3|jq|sort|uniq)"; then exit 0; fi
  echo "Blocked: that prints a large file whole. Pipe it through head/tail/grep/sed for a slice, use scripts/spec-section.sh <file> '<heading>' for one section, or prefix the command with WEST4_ALLOW_FULL=1 if the whole file is really needed." >&2
  exit 2
fi

case "$cmd" in
  *"git diff"*)
    case "$cmd" in *"--stat"*|*"--name-only"*|*" -- "*|*"| head"*|*"| grep"*) ;; *)
      echo "Blocked: git diff without --stat prints whole files. Use git diff --stat, git diff -- <one file>, or pipe through head." >&2; exit 2 ;;
    esac ;;
esac
exit 0
