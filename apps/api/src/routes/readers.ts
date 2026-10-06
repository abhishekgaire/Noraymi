import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  emitEvent,
  readerOfVenue,
  saveReader,
  stationOf,
  stripeAccountFor,
  venueReaders,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { StripeError, type StripeClient } from "../stripe/client.js";
import {
  CELLULAR_FEE_CENTS,
  deleteReader,
  hasCellular,
  registerReader,
  readerModel,
  retrieveReader,
} from "../stripe/terminal.js";
import { NoStripeAccount, ensureTerminal } from "../stripe/terminal-setup.js";
import { stripeFailure } from "./payments-admin.js";

/**
 * Card readers (M4-02; Stripe setup 4; screens AdminDesk note 9):
 *   GET  /v1/venues/{v}/readers                     each reader: label, model, online, cellular, the monthly fee
 *   POST /v1/venues/{v}/readers                     { registration_code, label }: register one to the venue's Location
 *   POST /v1/venues/{v}/readers/{readerId}/refresh  read one reader's status from Stripe
 *   POST /v1/venues/{v}/readers/{readerId}/test-card  training only (M7-04): present Stripe's test card,
 *                                                    or a declined one, to a simulated reader
 * Training mode (M7-04): a screen in training sees only the sandbox's simulated
 * readers and one not in training only the live ones; `practice: true`
 * registers a simulated reader on the sandbox account's own Location.
 * A readerId must be a reader of the request's venue, or the answer is not
 * found and nothing reaches Stripe. Registering makes the venue's Terminal
 * Configuration and Location first if they don't exist.
 */
const body = z
  .object({
    registration_code: z.string().trim().min(3).max(100),
    label: z.string().trim().min(1).max(60),
    practice: z.boolean().optional(),
  })
  .strict();
const uuid = z.string().uuid();

