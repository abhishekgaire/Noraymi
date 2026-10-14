#!/usr/bin/env bash
# Local only: start the demo night you can click through, in one go.
#   - the database, the file store and the mail catcher (Docker),
#   - the API, its job worker, the staff app and the guest site, with the demo settings the
#     tests use (your .env isn't read, so no real Twilio or Stripe key is ever loaded),
#   - then scripts/demo-local.sh: a fresh seed at 10:41 PM and your invite links.
# --sing-sing also makes the Sing Sing demo venue with the kitchen on, pre-filled (a testing shortcut;
#   passed to demo-local.sh).
# --onboard makes Sing Sing empty instead, the way our Console makes a new customer's venue, and prints
#   its owner's invite, for you to set it up through Set up your venue (docs/manual-test.md, "Onboard
#   Sing Sing yourself"). Not with --sing-sing.
# --lan puts the night on this laptop's Wi-Fi address over HTTPS, for bar PCs and phones on the same
#   network (docs/manual-test.md, "Practice night at Sing Sing from your laptop"); --lan-ip <address>
#   names the address when the Wi-Fi's own isn't the right one. Keeps the laptop awake while it runs.
# Logs go to .demo-logs/. Press Ctrl+C to stop everything.
set -euo pipefail
cd "$(dirname "$0")/.."
lan=0
sing=0
onboard=0
lan_ip=""
local_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --sing-sing) sing=1; local_args+=(--sing-sing) ;;
    --onboard) onboard=1; local_args+=(--onboard) ;;
    --lan) lan=1 ;;
    --lan-ip)
      lan=1
      lan_ip=${2:-}
      [ -n "$lan_ip" ] || { echo "--lan-ip needs an address, e.g. --lan-ip 192.168.1.20" >&2; exit 1; }
      shift
      ;;
    *) echo "Unknown option: $1 (the options are --sing-sing, --onboard, --lan and --lan-ip <address>)" >&2; exit 1 ;;
  esac
  shift
done
if [ "$sing" = 1 ] && [ "$onboard" = 1 ]; then
  echo "Pick one: --sing-sing makes Sing Sing pre-filled (a testing shortcut), --onboard makes it empty for you to set up. Both make the same venue, so they can't be used together." >&2
  exit 1
fi
mkdir -p .demo-logs

ports="3000 3001 5173"
[ "$lan" = 1 ] && ports="3000 3001 3002 5173 8080 9443"
for port in $ports; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop whatever runs there (or an earlier demo-start) first." >&2
    exit 1
  fi
done

if [ "$lan" = 1 ]; then
  # Every link the apps make (invites, the room's QR, Pay my share, emails) carries the Wi-Fi address.
  lan_exports=$(cd apps/api && pnpm exec tsx src/lan/env.ts ${lan_ip:+--lan-ip "$lan_ip"}) || exit 1
  eval "$lan_exports"
  # HTTPS from the laptop's own small CA: device keys, the offline cache and order ids need it.
  scripts/lan-cert.sh "$LAN_HOST" .demo-logs/lan
fi

docker compose up -d >/dev/null 2>&1
pnpm build:packages >/dev/null
pnpm db:migrate >/dev/null

export WEST4_ENV=local ALLOW_STAGING_FEATURES=true
export DATABASE_URL=postgres://west4:west4@localhost:5432/west4
export APP_DATABASE_URL=postgres://app_rw:app_rw@localhost:5432/west4
export S3_REGION=us-east-1 S3_ACCESS_KEY_ID=west4
export S3_SECRET_ACCESS_KEY=west4secret S3_BUCKET_FILES=west4-files S3_BUCKET_AUDIT=west4-audit
export SMTP_URL=smtp://localhost:1025 EMAIL_FROM="West 4 <no-reply@west4.local>"
pids=()
if [ "$lan" = 0 ]; then
  export S3_ENDPOINT=http://localhost:9000
  export WEBAUTHN_RP_ID=localhost WEBAUTHN_ORIGINS=http://localhost:3000,http://localhost:5173
  export STAFF_APP_URL=http://localhost:5173
else
  # Photos go from the browser straight to the store, so the API reaches it through the proxy too
  # (S3_ENDPOINT is on the Wi-Fi address, and Node trusts the local CA).
  export NODE_EXTRA_CA_CERTS=$PWD/.demo-logs/lan/rootCA.pem
  # The HTTPS proxy alone faces the Wi-Fi; every app stays on the laptop's loopback.
  LAN_IP=$LAN_HOST LAN_CERT=$PWD/.demo-logs/lan/cert.pem LAN_KEY=$PWD/.demo-logs/lan/key.pem \
    LAN_CA=$PWD/.demo-logs/lan/rootCA.pem pnpm --filter @west4/api lan:proxy >.demo-logs/lan-proxy.log 2>&1 &
  pids+=($!)
  # The laptop stays awake (display, disk and system) for as long as this script runs.
  caffeinate -dims -w $$ &
  pids+=($!)
fi

