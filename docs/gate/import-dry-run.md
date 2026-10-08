# Gate item 3 · the import dry run (M9-06)

The evidence that West 4's future bookings, deposits and consents were imported with nothing lost ([the go-live gate](../milestones.md#the-go-live-gate), item 3).

**Status:** waiting on West 4's real export files and the old system's own totals. Nothing here is signed yet.

## How the evidence is made

1. On the day of the export, West 4 takes its old system's own totals from that system's own report or screen (never from the export file): bookings, deposits held, consents, and guests if it shows them. Type them into a `totals.json` kept with the export, outside the repo:

   ```json
   { "taken_from": "<which report or screen>", "taken_at": "<when>", "bookings": 0, "deposits": "$0.00", "consents": 0 }
   ```

2. On a staging copy of production, run the dry run with them (`docs/runbooks/import.md` · The dry run):

   ```
   pnpm db:import -- --venue west4karaoke --mapping <dir>/mapping.json --dry-run --old-system <dir>/totals.json --out evidence/import
   ```

3. Fix every difference it names and run it again until it says "Matches the old system in count and to the cent."
4. West 4's owner signs the `dry-run-report-<run>.md` it writes (counts and cents only, no guest's details). Keep the signed report here as `import-dry-run-<date>-signed.md` (or a scan of it as a PDF), and change the status above.
5. Rehearse the cutover delta: run the same command (without `--dry-run`) with the newer files and the old system's newer totals; it adds only the bookings made since, and its report says so ("already" counts the rest, "changed" is 0).

## Signed reports

None yet.
