#!/usr/bin/env bash
# Puts values into the secrets Terraform created. Random keys are generated
# here and never written anywhere else; Stripe and Twilio get placeholders to
# replace by hand. Safe to re-run: a secret that already has a value is kept.
set -euo pipefail
env="${1:-staging}"
put_if_empty() {
  local name="west4/${env}/$1" value="$2"
  if aws secretsmanager get-secret-value --secret-id "$name" --query SecretString --output text >/dev/null 2>&1; then
    echo "keep  $name"
  else
    aws secretsmanager put-secret-value --secret-id "$name" --secret-string "$value" >/dev/null
    echo "set   $name"
  fi
}
put_if_empty pin-pepper "$(openssl rand -hex 32)"
put_if_empty badge-master-key "$(openssl rand -hex 16)"
put_if_empty origin-verify "$(openssl rand -hex 24)"
put_if_empty app-db-password "$(openssl rand -hex 24)"
put_if_empty stripe '{"secret_key":"sk_test_replace_me","publishable_key":"pk_test_replace_me","webhook_secret":"whsec_replace_me"}'
put_if_empty twilio '{"account_sid":"ACreplace_me","auth_token":"replace_me","from_number":"+15005550006"}'
