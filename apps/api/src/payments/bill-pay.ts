import { amountDue, createPayLink, withVenue, type Queryable } from "@west4/db";
import { ApiError } from "../http/errors.js";
import { guestBill } from "../rooms/guest-bill.js";
import { cancelPayment, type PaymentDeps } from "./run.js";

/** How long a bill's payment-page link stays good. */
const LINK_MINUTES = 60;

/**
 * "Pay another way" on the bill (M4-16; screens N5): a pay link for the amount due now, opened on the
 * payment page's own origin (M4-15). A payment page opened earlier from this bill and never paid is
 * cancelled first, at Stripe and here, so its hold on the amount due is released and two pages can't
 * both take the balance. If Stripe already took that earlier payment, the cancel records it as paid
 * instead and the new link is for what's left.
 */
export async function payAnotherWay(
  deps: PaymentDeps,
  venueId: string,
  checkId: string,
  payAppUrl: string | null,
): Promise<{ url: string; amount_cents: number }> {
  if (!payAppUrl) throw new ApiError("invalid_request", "the payment page has no address here yet");
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `bill:${checkId}:pay-link` }, work);
  const earlier = await inVenue(async (c) => {
    const bill = await guestBill(c, venueId, checkId);
    if (!bill) throw new ApiError("invalid_request", "the bill isn't ready yet");
    const r = await c.query<{ payment_id: string }>(
      `select l.payment_id from pay_links l join payments p on p.venue_id = l.venue_id and p.id = l.payment_id
        where l.venue_id = $1 and l.check_id = $2 and l.purpose = 'balance' and p.status = 'pending'`,
      [venueId, checkId],
    );
    return r.rows.map((x) => x.payment_id);
  });
  // Outside any transaction: cancelling talks to Stripe.
  for (const paymentId of earlier) await cancelPayment(deps, venueId, paymentId, "api");
  const now = deps.clock.now();
  return inVenue(async (c) => {
    const due = await amountDue(c, checkId);
    if (due <= 0) throw new ApiError("invalid_request", "nothing is due on this check");
    const link = await createPayLink(c, venueId, {
      checkId,
      amountCents: due,
      expiresAt: now.add({ minutes: LINK_MINUTES }).toString(),
      purpose: "balance",
    });
    return { url: `${payAppUrl}/pay/${link.token}`, amount_cents: due };
  });
}
