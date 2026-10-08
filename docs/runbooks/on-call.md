# On call (M8-17)

Spec: [Testing and operations](../spec/13-testing-operations.md) · Watching production, On call.

Two of us are on call: the **first responder** and the **second responder**. A page goes to the first at once, as an email to their Console address and, when the rota has a phone for them, a text. **A page nobody acknowledges within 10 minutes goes to the second responder.** Acknowledging stops that.

## The rota

Who is on call is configuration, empty until we set it. Each slot names one of our Console staff by their Console email:

```
pnpm --filter @west4/api oncall:set -- --slot first  --email <Console staff email> [--phone +1…] --by "<your name>"
pnpm --filter @west4/api oncall:set -- --slot second --email <Console staff email> [--phone +1…] --by "<your name>"
pnpm --filter @west4/api oncall:set -- --show
```

The Console's Pages panel shows both slots and says when one is empty. With the first slot empty, pages go straight to the second. With both empty, pages are still recorded and shown in the Console, and the worker logs the hint every sweep. Support hours are a founder decision ([blueprint](../blueprint.md) · Open decisions); M9-16 extends on call to every opening hour.

## Test the escalation

```
pnpm --filter @west4/api oncall:set -- --test-page --by "<your name>"
```

The first responder gets "[TEST] Test page from …" within 30 seconds. Don't acknowledge it. Ten minutes later the second responder gets "[TEST] Not acknowledged in 10 minutes · …". Then acknowledge it in the Console (Pages → Acknowledge). A test page is never cleared by a sweep and never repeats.

## When you're paged

1. Acknowledge it in the Console (Pages). That stops the escalation; it doesn't fix anything.
2. Open the runbook the page names. Every alert has one in this folder.
3. Work from the Console: a support grant the venue's owner approves (read-only, masked), or the emergency path (re-sync a payment, cancel a reader action, requeue a print, close a stuck night), which needs a second approver on our side.
4. If guests are affected, post it on the status page: `pnpm --filter @west4/api status:set -- --part payments --state degraded --note "…" --by "<you>"`, and clear it after.

## Where pages come from

- **The alert sweep** (worker, every 30 seconds): readers, the capture sweep, money dead letters, webhook lag, payouts, and the card-payment and order-to-alarm burn rates over the venues open right now.
- **The pages topic** (`infra/staging/paging.tf`): CloudWatch burn-rate alarms on ordering, payments and printing, and RDS failover events, posted to `POST /v1/hooks/alarms` (signed by Amazon, `PAGES_TOPIC_ARN`).
- Device problems that don't put a money path at risk go to the venue's manager, not to us ([device-offline](device-offline.md), [venue-offline](venue-offline.md)).