# The fake Stripe (M4-01): no real keys in demo mode, so card payments go to this stand-in.
pnpm --filter @west4/api stripe:fake >.demo-logs/stripe.log 2>&1 & pids+=($!)
pnpm --filter @west4/api dev:test >.demo-logs/api.log 2>&1 & pids+=($!)
(cd apps/api && pnpm exec tsx src/worker.ts) >.demo-logs/worker.log 2>&1 & pids+=($!)
if [ "$lan" = 1 ]; then
  pnpm --filter @west4/staff dev --host 127.0.0.1 >.demo-logs/staff.log 2>&1 & pids+=($!)
  pnpm --filter @west4/guest dev --hostname 127.0.0.1 >.demo-logs/guest.log 2>&1 & pids+=($!)
else
  pnpm --filter @west4/staff dev >.demo-logs/staff.log 2>&1 & pids+=($!)
  pnpm --filter @west4/guest dev >.demo-logs/guest.log 2>&1 & pids+=($!)
fi
# The marker the browser tests read: while it names a live process, they never reseed `west4` (demo-guard.ts).
echo $$ >.demo-logs/demo.pid
trap 'echo; echo "Stopping…"; rm -f .demo-logs/demo.pid; kill "${pids[@]}" 2>/dev/null; wait 2>/dev/null; exit 0' INT TERM

printf "Starting"
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:3000/v1/health >/dev/null && curl -sf -o /dev/null http://localhost:5173/ && break
  printf "."; sleep 2
done
echo
if [ "$lan" = 0 ]; then
  scripts/demo-local.sh ${local_args[@]+"${local_args[@]}"}
  cat <<'MSG'

Ready. Open these in Chrome:
  Staff app (Rooms, Admin…)     http://localhost:5173
  Guest waitlist page           http://localhost:3001/v/west4karaoke/waitlist
  Local email inbox (codes)     http://localhost:8025
Sign-in codes texted or emailed: scripts/demo-codes.sh (in a second terminal)
Press Ctrl+C here to stop everything.
MSG
  wait
  exit 0
fi

# The photo bucket lets the Wi-Fi's apps upload (after docker's own bucket setup has run).
(cd apps/api && pnpm exec tsx src/lan/s3-cors.ts) || echo "Photo uploads from the Wi-Fi may not work (see above)." >&2
# The owner and manager invites open on this laptop (localhost): passkeys can't be bound to an
# IP address, so Touch ID is set up here. Guest links (Room 9's host link…) carry the Wi-Fi address.
STAFF_APP_URL=http://localhost:5173 scripts/demo-local.sh ${local_args[@]+"${local_args[@]}"}
if ! curl -sf --cacert .demo-logs/lan/rootCA.pem -o /dev/null "https://$LAN_HOST:3000/v1/health"; then
  echo "The Wi-Fi side isn't answering on https://$LAN_HOST:3000 yet. See .demo-logs/lan-proxy.log." >&2
fi

# The macOS firewall: incoming connections must be allowed for Node.js, or the bar PCs see nothing.
fw=/usr/libexec/ApplicationFirewall/socketfilterfw
node_bin=$(node -p process.execPath)
if [ -x "$fw" ] && "$fw" --getglobalstate | grep -q enabled; then
  if "$fw" --getblockall | grep -q enabled; then
    echo
    echo "! The Mac's firewall blocks ALL incoming connections, so the bar PCs can't connect."
    echo "  System Settings → Network → Firewall → Options: turn off \"Block all incoming connections\"."
  elif ! "$fw" --listapps | grep -qF "$node_bin" || "$fw" --getappblocked "$node_bin" | grep -q blocked; then
    echo
    echo "! The Mac's firewall may stop the bar PCs from connecting. If macOS asks whether \"node\" may"
    echo "  accept incoming connections, click Allow. Or allow it now (asks for your password):"
    echo "    sudo $fw --add \"$node_bin\" && sudo $fw --unblockapp \"$node_bin\""
  fi
fi
if pmset -g batt 2>/dev/null | head -1 | grep -q 'Battery Power'; then
  echo
  echo "! The laptop is on battery. Plug it in: it serves the whole night."
fi

sing_line=""
[ "$sing" = 1 ] && sing_line=$'\n'"  Sing Sing's guest pages                  $GUEST_APP_URL/v/singsing"
cat <<MSG

Ready for the practice night on $LAN_HOST (keep this window open; the laptop stays awake).
  First, on every bar PC and phone, once   $LAN_SETUP_URL   (download and trust the certificate)
  Bar PCs: the desktop app's server        $STAFF_APP_URL
  Phones: the staff app                    $STAFF_APP_URL
  Guest pages (QR codes open these)        $GUEST_APP_URL/v/west4karaoke/waitlist$sing_line
  On this laptop (owner, Admin, invites)   http://localhost:5173
  Emails and sign-in codes (this laptop)   http://localhost:8025   or scripts/demo-codes.sh
Keep the laptop plugged in and its lid open. Press Ctrl+C here to stop everything.
MSG
wait
