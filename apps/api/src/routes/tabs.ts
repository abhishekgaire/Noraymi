import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { listTabs } from "../tabs/tabs.js";
import { repeatRound } from "../tabs/repeat.js";
import {
  backToTheSale,
  quickSaleNumber,
  quickSaleView,
  startQuickSale,
} from "../tabs/quick-sale.js";
import { inVenueRefusing } from "../orders/alcohol.js";
import type { StripeClient } from "../stripe/client.js";
import {
  cancelPayment,
  checkNow,
  enqueueRun,
  quiet,
  runNow,
  type PaymentDeps,
} from "../payments/run.js";
import { confirmCollected } from "../payments/surcharge.js";
import { latestAttempt, paymentById } from "@west4/db";
import { screenState } from "../payments/machine.js";
import {
  nameOpening,
  openingView,
  reserveTabCheckNumber,
  tabConsent,
  writeTabOpening,
} from "../tabs/open.js";

/**
 * Bar tabs (M6-02; API · Bar tabs):
 *   GET /v1/venues/{v}/tabs?state=   open tabs in the order opened and tonight's closed ones;
 *                                    ?state=awaiting_tip (and other states, comma-separated) filters
 *   POST /v1/venues/{v}/tabs/{t}/repeat-round   the last round into the caller's unsent drinks (M6-03)
 *   POST /v1/venues/{v}/quick-sales             { client_order_id, lines }: a quick check with the round, ready to pay (M6-05)
 *   GET  /v1/venues/{v}/quick-sales/{c}         the sale and the reader's tip choices
 *   POST /v1/venues/{v}/quick-sales/{c}/void    Back to the sale: voided, number kept, drinks back in the round
 *   GET  /v1/venues/{v}/tabs/consent             the consent line read out at New tab, and its policy version (M6-06)
 *   POST /v1/venues/{v}/tabs                     { reader_id, consent_text_version, name?, label?, party_size? }:
 *                                                Open, card first; the bar reader collects the card (M6-06)
 *   POST /v1/venues/{v}/tabs/openings/{o}/check-status   read Stripe now: the card checked, the hold confirmed
 *   POST /v1/venues/{v}/tabs/openings/{o}/name           Open: { name, label } typed or tapped while the guest taps
 *   POST /v1/venues/{v}/tabs/openings/{o}/cancel         the card never came: nothing held, nothing opened
 * Closing and the rest of the tab routes come with M6-07 onwards.
 */
