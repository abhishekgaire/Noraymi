import type { FastifyInstance } from "fastify";
import { integrationStatuses, stripeAccountOf, stripeIntegration } from "@west4/db";
import type { Clock } from "@west4/shared";
import type { FastifyRequest } from "fastify";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import {
  StripeError,
  StripeMisuse,
  StripeUnknownResult,
  type StripeClient,
} from "../stripe/client.js";
import { listPayouts, onboardingLink } from "../stripe/accounts.js";
import { syncAccount } from "../stripe/account-sync.js";

/**
 * Admin → Payments and Connections (M4-01; screens AdminDesk notes 21 and 28, N37):
 *   GET  /v1/venues/{v}/payments              the Stripe account: card payments, what Stripe still needs, the Dashboard link
 *   POST /v1/venues/{v}/payments/onboarding   Stripe's hosted onboarding link ("Connect with Stripe")
 *   GET  /v1/venues/{v}/payments/payouts      payouts as Stripe lists them, read-only (the reporting key)
 *   GET  /v1/venues/{v}/connections           Stripe, Twilio and email, each with its status
 * Payments is the owner's alone, in a passkey session; Connections is Admin's.
 */
const KINDS = ["stripe", "twilio", "email"] as const;

/** The permission gate guards writes; Payments' reads are the owner's too (spec 02, as Team). */
function ownerOnly(request: FastifyRequest): string {
  const venueId = request.venueId!;
  const p = request.principal;
  const here = p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId) : undefined;
  if (here?.role !== "owner") throw new ApiError("forbidden", "Payments is the owner's section");
  return venueId;
}

export function stripeFailure(e: unknown): never {
  if (e instanceof StripeError) throw new ApiError("stripe_error", e.message);
  if (e instanceof StripeUnknownResult)
    throw new ApiError("stripe_error", "no answer from Stripe; try again");
  if (e instanceof StripeMisuse) throw new ApiError("stripe_error", e.message);
  throw e;
}

export function paymentsAdminRoutes(
  app: FastifyInstance,
  options: { clock: Clock; stripe: () => StripeClient; staffAppUrl: string | null },
): void {
  const owner = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.payments",
    assurance: "passkey",
  });
  const dashboardUrl = (accountId: string) =>
    options.stripe().settings.mode === "stripe"
      ? `https://dashboard.stripe.com/${accountId}`
      : `${options.stripe().settings.apiBase}/fake/dashboard/${accountId}`;

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/payments",
    { config: owner },
    async (request) => {
      const venueId = ownerOnly(request);
      const accountId = await request.inVenue((c) => stripeAccountOf(c, venueId));
      if (accountId) {
        // What Stripe says now; account.updated keeps the row current between visits.
        await syncAccount(
          request.inVenue,
          options.stripe(),
          venueId,
          options.clock.now().toString(),
        ).catch(() => null);
      }
      const row = await request.inVenue((c) => stripeIntegration(c, venueId));
      return {
        account_id: accountId,
        card_payments: row?.card_payments ?? null,
        card_payments_enabled: row?.card_payments === "active",
        needs: row?.needs ?? [],
        checked_at: row?.checked_at ?? null,
        dashboard_url: accountId ? dashboardUrl(accountId) : null,
        mode: options.stripe().settings.mode,
      };
    },
  );

  app.post<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/payments/onboarding",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "admin.payments",
        assurance: "passkey",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const venueId = ownerOnly(request);
      const accountId = await request.inVenue((c) => stripeAccountOf(c, venueId));
      if (!accountId)
        throw new ApiError(
          "invalid_request",
          "this venue has no Stripe account yet; we make it for you",
        );
      const back = `${options.staffAppUrl ?? ""}/admin/payments`;
      try {
        const url = await onboardingLink(
          options.stripe(),
          accountId,
          { refreshUrl: back, returnUrl: `${back}?onboarded=1` },
          `venue:${venueId}:onboarding:${request.requestId}`,
        );
        return { url };
      } catch (e) {
        return stripeFailure(e);
      }
    },
  );

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/payments/payouts",
    { config: owner },
    async (request) => {
      const venueId = ownerOnly(request);
      const accountId = await request.inVenue((c) => stripeAccountOf(c, venueId));
      if (!accountId) return { payouts: [] };
      try {
        const payouts = await listPayouts(options.stripe(), accountId);
        return {
          payouts: payouts.map((p) => ({
            id: p.id,
            amount_cents: p.amount,
            arrival_date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
            status: p.status,
          })),
        };
      } catch (e) {
        return stripeFailure(e);
      }
    },
  );

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/connections",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "admin.access",
        assurance: "passkey",
      }),
    },
    async (request) => {
      const rows = await request.inVenue((c) => integrationStatuses(c, request.venueId!));
      return {
        connections: KINDS.map((kind) => {
          const row = rows.find((r) => r.kind === kind);
          return {
            kind,
            status: row?.status ?? "not_connected",
            connected_at: row?.connected_at ?? null,
          };
        }),
      };
    },
  );
}
