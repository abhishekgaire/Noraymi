import type { Queryable } from "@west4/db";

/**
 * Training mode's side of Stripe (M7-04; Security and data retention 15).
 * A practice payment runs only on the sandbox: its client comes from
 * `StripeClient.forTraining`, its account from `stripeAccountFor`, and its
 * reader must be a simulated one (`readerOfVenue` with the training flag).
 */
export async function paymentIsTraining(
  c: Queryable,
  venueId: string,
  paymentId: string,
): Promise<boolean> {
  const r = await c.query<{ training: boolean }>(
    "select training from payments where venue_id = $1 and id = $2",
    [venueId, paymentId],
  );
  return r.rows[0]?.training ?? false;
}
