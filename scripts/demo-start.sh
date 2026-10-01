#!/usr/bin/env bash
# Local only: start the demo night you can click through, in one go.
#   - the database, the file store and the mail catcher (Docker),
#   - the API, its job worker, the staff app and the guest site, with the demo settings the
#     tests use (your .env isn't read, so no real Twilio or Stripe key is ever loaded),
#   - then scripts/demo-local.sh: a fresh seed at 10:41 PM and your invite links.
# Logs go to .demo-logs/. Press Ctrl+C to stop everything.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .demo-logs

for port in 3000 3001 5173; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop whatever runs there (or an earlier demo-start) first." >&2
    exit 1
  fi
done

docker compose up -d >/dev/null 2>&1
pnpm build:packages >/dev/null
pnpm db:migrate >/dev/null

export WEST4_ENV=local ALLOW_STAGING_FEATURES=true
export DATABASE_URL=postgres://west4:west4@localhost:5432/west4
export APP_DATABASE_URL=postgres://app_rw:app_rw@localhost:5432/west4
export WEBAUTHN_RP_ID=localhost WEBAUTHN_ORIGINS=http://localhost:3000,http://localhost:5173
export S3_ENDPOINT=http://localhost:9000 S3_REGION=us-east-1 S3_ACCESS_KEY_ID=west4
export S3_SECRET_ACCESS_KEY=west4secret S3_BUCKET_FILES=west4-files S3_BUCKET_AUDIT=west4-audit
export SMTP_URL=smtp://localhost:1025 EMAIL_FROM="West 4 <no-reply@west4.local>"

pids=()
pnpm --filter @west4/api dev:test >.demo-logs/api.log 2>&1 & pids+=($!)
(cd apps/api && pnpm exec tsx src/worker.ts) >.demo-logs/worker.log 2>&1 & pids+=($!)
pnpm --filter @west4/staff dev >.demo-logs/staff.log 2>&1 & pids+=($!)
pnpm --filter @west4/guest dev >.demo-logs/guest.log 2>&1 & pids+=($!)
trap 'echo; echo "Stopping…"; kill "${pids[@]}" 2>/dev/null; wait 2>/dev/null; exit 0' INT TERM

printf "Starting"
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:3000/v1/health >/dev/null && curl -sf -o /dev/null http://localhost:5173/ && break
  printf "."; sleep 2
done
echo
scripts/demo-local.sh
cat <<'MSG'

Ready. Open these in Chrome:
  Staff app (Tonight, Admin…)   http://localhost:5173
  Guest waitlist page           http://localhost:3001/v/west4karaoke/waitlist
  Local email inbox (codes)     http://localhost:8025
Sign-in codes texted or emailed: scripts/demo-codes.sh (in a second terminal)
Press Ctrl+C here to stop everything.
MSG
wait
