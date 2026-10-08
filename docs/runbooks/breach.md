# A breach of guest or staff data

**Runs it:** the named person in [docs/security/breach-contacts.md](../security/breach-contacts.md). Until the founder names them, the founder runs it.

**What counts.** Anyone without permission reading or taking guests' or staff members' personal data that we hold for a venue: names with phone numbers or emails, ID-scan fields, sign-in secrets, or anything on the payment page if a script changed ([pay-page-check](pay-page-check.md)). Card numbers never reach us (spec 12 · 1); a card problem goes to Stripe at once as well.

**The duties (spec 12 · 13).** We hold this data on the venue's behalf, so:

1. **We tell the venue immediately**, and within **72 hours** of discovery at most (our data processing addendum; GBL §899-aa(3) says "immediately"). The venue's owner, by phone, then in writing.
2. **The venue tells affected New York residents and the state** within **30 days** of discovery, as [GBL §899-aa](https://www.nysenate.gov/legislation/laws/GBS/899-AA) allows; which state offices it notifies is the venue's lawyer's call. We give them everything they need: what, when, whose data, what we did.
3. The data processing addendum's exact wording waits for the lawyer (open question, collected in M9-13). Don't promise anything beyond the two lines above.

## First hour

1. Write the time you found it. Open an incident in the Console's incident log; every step goes there with its time.
2. Stop it: revoke the sessions, keys or grants involved ([key rotation](key-rotation.md)), take the payment page off if it's involved.
3. Keep evidence: don't delete logs or rows; the audit log is hash-chained with its daily heads in write-once storage.
4. Call the venue's owner (immediately, within 72 hours at most).

## Within 72 hours

- Work out whose data and which fields, from the audit log and access logs, venue by venue (one breach can touch several venues; each owner is told about their own).
- Send each owner the written notice: what happened, when, which data, how many people, what we did, who to contact.

## After

- Help each venue with its 30-day notices.
- A review within 2 weeks: the cause, the fix, and a decision row if anything in the spec changes.
