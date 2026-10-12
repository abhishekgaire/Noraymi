import type { FastifyInstance } from "fastify";
import {
  ENDED_PLAN_STATUSES,
  PLAN_IDS,
  abandonPlanSubscribeAttempt,
  billableRooms,
  openCheckoutAttempt,
  planAttempt,
  planSubscribeAttempt,
  setAttemptCheckoutSession,
  venueSubscription,
  type PlanId,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { queueCheckoutReconcile } from "../billing/checkout.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { StripeClient } from "../stripe/client.js";
import {
  PLAN_LOOKUP_KEYS,
  PLANS_WITH_ROOMS,
  PlanPricesMissing,
  ROOM_LOOKUP_KEY,
  allPlanPrices,
  createCheckoutSession,
  createCustomer,
  findPromotionCode,
  planPrices,
  readCheckoutSession,
  type StripeCoupon,
  type StripePrice,
} from "../stripe/billing.js";
import { ownerOnly, stripeFailure } from "./payments-admin.js";

/**
 * Set up your venue's step 2, Your plan (O-04; spec 17 · Step details 2; D114):
 *   GET  /v1/venues/{v}/plan/prices         the three plans' prices, read from Stripe by lookup key
 *   GET  /v1/venues/{v}/plan/promo?code=    the owner's promo code against our active Promotion Codes
 *   POST /v1/venues/{v}/plan/checkout       Start plan: a Checkout Session in subscription mode
 * The owner's only. Every Stripe call is on our own account with the billing
 * key, outside any transaction; no price or promo code is written here.
 */
interface VenueParams {
  venueId: string;
}

const isPlan = (p: unknown): p is PlanId =>
  typeof p === "string" && (PLAN_IDS as readonly string[]).includes(p);

const priceView = (p: StripePrice | undefined) =>
  p
    ? {
        amount_cents: p.unit_amount,
        currency: p.currency,
        interval: p.recurring?.interval ?? null,
      }
    : null;

const couponView = (c: StripeCoupon) => ({
  percent_off: c.percent_off ?? null,
  amount_off_cents: c.amount_off ?? null,
  currency: c.currency ?? null,
  duration: c.duration,
  duration_in_months: c.duration_in_months ?? null,
});

const PROMO_MAX = 64;

export function planCheckoutRoutes(
  app: FastifyInstance,
  options: { clock: Clock; stripe: () => StripeClient; staffAppUrl: string | null },
): void {
  const read = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.payments",
    assurance: "passkey",
  });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.payments",
    assurance: "passkey",
    idempotency: "optional",
  });
  const nowS = () => Math.floor(options.clock.now().epochMilliseconds / 1000);

  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/plan/prices",
    { config: read },
    async (request) => {
      const venueId = ownerOnly(request);
      const local = await request.inVenue(async (c) => ({
        sub: await venueSubscription(c, venueId),
        rooms: await billableRooms(c, venueId),
        open: await openCheckoutAttempt(c, venueId),
      }));
      let prices: Map<string, StripePrice>;
      try {
        prices = await allPlanPrices(options.stripe());
      } catch (e) {
        return stripeFailure(e);
      }
      const room = prices.get(ROOM_LOOKUP_KEY);
      const live = local.sub && !ENDED_PLAN_STATUSES.includes(local.sub.status) ? local.sub : null;
      return {
        plans: PLAN_IDS.map((id) => {
          const base = prices.get(PLAN_LOOKUP_KEYS[id]);
          const withRooms = PLANS_WITH_ROOMS.includes(id);
          return {
            id,
            available: !!base && (!withRooms || !!room),
            base: priceView(base),
            room: withRooms ? priceView(room) : null,
          };
        }),
        rooms_now: local.rooms,
        current: live ? { plan: live.plan, status: live.status } : null,
        checkout_open: !!local.open,
      };
    },
  );

  app.get<{ Params: VenueParams; Querystring: { code?: string } }>(
    "/v1/venues/:venueId/plan/promo",
    { config: read },
    async (request) => {
      ownerOnly(request);
      const code = String(request.query.code ?? "").trim();
      if (!code || code.length > PROMO_MAX) return { valid: false };
      try {
        const found = await findPromotionCode(options.stripe(), code, nowS());
        return found ? { valid: true, ...couponView(found.coupon) } : { valid: false };
      } catch (e) {
        return stripeFailure(e);
      }
    },
  );

  app.post<{ Params: VenueParams; Body: { plan?: unknown; promo_code?: unknown } }>(
    "/v1/venues/:venueId/plan/checkout",
    { config: write },
    async (request) => {
      const venueId = ownerOnly(request);
      const plan = request.body?.plan;
      if (!isPlan(plan)) throw new ApiError("invalid_request", "send { plan }");
      const rawPromo = request.body?.promo_code;
      if (rawPromo !== undefined && rawPromo !== null && typeof rawPromo !== "string")
        throw new ApiError("invalid_request", "promo_code is text");
      const promoCode = typeof rawPromo === "string" ? rawPromo.trim() : "";
      const userId = request.principal.kind === "user" ? request.principal.userId : null;
      const venue = await request.inVenue(async (c) => {
        const r = await c.query<{
          org_id: string;
          legal_name: string;
          billing_customer_id: string | null;
          owner_email: string | null;
        }>(
          `select v.org_id, o.legal_name, o.billing_customer_id,
                  (select u.email from users u where u.id = $2) as owner_email
             from venues v join organizations o on o.id = v.org_id where v.id = $1`,
          [venueId, userId],
        );
        return {
          ...r.rows[0]!,
          existing: await venueSubscription(c, venueId),
          rooms: await billableRooms(c, venueId),
        };
      });
      if (venue.existing && !ENDED_PLAN_STATUSES.includes(venue.existing.status))
        throw new ApiError("invalid_request", "this venue's plan has started", {
          status: 409,
          details: { reason: "plan_started", plan: venue.existing.plan },
        });
      const stripe = options.stripe();
      try {
        // A missing Price stops here: nothing is made in Stripe.
        let prices: Awaited<ReturnType<typeof planPrices>>;
        try {
          prices = await planPrices(stripe, plan);
        } catch (e) {
          if (e instanceof PlanPricesMissing)
            throw new ApiError("invalid_request", "this plan isn't available yet", {
              status: 409,
              details: { reason: "plan_unavailable", missing: e.lookupKeys },
            });
          throw e;
        }
        let promotionCodeId: string | null = null;
        if (promoCode) {
          const found =
            promoCode.length <= PROMO_MAX
              ? await findPromotionCode(stripe, promoCode, nowS())
              : null;
          if (!found)
            throw new ApiError("invalid_request", "That code isn't valid", {
              details: { reason: "promo_invalid" },
            });
          promotionCodeId = found.promo.id;
        }
        let customer = venue.billing_customer_id;
        if (!customer) {
          customer = (
            await createCustomer(stripe, {
              id: venue.org_id,
              legalName: venue.legal_name,
              email: venue.owner_email,
            })
          ).id;
          const made = customer;
          await request.inVenue((c) =>
            c.query(
              "update organizations set billing_customer_id = coalesce(billing_customer_id, $2) where id = $1",
              [venue.org_id, made],
            ),
          );
        }
        const base = options.staffAppUrl ?? "";
        for (let round = 0; round < 2; round++) {
          // Stored before the call, in its own transaction; its id keys the call.
          const attemptId = await request.inVenue((c) =>
            planSubscribeAttempt(c, { venueId, plan, rooms: venue.rooms, promotionCodeId }),
          );
          const attempt = await request.inVenue((c) => planAttempt(c, venueId, { id: attemptId }));
          if (attempt?.checkout_session_id) {
            // The same attempt again: its session, while Stripe still has it open.
            const before = await readCheckoutSession(stripe, attempt.checkout_session_id);
            if (before.status === "open" && before.url) return { url: before.url };
            if (before.status === "expired") {
              await request.inVenue((c) => abandonPlanSubscribeAttempt(c, attemptId));
              continue;
            }
            return { url: null, waiting: true };
          }
          const session = await createCheckoutSession(stripe, {
            attemptId,
            venueId,
            customer,
            plan,
            prices,
            rooms: venue.rooms,
            promotionCodeId,
            successUrl: `${base}/set-up/plan?checkout=done`,
            cancelUrl: `${base}/set-up/plan`,
          });
          await request.inVenue(async (c) => {
            await setAttemptCheckoutSession(c, attemptId, session.id);
            await queueCheckoutReconcile(c, venueId, attemptId, session.expires_at);
          });
          return { url: session.url };
        }
        throw new ApiError("invalid_request", "Stripe's page expired; press Start plan again", {
          status: 409,
        });
      } catch (e) {
        if (e instanceof ApiError) throw e;
        return stripeFailure(e);
      }
    },
  );
}