const STATES =
  /^(open|tipping|awaiting_tip|captured|walkout_captured|capture_failed|closed)(,(open|tipping|awaiting_tip|captured|walkout_captured|capture_failed|closed))*$/;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tabRoutes(
  app: FastifyInstance,
  options: { clock: Clock; pool: pg.Pool; stripe: () => StripeClient },
): void {
  const deps = (): PaymentDeps => ({
    pool: options.pool,
    stripe: options.stripe(),
    clock: options.clock,
  });
  app.get<{ Params: { venueId: string }; Querystring: { state?: string } }>(
    "/v1/venues/:venueId/tabs",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
      }),
    },
    async (request) => {
      if (request.query.state !== undefined && !STATES.test(request.query.state))
        throw new ApiError("invalid_request", "state is one of the tab states");
      const p = request.principal;
      const membershipId =
        p.kind === "user"
          ? (p.memberships.find((m) => m.venueId === request.venueId)?.membershipId ?? null)
          : null;
      const tabs = await request.inVenue((c) =>
        listTabs(c, request.venueId!, options.clock.now(), {
          state: request.query.state,
          membershipId,
        }),
      );
      return { tabs };
    },
  );

  // Repeat round (M6-03): the last round, into the caller's unsent drinks; Send still sends it.
  app.post<{ Params: { venueId: string; t: string } }>(
    "/v1/venues/:venueId/tabs/:t/repeat-round",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!uuid.test(request.params.t)) throw new ApiError("not_found", "no such tab");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const m = p.memberships.find((x) => x.venueId === request.venueId);
      if (!m) throw new ApiError("forbidden", "not a member of this venue");
      return request.inVenue((c) =>
        repeatRound(
          c,
          request.venueId!,
          request.params.t,
          {
            membershipId: m.membershipId,
            userId: p.userId,
            deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
          },
          options.clock.now(),
        ),
      );
    },
  );

  const id = z.string().uuid();
  const quickBody = z
    .object({
      client_order_id: z.string().min(8).max(64),
      lines: z
        .array(
          z
            .object({
              variant_id: id,
              qty: z.number().int().min(1).max(99),
              option_ids: z.array(id).max(10).optional(),
              notes: z.string().max(200).nullable().optional(),
            })
            .strict(),
        )
        .max(50),
    })
    .strict();
  const sell = route({
    principals: ["owner_manager", "staff"],
    module: "bar_tabs",
    action: "pos.use",
    idempotency: "optional",
  });

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/quick-sales",
    { config: sell },
    async (request, reply) => {
      const parsed = quickBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { client_order_id, lines }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const m = p.memberships.find((x) => x.venueId === request.venueId);
      if (!m) throw new ApiError("forbidden", "not a member of this venue");
      const number = await quickSaleNumber(options.pool, request.venueId!);
      const sale = await inVenueRefusing(request, (c) =>
        startQuickSale(c, request.venueId!, {
          number,
          lines: parsed.data.lines,
          clientOrderId: parsed.data.client_order_id,
          userId: p.userId,
          membershipId: m.membershipId,
          deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send(sale);
    },
  );

  app.get<{ Params: { venueId: string; checkId: string } }>(
    "/v1/venues/:venueId/quick-sales/:checkId",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
      }),
    },
    async (request) => {
      if (!id.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such sale");
      return request.inVenue(async (c) => {
        const k = await c.query(
          "select 1 from checks where venue_id = $1 and id = $2 and kind = 'quick'",
          [request.venueId, request.params.checkId],
        );
        if (k.rowCount === 0) throw new ApiError("not_found", "no such sale");
        return quickSaleView(c, request.venueId!, request.params.checkId, options.clock.now());
      });
    },
  );

  app.post<{ Params: { venueId: string; checkId: string } }>(
    "/v1/venues/:venueId/quick-sales/:checkId/void",
    { config: sell },
    async (request) => {
      if (!id.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such sale");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const m = p.memberships.find((x) => x.venueId === request.venueId);
      if (!m) throw new ApiError("forbidden", "not a member of this venue");
      return request.inVenue((c) =>
        backToTheSale(c, request.venueId!, request.params.checkId, {
          userId: p.userId,
          membershipId: m.membershipId,
          deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
          now: options.clock.now(),
        }),
      );
    },
  );

  // New tab (M6-06): the consent line, built from the tab settings and saved as a policy version.
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/tabs/consent",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
      }),
    },
    async (request) => request.inVenue((c) => tabConsent(c, request.venueId!, options.clock.now())),
  );

  const openBody = z
    .object({
      reader_id: id,
      consent_text_version: id,
      name: z.string().trim().min(1).max(80).nullable().optional(),
      label: z.string().trim().min(1).max(80).nullable().optional(),
      party_size: z.number().int().min(1).max(200).nullable().optional(),
    })
    .strict();
  const opening = route({
    principals: ["owner_manager", "staff"],
    module: "bar_tabs",
    action: "pos.use",
    idempotency: "required",
  });

  /** The opening as New tab shows it: waiting on the reader, declined, opened, or the card's open tab. */
  const view = async (request: FastifyRequest, openingId: string) =>
    request.inVenue(async (q) => {
      const venueId = request.venueId!;
      const o = await openingView(q, venueId, openingId);
      const payment = (await paymentById(q, venueId, o.payment_id))!;
      const attempt = await latestAttempt(q, venueId, o.payment_id);
      return {
        id: o.id,
        state: o.state,
        payment: {
          id: payment.id,
          status: payment.status,
          state: screenState(payment, attempt),
          decline_code: attempt?.state === "failed" ? attempt.decline_code : null,
        },
        card: o.card_last4 ? { brand: o.card_brand, last4: o.card_last4 } : null,
        tab: o.tab_id ? { id: o.tab_id, check_id: o.tab_check_id, name: o.tab_name } : null,
      };
    });

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/tabs",
    { config: opening },
    async (request, reply) => {
      const parsed = openBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { reader_id, consent_text_version, … }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const m = p.memberships.find((x) => x.venueId === request.venueId);
      if (!m) throw new ApiError("forbidden", "not a member of this venue");
      const venueId = request.venueId!;
      const payments = deps();
      const number = await reserveTabCheckNumber(options.pool, venueId);
      const written = await request.inVenue((c) =>
        writeTabOpening(
          c,
          venueId,
          {
            readerDeviceId: parsed.data.reader_id,
            consentVersionId: parsed.data.consent_text_version,
            name: parsed.data.name ?? null,
            label: parsed.data.label ?? null,
            partySize: parsed.data.party_size ?? null,
            checkNumber: number,
            userId: p.userId,
            membershipId: m.membershipId,
            now: options.clock.now(),
          },
          { readerQuiet: quiet, enqueueRun },
        ),
      );
      // The bar reader goes to work outside any transaction (M4-05).
      await runNow(payments, venueId, written.paymentId, written.attemptNo);
      const v = await view(request, written.openingId);
      if (v.payment.decline_code === "terminal_reader_offline")
        throw new ApiError(
          "reader_offline",
          "the bar reader is offline: no new tabs until it's back",
          {
            details: { opening: v },
          },
        );
      if (v.payment.decline_code === "terminal_reader_busy")
        throw new ApiError("reader_busy", "another payment is on the bar reader", {
          details: { opening: v },
        });
      return reply.code(201).send(v);
    },
  );

  const openingParam = (o: string) => {
    if (!id.safeParse(o).success) throw new ApiError("not_found", "no such tab opening");
    return o;
  };
  const paymentOfOpening = async (request: FastifyRequest, o: string) =>
    (await view(request, o)).payment.id;

  app.post<{ Params: { venueId: string; o: string } }>(
    "/v1/venues/:venueId/tabs/openings/:o/check-status",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const o = openingParam(request.params.o);
      const venueId = request.venueId!;
      const paymentId = await paymentOfOpening(request, o);
      // The card collected: checked against the open tabs, then confirmed (or its open tab opened).
      await confirmCollected(deps(), venueId, paymentId).catch(() => undefined);
      await checkNow(deps(), venueId, paymentId, "api");
      return view(request, o);
    },
  );

  app.post<{ Params: { venueId: string; o: string } }>(
    "/v1/venues/:venueId/tabs/openings/:o/cancel",
    { config: opening },
    async (request) => {
      const o = openingParam(request.params.o);
      const venueId = request.venueId!;
      const paymentId = await paymentOfOpening(request, o);
      await cancelPayment(deps(), venueId, paymentId, "api");
      return view(request, o);
    },
  );

  const nameBody = z
    .object({
      name: z.string().trim().min(1).max(80).nullable(),
      label: z.string().trim().min(1).max(80).nullable(),
    })
    .strict();
  app.post<{ Params: { venueId: string; o: string }; Body: unknown }>(
    "/v1/venues/:venueId/tabs/openings/:o/name",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const o = openingParam(request.params.o);
      const parsed = nameBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { name, label }");
      await request.inVenue((c) =>
        nameOpening(c, request.venueId!, o, {
          name: parsed.data.name,
          label: parsed.data.label,
        }),
      );
      return view(request, o);
    },
  );
}
