import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { enqueue, ingestStripeEvent, withVenue } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { StripeClient } from "../stripe/client.js";
import {
  ENDPOINT_EVENTS,
  STRIPE_EVENT_KIND,
  validStripeSignature,
  type WebhookEndpoint,
} from "../stripe/webhooks.js";

/**
 * Stripe's webhooks in (M4-03; Stripe setup 6; spec 08 · Webhooks in):
 *   POST /v1/hooks/stripe/readers    Connect endpoint: reader actions, on the critical pool
 *   POST /v1/hooks/stripe/connect    Connect endpoint: the venues' payments, refunds, disputes, payouts, accounts
 *   POST /v1/hooks/stripe/platform   our own account: plan billing (handled in M8)
 *   POST /v1/hooks/stripe/training   training mode's sandbox (M7-04): its own secret, test-mode events
 *                                    only, applied only to practice payments; the live endpoints never
 *                                    take a practice payment's event, nor production's a test-mode one
 * Before anything else, the endpoint's own signing secret; then the livemode
 * must match this environment. The event is stored once by its id, a job is
 * queued, and Stripe gets its 200 at once. A repeat delivery stores nothing new
 * and queues nothing new (the job's dedupe key is the event id).
 */
const ENDPOINTS: readonly WebhookEndpoint[] = ["readers", "connect", "platform", "training"];

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
          const stripe = options.stripe();
          const training = endpoint === "training";
          // The training endpoint takes only the sandbox's test-mode events, whatever the environment.
          const secret =
            endpoint === "training"
              ? (stripe.sandboxSettings?.trainingWebhookSecret ?? "")
              : stripe.settings.webhookSecrets[endpoint];
          const livemode = training ? false : stripe.settings.livemode;
          const raw = typeof request.body === "string" ? request.body : "";
          const header = request.headers["stripe-signature"];
          if (
            !validStripeSignature(
              raw,
              typeof header === "string" ? header : undefined,
              secret,
              Math.floor(Date.now() / 1000),
            )
          ) {
            request.log.warn({ endpoint }, "stripe webhook refused: the signature doesn't match");
            throw new ApiError("invalid_request", "the signature doesn't match this endpoint");
          }
          let event: { id?: unknown; type?: unknown; livemode?: unknown; account?: unknown };
          try {
            event = JSON.parse(raw) as typeof event;
          } catch {
            throw new ApiError("invalid_request", "not a Stripe event");
          }
          if (typeof event.id !== "string" || typeof event.type !== "string")
            throw new ApiError("invalid_request", "not a Stripe event");
          if (event.livemode !== livemode) {
            const why = training
              ? "a live event at the training endpoint"
              : livemode
                ? "a test-mode event on a live endpoint"
                : "a live event outside production";
            // Refused and logged (M7-04): the event's id and type only, never its contents.
            request.log.warn(
              { endpoint, event_id: event.id, type: event.type },
              `stripe webhook refused: ${why}`,
            );
            throw new ApiError("invalid_request", why);
          }
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
                pool:
                  endpoint === "readers" ||
                  (training && (event.type as string).startsWith("terminal.reader."))
                    ? "critical"
                    : "normal",
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
