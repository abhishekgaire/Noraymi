import type { FastifyInstance, FastifyRequest } from "fastify";
import { emitEvent, readerOfVenue, saveReader, venueReaders } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { StripeError, type StripeClient } from "../stripe/client.js";
import {
  CELLULAR_FEE_CENTS,
  SUPPORTED_READERS,
  deleteReader,
  hasCellular,
  registerReader,
  retrieveReader,
  type ReaderModel,
} from "../stripe/terminal.js";
import { NoStripeAccount, ensureTerminal } from "../stripe/terminal-setup.js";
import { stripeFailure } from "./payments-admin.js";

/**
 * Card readers (M4-02; Stripe setup 4; screens AdminDesk note 9):
 *   GET  /v1/venues/{v}/readers                     each reader: label, model, online, cellular, the monthly fee
 *   POST /v1/venues/{v}/readers                     { registration_code, label }: register one to the venue's Location
 *   POST /v1/venues/{v}/readers/{readerId}/refresh  read one reader's status from Stripe
 * A readerId must be a reader of the request's venue, or the answer is not
 * found and nothing reaches Stripe. Registering makes the venue's Terminal
 * Configuration and Location first if they don't exist.
 */
const body = z
  .object({
    registration_code: z.string().trim().min(3).max(100),
    label: z.string().trim().min(1).max(60),
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
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/readers",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => ({
      readers: (await request.inVenue((c) => venueReaders(c, request.venueId!))).map(view),
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
      const stripe = options.stripe();
      let setup;
      try {
        setup = await ensureTerminal(request.inVenue, stripe, venueId, await today(request));
      } catch (e) {
        if (e instanceof NoStripeAccount)
          throw new ApiError("invalid_request", "this venue has no Stripe account yet");
        return stripeFailure(e);
      }
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
          `venue:${venueId}:reader:${parsed.data.registration_code}:${parsed.data.label}`,
        );
      } catch (e) {
        if (e instanceof StripeError && e.status === 400)
          throw new ApiError(
            "invalid_request",
            "Stripe didn't accept that code: check the code the reader shows",
          );
        return stripeFailure(e);
      }
      if (!SUPPORTED_READERS.includes(reader.device_type as ReaderModel)) {
        await deleteReader(stripe, setup.account, reader.id).catch(() => undefined);
        throw new ApiError("invalid_request", "only the S710, S700 and WisePOS E work here", {
          details: { reason: "unsupported_reader", device_type: reader.device_type },
        });
      }
      const model = reader.device_type as ReaderModel;
      const id = await request.inVenue(async (c) => {
        const deviceId = await saveReader(c, venueId, {
          name: parsed.data.label,
          stripeReaderId: reader.id,
          model,
          cellular: hasCellular(model),
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
        reader: await readerOfVenue(c, venueId, request.params.readerId),
        account: (
          await c.query<{ a: string | null }>(
            "select o.stripe_account_id as a from venues v join organizations o on o.id = v.org_id where v.id = $1",
            [venueId],
          )
        ).rows[0]?.a,
      }));
      // Another venue's reader, or one never registered: nothing goes to Stripe.
      if (!found.reader || !found.account) throw new ApiError("not_found", "no such reader");
      try {
        const r = await retrieveReader(
          options.stripe(),
          found.account,
          found.reader.stripe_reader_id,
        );
        return { id: found.reader.id, label: found.reader.name, online: r.status === "online" };
      } catch (e) {
        return stripeFailure(e);
      }
    },
  );
}
