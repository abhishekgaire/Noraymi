# Restore one venue, and the monthly restore drill (M8-20)

A per-venue restore brings one venue's rows back from a scratch copy of the database without touching any other venue ([Testing and operations](../spec/13-testing-operations.md) · Backups and restore). Use it when one venue's data was lost or damaged (a bad script, a bad migration, a mistaken bulk change). The same steps, on staging, are the **monthly drill**.

**What it does, in order** (`apps/api/src/restore/`, `packages/db/src/restore.ts`):

1. **Preflight.** Refuses when the scratch copy has different migrations, is production itself, lacks the venue, or when a venue table has no restore wall or a trigger wouldn't step aside for a restore.
2. **Rows back.** Reads the venue's rows from the scratch copy and inserts the ones production is missing, as the audited migration role (`app_migrator`), walled to the one venue on both sides. Money rows, and every other row, are only inserted, never overwritten. The menu comes back as new versions of its rows (audited updates). Settings come back as one new version per key whose value differs, starting on today's business date; a key production lost comes back with its whole history. Each batch is its own short transaction, so the other venues never wait. Every row is audited under `restore:<id>`.
3. **The pull.** Stripe's events since the restore point (payments, refunds, disputes, payouts) run through their usual handlers; open payment attempts are settled by the reconciler; a PaymentIntent that succeeded with no payment of ours becomes an **Unmatched payment** for a manager to match. Twilio's messages since the restore point update text statuses and bring guests' replies into the inbox.
4. **Erasures again.** Every row of the erasure log is applied again, so a guest erased after the restore point stays erased. Anything found again at Stripe or Twilio goes back to the erase job. The nightly retention runs once more.
5. **Checks.** The venue's card payments against Stripe's PaymentIntents for the window (count and amount), and the time against the 2-hour recovery target, on the venue's `restores` row and in the evidence JSON.

Never restored: the audit log (production keeps its own hash chain), the realtime feed, the job queue and the restore log. The ID-scan key bucket is never backed up (M8-14), so a scan whose night key was destroyed stays unreadable after any restore.

## Rehearse it locally (no cloud needed)

```
pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/restore/restore.int.test.ts
```

It loads West 4 with its Stripe side on the fake and a second venue, takes the scratch copy, then takes a card payment, erases Tanya W. and receives a text, loses every West 4 row, and restores West 4 while the other venue keeps writing. It checks the other venue's rows by hash, the payments against the fake Stripe, the time on the `restores` row, that Tanya stays erased, and that the API answers West 4's board from the restored rows.

By hand on your machine, with the fake Stripe running (`pnpm --filter @west4/api stripe:fake`) and no `.env` keys in the environment: `create database west4_scratch template west4` in `docker compose exec postgres psql -U west4 -d postgres` (nothing may be connected to `west4`), then

```
pnpm --filter @west4/api restore:venue -- --venue west4karaoke \
  --scratch-url postgres://west4:west4@localhost:5432/west4_scratch \
  --restore-point <the instant you made the copy> --drill
```

## The monthly drill on staging

**Who:** one engineer with the AWS admin profile. **When:** once a month on a fixed day you choose, in daytime (staging only). Allow one hour. Keep a stopwatch: the drill is timed.

1. **Start the clock.** Write the start time. Pick the restore point: about ten minutes ago.
2. **Make the scratch copy** (point-in-time restore to a new instance, never over the live one):
   ```
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier west4-staging \
     --target-db-instance-identifier west4-staging-scratch-$(date +%Y%m%d) \
     --restore-time <restore point, UTC> \
     --db-subnet-group-name west4-staging --vpc-security-group-ids <the db security group> \
     --no-publicly-accessible --no-multi-az
   aws rds wait db-instance-available --db-instance-identifier west4-staging-scratch-$(date +%Y%m%d)
   ```
   Write how many seconds this took: it's `--scratch-ready-s`.
3. **Run the restore as a one-off task** from the API image, the way the deploy runs migrations (`.github/workflows/deploy-staging.yml`), with the command overridden:
   ```
   node dist/restore/cli.js --venue west4karaoke --scratch-url postgres://west4:<password>@<scratch endpoint>:5432/west4 \
     --restore-point <restore point> --drill --scratch-ready-s <seconds> --out -
   ```
   The scratch copy has the same master password as staging (Secrets Manager). The task prints the evidence JSON to its log.
4. **Check what the drill must prove**, all in the evidence:
   - `counts.skipped` is empty: no row refused.
   - `stripeCheck.match` is true: the payments match Stripe's PaymentIntents for the window in count and amount.
   - `target.withinTarget` is true: the whole time, scratch copy included, is within 2 hours.
   - The row-level policies and roles are in place: the preflight passed (a refusal prints `REFUSED` and each reason).
   - The app boots on the restored data: open the staff app on staging, sign in, and see the Board and Room 9's check.
   - Another venue (the training venue, or any second venue on staging) shows no change.
5. **Delete the scratch copy**: `aws rds delete-db-instance --db-instance-identifier west4-staging-scratch-<date> --skip-final-snapshot`.
6. **Record it** as `docs/drills/<date>-restore.md`: the start and end times, the scratch copy's seconds, the evidence JSON, and anything that went wrong.

If Stripe or Twilio didn't answer during the pull, the restore row stays `pulling`: run `node dist/restore/cli.js --venue west4karaoke --finish <restore id>` (or let the `restore.pull` job retry when the restore ran with `--pull job`).

## A real restore in production

The same as the drill, on production, with `--confirm <slug>` and without `--drill`. Tell the venue's manager first: the restored venue's screens catch up as rows come back, and any payment found only at Stripe shows in **Unmatched payments** to be matched to its check. Afterwards run the night's check for every night the restore covered: `pnpm --filter @west4/api reconcile -- --date <the night> --venue <id>`.
