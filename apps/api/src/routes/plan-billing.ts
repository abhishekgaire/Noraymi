import type { FastifyInstance } from "fastify";
import { billableRooms, venueClockSettings, venueSubscription, type Queryable } from "@west4/db";
import { planState } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { StripeClient } from "../stripe/client.js";
import {
  portalSession,
  previewInvoice,
  readCustomer,
  readInvoice,
  readSubscription,
} from "../stripe/billing.js";
import { ownerOnly, stripeFailure } from "./payments-admin.js";

/**
 * Our plan (M8-15; spec 03 · Plan billing; milestones · Admin by milestone,
 * Payments: our plan):
 *   GET  /v1/venues/{v}/plan/status   every Admin reader: no plan, paid, payment failed (the banner), or read-only
 *   GET  /v1/venues/{v}/plan          the owner's: the plan, rooms counted, the next invoice and the payment method
 *   POST /v1/venues/{v}/plan/portal   the owner's: Stripe's hosted billing page (pay, change the card); open while read-only
 * Every Stripe call is on our own account with the billing key, outside any transaction.
 */
export function planBillingRoutes(
  app: FastifyInstance,
  options: { clock: Clock; stripe: () => StripeClient; staffAppUrl: string | null },
): void {
  const reader = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
  });
  const owner = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.payments",
    assurance: "passkey",
    openWhenReadOnly: true,
  });

  const stateOf = async (venueId: string, inVenue: Parameters<typeof readState>[1]) =>
    readState(venueId, inVenue, options.clock);

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/plan/status",
    { config: reader },
    async (request) => {
      const s = await stateOf(request.venueId!, request.inVenue);
      return {
        state: s.state,
        payment_failed_at: s.sub?.payment_failed_at ?? null,
        read_only_from: s.readOnlyFrom,
      };
    },
  );

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/plan",
    { config: owner },
    async (request) => {
      const venueId = ownerOnly(request);
      const s = await stateOf(venueId, request.inVenue);
      const rooms = await request.inVenue((c) => billableRooms(c, venueId));
      const mode = options.stripe().settings.mode;
      if (!s.sub)
        return { plan: null, state: s.state, rooms_now: rooms, mode, read_only_from: null };
      const stripe = options.stripe();
      // What Stripe says now; each part is shown only if Stripe answers.
      const extra = await (async () => {
        try {
          const sub = await readSubscription(stripe, s.sub!.stripe_subscription_id);
          const [preview, customer, failed] = await Promise.all([
            sub.status === "canceled"
              ? Promise.resolve(null)
              : previewInvoice(
                  stripe,
                  sub.customer,
                  sub.id,
                  `billing:preview:${venueId}:${request.requestId}`,
                ).catch(() => null),
            readCustomer(stripe, sub.customer).catch(() => null),
            s.sub!.failed_invoice_id
              ? readInvoice(stripe, s.sub!.failed_invoice_id).catch(() => null)
              : Promise.resolve(null),
          ]);
          const pm = customer?.invoice_settings?.default_payment_method;
          return {
            next_invoice: preview
              ? {
                  amount_cents: preview.amount_due,
                  currency: preview.currency,
                  date: preview.next_payment_attempt ?? preview.period_end ?? null,
                }
              : null,
            payment_method:
              pm && typeof pm === "object" && pm.card
                ? { brand: pm.card.brand, last4: pm.card.last4 }
                : null,
            pay_url:
              failed && failed.status === "open" ? (failed.hosted_invoice_url ?? null) : null,
            reachable: true,
          };
        } catch {
          return { next_invoice: null, payment_method: null, pay_url: null, reachable: false };
        }
      })();
      return {
        plan: s.sub.plan,
        status: s.sub.status,
        room_quantity: s.sub.room_quantity,
        rooms_now: rooms,
        state: s.state,
        payment_failed_at: s.sub.payment_failed_at,
        read_only_from: s.readOnlyFrom,
        mode,
        ...extra,
      };
    },
  );

  app.post<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/plan/portal",
    { config: owner },
    async (request) => {
      const venueId = ownerOnly(request);
      const customer = await request.inVenue(async (c) => {
        const r = await c.query<{ billing_customer_id: string | null }>(
          "select o.billing_customer_id from venues v join organizations o on o.id = v.org_id where v.id = $1",
          [venueId],
        );
        return r.rows[0]?.billing_customer_id ?? null;
      });
      if (!customer) throw new ApiError("invalid_request", "this venue has no plan with us yet");
      try {
        return await portalSession(
          options.stripe(),
          customer,
          `${options.staffAppUrl ?? ""}/admin/payments`,
          `billing:portal:${venueId}:${request.requestId}`,
        );
      } catch (e) {
        return stripeFailure(e);
      }
    },
  );
}

async function readState(
  venueId: string,
  inVenue: <T>(work: (c: Queryable) => Promise<T>) => Promise<T>,
  clock: Clock,
) {
  const { sub, zone } = await inVenue(async (c) => ({
    sub: await venueSubscription(c, venueId),
    zone: await venueClockSettings(c, venueId),
  }));
  const s = planState(sub, clock.now(), zone.time_zone, zone.day_cutover);
  return { sub, state: s.state, readOnlyFrom: s.readOnlyFrom?.toString() ?? null };
}
