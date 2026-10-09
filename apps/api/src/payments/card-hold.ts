import {
  emitEvent,
  enqueue,
  payLinkBySetupIntent,
  stripeAccountOf,
  type PayLinkRow,
  type Queryable,
} from "@west4/db";
import { stripeEventHandlers } from "../stripe/webhooks.js";
import type { Temporal } from "@west4/shared";
import { BOOKING_CONFIRMED_KIND } from "../bookings/confirm.js";
import type { StripeClient } from "../stripe/client.js";

/**
 * cardHold mode (M5-13; Settings · DepositRule mode cardHold; Payment flows
 * step 7): a venue that takes no deposit saves the guest's card on the payment
 * page with a SetupIntent (`usage=off_session`, a Customer on the venue's
 * account) under the same consent record a deposit has, and charges nothing.
 * The SetupIntent is made once per link (its id is kept on the link) and
 * reused on every retry; its result is read from Stripe by the server, on the
 * page's return or on `setup_intent.succeeded`, whichever comes first.
 */
export interface StripeSetup {
  readonly id: string;
  readonly status: string;
  readonly client_secret?: string | null;
  readonly customer?: string | null;
  readonly payment_method?: string | { id: string } | null;
  readonly last_setup_error?: { code?: string; decline_code?: string; message?: string } | null;
}

export async function createCardHoldSetup(
  stripe: StripeClient,
  account: string,
  link: { id: string; booking_id: string },
): Promise<StripeSetup> {
  const customer = await stripe.call<{ id: string }>("payments", "POST", "/v1/customers", {
    account,
    idempotencyKey: `${link.id}:card_hold:customer`,
    params: { metadata: { booking_id: link.booking_id, purpose: "card_hold" } },
  });
  return stripe.call<StripeSetup>("payments", "POST", "/v1/setup_intents", {
    account,
    idempotencyKey: `${link.id}:card_hold:create`,
    params: {
      customer: customer.id,
      payment_method_types: ["card"],
      usage: "off_session",
      metadata: { booking_id: link.booking_id, pay_link_id: link.id, purpose: "card_hold" },
    },
  });
}

export const retrieveSetup = (stripe: StripeClient, account: string, id: string) =>
  stripe.call<StripeSetup>("payments", "GET", `/v1/setup_intents/${encodeURIComponent(id)}`, {
    account,
  });

/**
 * The card saved (in the venue's transaction): the booking keeps the PaymentMethod and confirms, its
 * hold becoming its block, and the Booking confirmed text goes. A hold that lapsed first takes the room
 * again if it's still free; gone, the booking stays cancelled (nothing was charged, so nothing to refund).
 */
export async function cardSaved(
  c: Queryable,
  venueId: string,
  link: PayLinkRow,
  setup: StripeSetup,
  now: Temporal.Instant,
): Promise<"confirmed" | "room_gone" | null> {
  if (setup.status !== "succeeded" || !link.booking_id) return null;
  const pm =
    typeof setup.payment_method === "string" ? setup.payment_method : setup.payment_method?.id;
  const b = (
    await c.query<{
      id: string;
      status: string;
      room_id: string;
      starts_at: string;
      ends_at: string;
      cancelled_via: string | null;
    }>(
      `select id, status, room_id, to_json(starts_at) #>> '{}' as starts_at, to_json(ends_at) #>> '{}' as ends_at,
              cancelled_via
         from bookings where venue_id = $1 and id = $2 for update`,
      [venueId, link.booking_id],
    )
  ).rows[0];
  if (!b) return null;
  if (b.status === "confirmed") return "confirmed";
  if (!(b.status === "pending" || (b.status === "cancelled" && !b.cancelled_via))) return null;
  const hold = await c.query(
    `update room_blocks set kind = 'booking', expires_at = null
      where venue_id = $1 and ref_id = $2 and kind = 'hold'`,
    [venueId, b.id],
  );
  if (hold.rowCount === 0) {
    await c.query("savepoint card_hold_room");
    try {
      await c.query(
        `insert into room_blocks (venue_id, room_id, period, kind, ref_id)
         values ($1, $2, tstzrange($3, $4, '[)'), 'booking', $5)`,
        [venueId, b.room_id, b.starts_at, b.ends_at, b.id],
      );
      await c.query("release savepoint card_hold_room");
    } catch (e) {
      await c.query("rollback to savepoint card_hold_room");
      if ((e as { code?: string }).code !== "23P01") throw e;
      await c.query("update bookings set status = 'cancelled' where venue_id = $1 and id = $2", [
        venueId,
        b.id,
      ]);
      return "room_gone";
    }
  }
  await c.query(
    `update bookings set status = 'confirmed', pending_until = null, payment_method_id = $3
      where venue_id = $1 and id = $2`,
    [venueId, b.id, pm ?? null],
  );
  await c.query("update pay_links set used_at = $3 where venue_id = $1 and id = $2", [
    venueId,
    link.id,
    now.toString(),
  ]);
  await enqueue(c, {
    venueId,
    kind: BOOKING_CONFIRMED_KIND,
    pool: "normal",
    dedupeKey: `${BOOKING_CONFIRMED_KIND}:${b.id}`,
    payload: { booking_id: b.id },
    runAt: now,
  });
  await emitEvent(c, { venueId, type: "booking.updated", entityId: b.id });
  return "confirmed";
}

// `setup_intent.succeeded` (M5-13): the link found by the SetupIntent's id, the SetupIntent read again
// from Stripe, and the card saved, whichever of this and the page's return comes first.
stripeEventHandlers.set("setup_intent.succeeded", async (ctx) => {
  if (ctx.training) return;
  const id = (ctx.event.payload["data"] as { object?: { id?: string } } | undefined)?.object?.id;
  if (!id) return;
  const found = await ctx.inVenue(async (c) => ({
    link: await payLinkBySetupIntent(c, ctx.venueId, id),
    account: await stripeAccountOf(c, ctx.venueId),
  }));
  if (!found.link || !found.account) return;
  const setup = await retrieveSetup(ctx.stripe, found.account, id);
  await ctx.inVenue((c) => cardSaved(c, ctx.venueId, found.link!, setup, ctx.now));
});
// `setup_intent.setup_failed`: nothing to record; the page reads the SetupIntent and says the card failed.
stripeEventHandlers.set("setup_intent.setup_failed", async () => undefined);
