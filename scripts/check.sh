#!/usr/bin/env bash
# pnpm check: every suite, one line each. On a failure, only the failing
# names and the first error lines are printed, never the whole log.
# Usage: pnpm check            (lint, i18n, typecheck, unit, integration, db:lint)
#        pnpm check --e2e      (also the Playwright smoke tests)
#        pnpm check unit       (one suite: lint | i18n | typecheck | unit | integration | db-lint | e2e | principals | walls | load)
#        The principal and venue-wall suites (M1-37) are part of integration; name them to run one alone.
#        pnpm check load runs the Friday-night load test (M8-21) on its own; it is never part of a default run.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 && nvm use >/dev/null 2>&1
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failed=0

run() { # name command...
  local name="$1"; shift
  local log="$tmp/$name.log"
  if "$@" >"$log" 2>&1; then
    printf '%-12s ok   %s\n' "$name" "$(summary "$name" "$log")"
  else
    failed=1
    printf '%-12s FAIL %s\n' "$name" "$(summary "$name" "$log")"
    grep -E '^\s*(×|✖|FAIL|error|Error:|AssertionError|\[warn\]|[a-zA-Z0-9_./-]+\.(ts|tsx|sql|yml)[(:][0-9]+)' "$log" | grep -v -E 'Test Files|Tests |Run Prettier' | head -12 | sed 's/^/    /'
  fi
}

summary() { # name log → a short figure
  case "$1" in
    unit|integration|e2e|principals|walls|load) grep -h -E 'Tests |passed \(|failed \(' "$2" | tail -2 | tr -s ' ' | tr '\n' ' ' | sed 's/^ *//' ;;
    typecheck) printf '%s projects' "$(grep -c 'typecheck: Done' "$2" 2>/dev/null || echo 0)" ;;
    db-lint|i18n) tail -1 "$2" ;;
    lint) printf '%s' "$(grep -c -E 'error|warn' "$2" | sed 's/^0$//')" ;;
  esac
}

suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(lint i18n typecheck unit integration db-lint)
if [ "${1:-}" = "--e2e" ]; then suites=(lint i18n typecheck unit integration db-lint e2e); fi

for s in "${suites[@]}"; do
  case "$s" in
    lint) run lint pnpm lint ;;
    i18n) run i18n pnpm i18n:check ;;
    typecheck) run typecheck pnpm typecheck ;;
    unit) run unit pnpm exec vitest run --reporter=dot ;;
    integration) run integration pnpm exec vitest run --config vitest.integration.config.ts --reporter=dot ;;
    principals) run principals pnpm exec vitest run --config vitest.integration.config.ts --project api:integration apps/api/src/security/principals apps/api/src/security/planted-leak --reporter=dot ;;
    walls) run walls pnpm exec vitest run --config vitest.integration.config.ts --project api:integration apps/api/src/security/walls apps/api/src/security/planted-leak --reporter=dot ;;
    load) run load pnpm exec vitest run --config apps/api/vitest.load.config.ts --reporter=dot ;;
    db-lint) run db-lint pnpm db:lint ;;
    e2e) run e2e pnpm e2e ;;
    --e2e) ;;
    *) echo "unknown suite $s"; failed=1 ;;
  esac
done
exit $failed
