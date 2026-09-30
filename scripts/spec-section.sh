#!/usr/bin/env bash
# Print one section of a spec or doc, not the file: the lines from the first
# match of PATTERN to the next heading (## …) or bold lead-in (**Word.**).
# Usage: scripts/spec-section.sh docs/spec/02-tenancy-access.md 'The database walls'
#        scripts/spec-section.sh docs/backlog/M1-foundations.md '### M1-16 '   (a ticket)
set -eu
file="$1"; pattern="$2"
awk -v pat="$pattern" '
  BEGIN { on = 0 }
  {
    if (!on && index($0, pat) > 0) { on = 1; print; next }
    if (on && ($0 ~ /^## / || $0 ~ /^### / || $0 ~ /^\*\*[A-Z][^*]*\.\*\*/)) exit
    if (on) print
  }' "$file"
