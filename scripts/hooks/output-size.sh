#!/usr/bin/env bash
# PostToolUse hook on Bash: when a command's output is big, say so, so the
# next command filters. Exit 2 sends the message back as feedback.
input="$(cat)"
size="$(printf '%s' "$input" | python3 -c '
import sys, json
d = json.load(sys.stdin)
r = d.get("tool_response", {})
text = r if isinstance(r, str) else (r.get("stdout", "") or "") + (r.get("stderr", "") or "")
print(len(text))' 2>/dev/null || echo 0)"
limit="${WEST4_OUTPUT_LIMIT:-6000}"
if [ "$size" -gt "$limit" ]; then
  echo "This output was $size characters. Filter the next one (grep -E, tail, head, --reporter=dot) or write it to a file and read a slice." >&2
  exit 2
fi
exit 0
