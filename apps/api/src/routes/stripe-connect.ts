import type { FastifyInstance } from "fastify";
import { saveStripeIntegration, stripeAccountOf, stripeIntegration } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { StripeClient } from "../stripe/client.js";
import { accountStatus, createVenueAccount, onboardingLink } from "../stripe/accounts.js";
import { syncAccount } from "../stripe/account-sync.js";
import { whenCardPaymentsOn } from "../stripe/connect.js";
import { ownerOnly, stripeFailure } from "./payments-admin.js";

/**
 * Set up your venue's step 3, Card payments (O-05; spec 17 · Step details 3;
 * Stripe setup 2):
 *   GET  /v1/venues/{v}/payments/stripe/connect   the step's state, read from the rows account.updated keeps
 *   POST /v1/venues/{v}/payments/stripe/connect   Connect with Stripe (or Continue with Stripe)
 * The POST makes the organization's Accounts v2 account when it has none
 * (with the legal name and the owner's email; one idempotency key per
 * organization, so pressing twice makes one account), then an Account Link to
 * Stripe's hosted onboarding, whose return URL comes back to the step. A
 * second venue of the organization reuses its account. Nothing is pasted or
 * stored from the owner but the account's id; every Stripe call is outside a
 * transaction. The owner's only.
 */
interface VenueParams {
  venueId: string;
}

export type ConnectState = "not_connected" | "waiting" | "needs_more" | "connected";

export function stripeConnectRoutes(
  app: FastifyInstance,
  options: {
    clock: Clock;
    stripe: () => StripeClient;
    staffAppUrl: string | null;
    payAppUrl: string | null;
  },
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

  /** The step's state from the saved rows: the account's id and what account.updated last said. */
  const stateOf = async (request: Parameters<typeof ownerOnly>[0], venueId: string) =>
    request.inVenue(async (c) => {
      const org = (
        await c.query<{ legal_name: string }>(
          "select o.legal_name from venues v join organizations o on o.id = v.org_id where v.id = $1",
          [venueId],
        )
      ).rows[0];
      const accountId = await stripeAccountOf(c, venueId);
      const row = accountId ? await stripeIntegration(c, venueId) : null;
      const state: ConnectState = !accountId
        ? "not_connected"
        : row?.card_payments === "active"
          ? "connected"
          : row && row.needs.length > 0
            ? "needs_more"
            : "waiting";
      return {
        state,
        connected: !!accountId,
        card_payments_enabled: row?.card_payments === "active",
        needs: row?.needs ?? [],
        organization_name: org?.legal_name ?? null,
      };
    });

  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/payments/stripe/connect",
    { config: read },
    async (request) => stateOf(request, ownerOnly(request)),
  );

  app.post<{ Params: VenueParams }>(
    "/v1/venues/:venueId/payments/stripe/connect",
    { config: write },
    async (request) => {
      const venueId = ownerOnly(request);
      const userId = request.principal.kind === "user" ? request.principal.userId : null;
      const stripe = options.stripe();
      const at = () => options.clock.now().toString();
      const org = await request.inVenue(async (c) => {
        const r = await c.query<{
          org_id: string;
          legal_name: string;
          venue_name: string;
          email: string | null;
        }>(
          `select v.org_id, o.legal_name, v.name as venue_name,
                  (select u.email from users u where u.id = $2) as email
             from venues v join organizations o on o.id = v.org_id where v.id = $1`,
          [venueId, userId],
        );
        return { ...r.rows[0]!, accountId: await stripeAccountOf(c, venueId) };
      });
      try {
        let accountId = org.accountId;
        if (!accountId) {
          if (!org.email)
            throw new ApiError("invalid_request", "your sign-in has no email for Stripe");
          // One key per organization: a second press, or a second venue at once, answers the same account.
          const account = await createVenueAccount(
            stripe,
            {
              displayName: org.venue_name,
              contactEmail: org.email,
              registeredName: org.legal_name,
            },
            `org:${org.org_id}:create-account`,
          );
          const status = accountStatus(account);
          accountId = await request.inVenue(async (c) => {
            const r = await c.query<{ stripe_account_id: string }>(
              `update organizations set stripe_account_id = coalesce(stripe_account_id, $2)
                where id = $1 returning stripe_account_id`,
              [org.org_id, account.id],
            );
            const kept = r.rows[0]!.stripe_account_id;
            if (kept === account.id)
              await saveStripeIntegration(c, venueId, {
                accountId: kept,
                cardPayments: status.cardPayments,
                needs: status.needs,
                at: at(),
              });
            return kept;
          });
        } else {
          // The organization's account (a second venue reuses it): what Stripe says now.
          const status = await syncAccount(request.inVenue, stripe, venueId, at());
          if (status?.cardPaymentsEnabled) {
            await whenCardPaymentsOn(
              request.inVenue,
              stripe,
              venueId,
              options.clock.now(),
              options.payAppUrl,
            );
            return { url: null, ...(await stateOf(request, venueId)) };
          }
        }
        const back = `${options.staffAppUrl ?? ""}/set-up/card`;
        const url = await onboardingLink(
          stripe,
          accountId,
          { refreshUrl: `${back}?stripe=refresh`, returnUrl: `${back}?stripe=back` },
          `venue:${venueId}:onboarding:${request.requestId}`,
        );
        return { url, ...(await stateOf(request, venueId)) };
      } catch (e) {
        if (e instanceof ApiError) throw e;
        return stripeFailure(e);
      }
    },
  );
}
