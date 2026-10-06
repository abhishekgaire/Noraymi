#!/usr/bin/env bash
# Local only: a fresh demo night you can click through yourself.
#   1. reloads West 4 from the demo seed (Fri Sep 25, 2026);
#   2. sets the running API's clock to 10:41 PM (if the API is up);
#   3. removes the seed's placeholder passkeys for Abhishek (owner) and Andy (manager),
#      and prints an invite link for each, so you can make your own passkey (Touch ID) on this computer.
# Then: open a link, enter any US mobile number, get the code with scripts/demo-codes.sh, and add your passkey.
set -euo pipefail
cd "$(dirname "$0")/.."
psql() { docker compose exec -T postgres psql -U west4 -At -c "$1"; }

pnpm seed >/dev/null
# The night's Stripe side (M4-10): deposits backed by PaymentIntents and the two readers, on the fake.
# Demo mode never reads .env, so real keys never load here; it skips itself when the fake isn't up.
(cd apps/api && pnpm exec tsx src/stripe/seed-stripe.ts 2>&1 | tail -1)
# The slips' photos (M6-27) in the local object store; skipped with a warning when it isn't up.
(cd apps/api && S3_ENDPOINT=${S3_ENDPOINT:-http://localhost:9000} S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID:-west4} \
  S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY:-west4secret} pnpm exec tsx src/files/seed-files.ts 2>&1 | tail -1) || true
echo "Seeded West 4: Fri Sep 25, 2026."
if curl -sf http://127.0.0.1:3000/v1/health >/dev/null; then
  curl -sf -X POST http://127.0.0.1:3000/v1/ops/clock -H 'content-type: application/json' \
    -d '{"server_time":"2026-09-26T02:41:00Z"}' >/dev/null && echo "Clock set to 10:41 PM."
else
  echo "The API isn't running yet; start it, then run this script again to set the clock."
fi

for email in abhishek@demo.west4.local andy@demo.west4.local; do
  psql "delete from auth_credentials where user_id = (select id from users where email = '$email')" >/dev/null
  token=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
  hash=$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)
  psql "insert into invites (venue_id, membership_id, token_hash, expires_at)
          select m.venue_id, m.id, '$hash', now() + interval '2 days'
            from memberships m join users u on u.id = m.user_id where u.email = '$email'" >/dev/null
  echo "Invite for $email: http://localhost:5173/invite/$token"
done
