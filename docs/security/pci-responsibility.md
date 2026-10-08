# PCI DSS: who does what (draft)

**Status: draft.** Final once the QSA answers which validation we file ourselves (open question, collected in M9-13; spec 12 · 1). Each venue gets this matrix and our signed confirmation for the payment page below.

## The responsibility matrix

| Requirement area | The venue | Us (the platform) | Stripe |
| --- | --- | --- | --- |
| Card data storage, processing, transmission | Never handles card numbers | Never receives card numbers: readers are Stripe Terminal, server-driven; online payments use the Payment Element on our `pay.` origin | Stores and processes all card data (PCI DSS Level 1 service provider) |
| Card readers (S700, S710, WisePOS E) | Keeps readers in sight, checks them for tampering, reports a lost reader | Registers readers per venue, checks reader ids against the venue on every request | Validated P2PE solution (instruction manual v2.3), device keys |
| The payment page | Doesn't add scripts or embed it in its own site | Own origin, no website-builder content, no service worker, nonce-based CSP, SRI, a reasoned script list, `frame-ancestors 'none'`, COOP same-origin; the changed-script and header check on every deploy and weekly, paging us on failure | The Payment Element iframe |
| Access to the Stripe account | Owner keeps their own Stripe login safe | Restricted keys per service, in the secrets manager, rotated with at most 7 days of overlap ([key rotation](../runbooks/key-rotation.md)) | Account security |
| Validation | Files SAQ P2PE (readers) or as the QSA advises; SAQ A for online | Confirms the payment page (below); files our own validation as the QSA advises | Attestation of compliance on request |
| Incidents | Tells us at once about a tampered reader or suspicious payment | [Breach runbook](../runbooks/breach.md): tells the venue immediately, within 72 hours at most | Its own incident process |

## Our confirmation for the payment page (draft, to be signed)

> We confirm, for the payment page served from our `pay.` origin to [venue], that: the page loads only the scripts listed in `apps/guest/pay-policy.ts`, each with a reason; each is authorised and its integrity is checked; a Content Security Policy with per-request nonces is sent, with `frame-ancestors 'none'` and `Cross-Origin-Opener-Policy: same-origin`; the scripts and headers are compared with that list after every deploy and weekly, and a difference pages us; and card data is entered only into Stripe's Payment Element.
>
> Signed: ______________________ (for us) Date: __________

Signing waits for the assessor's answer.

## Per venue

| Venue | Matrix sent | Confirmation signed | Radar rules | Validation filed |
| --- | --- | --- | --- | --- |
| West 4 Boho Karaoke | not yet | not yet | not yet | not yet |
