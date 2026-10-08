# The hold watch couldn't capture a tab

**Rule:** `capture-sweep-failed` · pages us · clears when no swept tab is left in `capture_failed`.

**What fired.** The hold watch (M6-17) swept a tab whose paper slip was never tipped and captured it at its total with a $0 tip before its hold ran out, and Stripe refused the capture. The tab is in `capture_failed`.

**Why it matters.** When the hold expires the money is gone: the venue served drinks it can't collect.

## First five minutes

1. Acknowledge the page.
2. With a support grant, open the venue's tabs in `capture_failed` and read the payment's last attempt: decline code, or our side?
3. Check the hold's `capture_before`: how long is left?

## Fix

- **Our side** (timeout, unknown): emergency **Re-sync a payment**; the reconciler settles it. Don't retry by hand.
- **Hold expired or card refused**: tell the venue's manager; the tab follows the walkout path (charge the card on file if the guest agreed, or collect it in person). Nothing is captured twice: every capture carries its idempotency key.

**Over when** no swept tab is left in `capture_failed`.
