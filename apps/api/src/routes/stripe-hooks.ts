import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { enqueue, ingestStripeEvent, withVenue } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { StripeClient } from "../stripe/client.js";
import type { StripeEndpoint } from "../stripe/settings.js";
import { ENDPOINT_EVENTS, STRIPE_EVENT_KIND, validStripeSignature } from "../stripe/webhooks.js";

/**
 * Stripe's webhooks in (M4-03; Stripe setup 6; spec 08 · Webhooks in):
 *   POST /v1/hooks/stripe/readers    Connect endpoint: reader actions, on the critical pool
 *   POST /v1/hooks/stripe/connect    Connect endpoint: the venues' payments, refunds, disputes, payouts, accounts
 *   POST /v1/hooks/stripe/platform   our own account: plan billing (handled in M8)
 * Before anything else, the endpoint's own signing secret; then the livemode
 * must match this environment. The event is stored once by its id, a job is
 * queued, and Stripe gets its 200 at once. A repeat delivery stores nothing new
 * and queues nothing new (the job's dedupe key is the event id).
 */
const ENDPOINTS: readonly StripeEndpoint[] = ["readers", "connect", "platform"];

export function stripeHookRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; stripe: () => StripeClient },
): void {
  // The signature is over the exact bytes Stripe sent, so these routes keep the body as text.
  void app.register(async (hooks) => {
    hooks.removeContentTypeParser("application/json");
    hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );
    for (const endpoint of ENDPOINTS) {
      hooks.post<{ Body: string }>(
        `/v1/hooks/stripe/${endpoint}`,
        {
          config: route({
            principals: ["public"],
            module: "core",
            idempotency: "none",
            rateLimit: false,
          }),
        },
        async (request, reply) => {
          const settings = options.stripe().settings;
          const raw = typeof request.body === "string" ? request.body : "";
          const header = request.headers["stripe-signature"];
          if (
            !validStripeSignature(
              raw,
              typeof header === "string" ? header : undefined,
              settings.webhookSecrets[endpoint],
              Math.floor(Date.now() / 1000),
            )
          )
            throw new ApiError("invalid_request", "the signature doesn't match this endpoint");
          let event: { id?: unknown; type?: unknown; livemode?: unknown; account?: unknown };
          try {
            event = JSON.parse(raw) as typeof event;
          } catch {
            throw new ApiError("invalid_request", "not a Stripe event");
          }
          if (typeof event.id !== "string" || typeof event.type !== "string")
            throw new ApiError("invalid_request", "not a Stripe event");
          if (event.livemode !== settings.livemode)
            throw new ApiError(
              "invalid_request",
              settings.livemode
                ? "a test-mode event on a live endpoint"
                : "a live event outside production",
            );
          // Types this endpoint doesn't listen to are acknowledged and dropped.
          if (!ENDPOINT_EVENTS[endpoint].includes(event.type))
            return reply.code(200).send({ received: true });
          const account = typeof event.account === "string" ? event.account : null;
          const stored = await ingestStripeEvent(options.pool, {
            eventId: event.id,
            type: event.type,
            endpoint,
            account,
            payload: event,
          });
          if (stored.venue_id && !stored.processed) {
            const venueId = stored.venue_id;
            await withVenue(options.pool, { venueId, requestId: request.requestId }, (c) =>
              enqueue(c, {
                venueId,
                kind: STRIPE_EVENT_KIND,
                pool: endpoint === "readers" ? "critical" : "normal",
                dedupeKey: `${STRIPE_EVENT_KIND}:${event.id as string}`,
                payload: { webhook_event_id: stored.id },
                runAt: options.clock.now(),
                maxAttempts: 10,
              }),
            );
          }
          return reply.code(200).send({ received: true });
        },
      );
    }
  });
}