export function readerRoutes(
  app: FastifyInstance,
  options: { clock: Clock; stripe: () => StripeClient },
): void {
  const today = async (request: FastifyRequest) => {
    const v = await request.inVenue(async (c) => {
      const r = await c.query<{ time_zone: string; day_cutover: string }>(
        "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
        [request.venueId],
      );
      return r.rows[0]!;
    });
    return businessDate(options.clock.now(), v.time_zone, v.day_cutover).businessDate;
  };
  const view = (r: Awaited<ReturnType<typeof venueReaders>>[number]) => ({
    id: r.id,
    label: r.name,
    model: r.reader_model,
    registered: r.stripe_reader_id !== null,
    online: r.online,
    cellular: r.cellular ?? false,
    monthly_fee_cents: r.cellular ? CELLULAR_FEE_CENTS : 0,
    station: stationOf(r.station, r.name),
    practice: r.sandbox,
  });
  /** Stripe's test cards a simulated reader takes: a Visa that goes through, and the generic decline. */
  const TEST_CARD = "4242424242424242";
  const DECLINED_CARD = "4000000000000002";
  const testCard = z.object({ declined: z.boolean().optional() }).strict();

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/readers",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => ({
      readers: (await request.inVenue((c) => venueReaders(c, request.venueId!)))
        .filter((r) => r.sandbox === request.training)
        .map(view),
    }),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/readers",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "admin.access",
        assurance: "passkey",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { registration_code, label }");
      const venueId = request.venueId!;
      const practice = parsed.data.practice ?? false;
      const stripe = options.stripe().forTraining(practice);
      let setup;
      try {
        setup = await ensureTerminal(
          request.inVenue,
          options.stripe(),
          venueId,
          await today(request),
          practice,
        );
      } catch (e) {
        if (e instanceof NoStripeAccount)
          throw new ApiError(
            "invalid_request",
            practice
              ? "this venue has no Stripe sandbox account yet"
              : "this venue has no Stripe account yet",
          );
        return stripeFailure(e);
      }
      // One attempt, one key: the screen's own Idempotency-Key when it sends one (a retry of the same
      // tap), otherwise this request. A key Stripe has seen answers its first result for 24 hours, so a
      // fresh attempt after a refusal must never reuse one.
      const header = request.headers["idempotency-key"];
      const attempt = typeof header === "string" && header ? header : request.requestId;
      let reader;
      try {
        reader = await registerReader(
          stripe,
          setup.account,
          {
            registrationCode: parsed.data.registration_code,
            label: parsed.data.label,
            location: setup.locationId,
          },
          `venue:${venueId}:reader:${attempt}`,
        );
      } catch (e) {
        if (e instanceof StripeError && e.status === 400)
          throw new ApiError(
            "invalid_request",
            "Stripe didn't accept that code: check the code the reader shows",
          );
        return stripeFailure(e);
      }
      const model = readerModel(reader.device_type, stripe.livemode);
      // Training mode practices on simulated readers only (M7-04).
      if (practice && !reader.device_type.startsWith("simulated_")) {
        await deleteReader(stripe, setup.account, reader.id).catch(() => undefined);
        throw new ApiError("invalid_request", "training mode uses simulated readers only", {
          details: { reason: "not_simulated", device_type: reader.device_type },
        });
      }
      if (!model) {
        await deleteReader(stripe, setup.account, reader.id).catch(() => undefined);
        throw new ApiError("invalid_request", "only the S710, S700 and WisePOS E work here", {
          details: { reason: "unsupported_reader", device_type: reader.device_type },
        });
      }
      const id = await request.inVenue(async (c) => {
        const deviceId = await saveReader(c, venueId, {
          name: parsed.data.label,
          stripeReaderId: reader.id,
          model,
          cellular: hasCellular(model),
          sandbox: practice,
        });
        await emitEvent(c, { venueId, type: "device.updated", entityId: deviceId });
        return deviceId;
      });
      reply.code(201);
      const rows = await request.inVenue((c) => venueReaders(c, venueId));
      return view(rows.find((r) => r.id === id)!);
    },
  );

  app.post<{ Params: { venueId: string; readerId: string } }>(
    "/v1/venues/:venueId/readers/:readerId/refresh",
    {
      config: route({
        principals: ["owner_manager", "staff", "shared_device"],
        module: "core",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const venueId = request.venueId!;
      if (!uuid.safeParse(request.params.readerId).success)
        throw new ApiError("not_found", "no such reader");
      const found = await request.inVenue(async (c) => ({
        reader: await readerOfVenue(c, venueId, request.params.readerId, request.training),
        account: await stripeAccountFor(c, venueId, request.training),
      }));
      // Another venue's reader, one never registered, or one on the other side of training: nothing goes to Stripe.
      if (!found.reader || !found.account) throw new ApiError("not_found", "no such reader");
      try {
        const r = await retrieveReader(
          options.stripe().forTraining(request.training),
          found.account,
          found.reader.stripe_reader_id,
        );
        return { id: found.reader.id, label: found.reader.name, online: r.status === "online" };
      } catch (e) {
        return stripeFailure(e);
      }
    },
  );

  // Training mode's [Tap a test card] (M7-04; a spec gap, the cautious default): the trainee's tap on
  // a simulated reader is Stripe's own test helper, so every card state is the sandbox's real answer.
  app.post<{ Params: { venueId: string; readerId: string }; Body: unknown }>(
    "/v1/venues/:venueId/readers/:readerId/test-card",
    {
      config: route({
        principals: ["owner_manager", "staff", "shared_device"],
        module: "core",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const venueId = request.venueId!;
      if (!uuid.safeParse(request.params.readerId).success)
        throw new ApiError("not_found", "no such reader");
      const found = await request.inVenue(async (c) => ({
        reader: await readerOfVenue(c, venueId, request.params.readerId, true),
        account: await stripeAccountFor(c, venueId, true),
      }));
      // Only a simulated reader of this venue: a live reader is never sent a test card.
      if (!found.reader || !found.account) throw new ApiError("not_found", "no such reader");
      if (!request.training)
        throw new ApiError("forbidden", "test cards are for training mode only", {
          details: { reason: "training" },
        });
      const parsed = testCard.safeParse(request.body ?? {});
      if (!parsed.success) throw new ApiError("invalid_request", "send { declined? }");
      const header = request.headers["idempotency-key"];
      const attempt = typeof header === "string" && header ? header : request.requestId;
      try {
        await options
          .stripe()
          .forTraining(true)
          .call(
            "payments",
            "POST",
            `/v1/test_helpers/terminal/readers/${encodeURIComponent(found.reader.stripe_reader_id)}/present_payment_method`,
            {
              account: found.account,
              idempotencyKey: `venue:${venueId}:test-card:${attempt}`,
              params: {
                type: "card_present",
                card_present: { number: parsed.data.declined ? DECLINED_CARD : TEST_CARD },
              },
            },
          );
      } catch (e) {
        return stripeFailure(e);
      }
      return { presented: true, declined: parsed.data.declined ?? false };
    },
  );
}
