#!/usr/bin/env bash
# Stripe API versions (M4-01): one pinned version for the whole codebase
# (STRIPE_API_VERSION in apps/api/src/stripe/client.ts). Only the Accounts v2
# module and the surcharge path (M4-25) may name another. Fails on any other
# Stripe version string in the code.
set -u
cd "$(dirname "$0")/.."
allowed='^apps/api/src/stripe/(client|accounts|surcharge[^/]*)\.ts:'
found=$(grep -rnoE "[\"'\`][0-9]{4}-[0-9]{2}-[0-9]{2}\.[a-z]+[\"'\`]" apps packages \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next 2>/dev/null | grep -vE "$allowed")
if [ -n "$found" ]; then
  echo "a Stripe API version outside the pinned client, the Accounts v2 module or the surcharge path:"
  echo "$found"
  exit 1
fi
echo "stripe versions ok"
