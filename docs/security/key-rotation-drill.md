# Key rotation drill report

The drill in [the key rotation runbook](../runbooks/key-rotation.md). One row per drill.

| Date | Environment | Keys rotated | Overlap (new in → old dead) | Synthetic runs passed | Payments failed on our side | Webhooks refused | By |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _not yet run_ | staging | | | | | | |

**Rehearsed in code:** `apps/api/src/stripe/webhook-rotation.test.ts` takes events signed with the old secret, the new one and both during the overlap, and refuses the old one once it's removed.

**Still to run:** on staging, with the synthetic check live (M8-18's setup) and Stripe sandbox dashboard access.
