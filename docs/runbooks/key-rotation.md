# Rotating keys and secrets

**When:** every 90 days for each key below, at once after anyone with access leaves or changes role (spec 12 · 5), and at once when a key may have leaked. **Overlap:** the old key stops working at most **7 days** after the new one goes in, and sooner whenever you can.

Every secret lives in AWS Secrets Manager (`infra/staging/secrets.tf`, filled by `infra/scripts/seed-secrets.sh`); the ECS services read them at start, so a new value reaches the API and the worker on their next deploy or forced restart (`aws ecs update-service --force-new-deployment`). Never paste a key into a ticket, a chat or a log.

| Secret | Variable | How it overlaps |
| --- | --- | --- |
| Stripe restricted keys (payments, refunds, reporting, billing) | `STRIPE_KEY_*` | Stripe → Developers → API keys → the key → **Rotate**, with the old key expiring in 7 days or less (Stripe offers "now", 1 hour, 24 hours, 3 days, 7 days). Put the new key in, restart, then check the old key's last-used time is before the restart. |
| Stripe webhook signing secrets (readers, connect, platform, training) | `STRIPE_WEBHOOK_SECRET_*`, `STRIPE_SANDBOX_WEBHOOK_SECRET_TRAINING` | Stripe → Webhooks → the endpoint → **Roll secret** with the old one expiring in up to 24 hours. Set the variable to `new,old` (comma-separated: the API takes either, `validStripeSignature`), restart, and when Stripe stops signing with the old one set it to `new` alone and restart. |
| Twilio | `TWILIO_AUTH_TOKEN` (and each venue subaccount's) | Twilio → Account → API keys & tokens → **Request a secondary token**, put it in, restart, then **Promote** it (the old token stops at once). Our sends retry under their idempotency keys. |
| Email provider | `SMTP_URL` | Create a second SMTP credential, put it in, restart, send a test email (sign-in code), then delete the old one. |
| CloudFront origin header | `origin-verify` | New value in the secret, `terraform apply` (CloudFront and the listener rule both read it), old value gone at once. |
| Our own | `AUTH_SECRET_KEY`, `RULE_PACK_SIGNING_KEY` | Not rotated by this runbook: `AUTH_SECRET_KEY` encrypts stored secrets and peppers PINs, and rotating it needs a re-encryption step (a later ticket). Rule-pack signing keys rotate by publishing the next key (M1-10). |

## The drill (once before go-live, then every 90 days)

On staging, during a quiet hour, rotate one Stripe restricted key (payments) and one webhook secret (readers) as above, with the synthetic check (M8-18) running every 5 minutes. Pass: the synthetic runs before, during and after all pass, no `payment_attempts` row fails on our side in the window, no webhook is refused (`stripe webhook refused` in the logs), and the old key is dead within 7 days. Write it up in `docs/security/key-rotation-drill.md`.

## After a staff change

Same steps, same day, for every key the person could see. Offboarding them in the Console and in Admin → Team comes first.
