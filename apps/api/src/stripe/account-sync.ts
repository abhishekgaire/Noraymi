import { saveStripeIntegration, stripeAccountOf, type Queryable } from "@west4/db";
import type { StripeClient } from "./client.js";
import { accountStatus, retrieveAccount, type AccountStatus } from "./accounts.js";

type InVenue = <T>(work: (c: Queryable) => Promise<T>) => Promise<T>;

/**
 * Reads the venue's account from Stripe (outside any transaction) and saves
 * what it says into the `integrations` row: on `account.updated` (M4-03) and
 * when the owner opens Admin → Payments.
 */
export async function syncAccount(
  inVenue: InVenue,
  stripe: StripeClient,
  venueId: string,
  at: string,
): Promise<AccountStatus | null> {
  const accountId = await inVenue((c) => stripeAccountOf(c, venueId));
  if (!accountId) return null;
  const status = accountStatus(await retrieveAccount(stripe, accountId));
  await inVenue((c) =>
    saveStripeIntegration(c, venueId, {
      accountId,
      cardPayments: status.cardPayments,
      needs: status.needs,
      at,
    }),
  );
  return status;
}
