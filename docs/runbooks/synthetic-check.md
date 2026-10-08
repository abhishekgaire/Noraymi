# The synthetic order or reader payment failed

**Rule:** `synthetic-check` · pages us · clears when the next run passes.

**What fired.** Every 5 minutes during the live venues' opening hours, the worker plays one room order and one reader payment on our own test venue (M8-18; spec 13 · Watching production): a synthetic bar device signs a bartender in, seats a practice walk-in, a guest phone joins with the room code and orders, the device waits for the bar's alarm, the bartender accepts, and a tap on a simulated reader is paid with Stripe's test card on the sandbox. One of those steps failed. The page's summary names the step and its part:

| Step | Part | What it means |
| --- | --- | --- |
| `sign_in`, `seat` | setup | the synthetic device, its bartender or the test room isn't right (often our own config, not the venues') |
| `join`, `order`, `ring`, `accept` | ordering | guests can't order from a room, or the bar wouldn't hear it; the status page's ordering part shows degraded |
| `tap`, `test_card`, `paid` | payments | the reader path is broken: the payment run, the Terminal call, or Stripe's sandbox |

It all happens at the test venue, in training mode, so no guest, no live money and no live webhook endpoint was involved.

## First five minutes

1. Acknowledge the page.
2. Read the worker's log line `synthetic: failed at <step>: <reason>`.
3. Ordering: open a real venue's bar orders screen. Are room orders arriving? Check the `target-burn` page and the order-to-alarm graph.
4. Payments: Stripe's status page (Terminal, API). Is the `payment-failures` page open too? Then real venues are failing, not only the test.

## Fix

- **Setup** (`sign_in`, `seat`): the test venue's PIN, device or room changed. Run `pnpm --filter @west4/api synthetic:setup` again and update the `SYNTHETIC_CHECK` secret.
- **Ordering**: look at the API's errors for `/v1/public/room-session/orders` and the event relay; restart the API task if the relay is stuck.
- **Ring** (`the bar device never saw the order ring`): the live event channel and the poll both failed: the events relay or the database.
- **Payments**: if Stripe's sandbox is down while live is fine, note it on the status page as a drill-free incident and wait; if our payment run is failing, follow [payment-failures](payment-failures.md).

**Over when** the next run passes (at most 5 minutes after the fix, during opening hours).
