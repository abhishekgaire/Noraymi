# The payment page check failed

**Rule:** `pay-page-check` · pages us · clears when the next run passes.

**What fired.** `.github/workflows/pay-page-check.yml` (M4-15) loaded the live payment page after a staging deploy or on its weekly run and found a script or a header that doesn't match the policy in `apps/guest/pay-policy.ts`. The workflow publishes the result to the pages topic (`scripts/pay-check-alarm.mjs`), and the alarm hook opens or clears this page.

**Why it matters.** SAQ A asks us to confirm that every script on the payment page is authorised and that changes are detected (spec 12 · 1). A changed script could read card details as the guest types.

## First five minutes

1. Acknowledge the page and open the run linked in the summary: which script or header?
2. Was it our own deploy (a new Next.js chunk name, a header changed in the same commit)? Check the last commits to `apps/guest`.

## Fix

- **Our change, intended**: update `pay-policy.ts` with the script and its reason in the same pull request, get it reviewed, redeploy; the next run clears the page.
- **Not ours**: treat it as a breach. Take the payment page off (set the pay host to the maintenance page, so booking falls back to paying at the venue), then follow [the breach runbook](breach.md).

**Over when** a run passes.
