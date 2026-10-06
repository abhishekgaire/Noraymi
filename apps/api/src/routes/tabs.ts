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
import type { ReceiptDeps } from "../receipts/send.js";
import {
  askReader,
  cancelClose,
  checkClose,
  chooseReceipt,
  closeView,
  driveClose,
  latestClosing,
  startClose,
} from "../tabs/close.js";
import { latestAttempt, paymentById } from "@west4/db";
import { enterSlipTip } from "../tabs/tip.js";
import { splitTab } from "../tabs/split.js";
import { declinedOnTab } from "../tabs/pay.js";
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
 *   POST /v1/venues/{v}/tabs/{t}/close            { tip: reader | slip | none, reader_id? }: Close (M6-08); the reader
 *                                                asks for the tip, or the hold is captured at once, or the
 *                                                paper slip prints and the tab is awaiting_tip (M6-09)
 *   POST /v1/venues/{v}/tabs/{t}/pay              { method: tap, amount_cents, reader_id } or { method: cash,
 *                                                amount_cents, tendered_cents, tip_cents? }: another card or
 *                                                cash for the balance (M6-11, in routes/payments.ts); once it
 *                                                succeeds the hold is canceled and the tab is closed
 *   POST /v1/venues/{v}/tabs/{t}/split            { shares: 2-4 }: split evenly, kept on the server (M6-10); each
 *                                                share pays by a new tap or cash (POST /checks/{c}/payments with
 *                                                share_id), the held card's last, by Close to the card
 *   GET  /v1/venues/{v}/tabs/{t}/close            the tab's latest Close: the tip asked or picked, the capture
 *   POST /v1/venues/{v}/tabs/{t}/close/check-status   read the reader and Stripe now
 *   POST /v1/venues/{v}/tabs/{t}/close/cancel     Cancel while the reader asks: the tab is open again
 *   POST /v1/venues/{v}/tabs/{t}/close/receipt    { choice: text | print | none }: text asks the guest's number
 *                                                on the reader
 *   POST /v1/venues/{v}/tabs/{t}/tip              { tip_cents, photo_file_id? }: the tip from the signed paper
 *                                                slip, with its photo (M6-09); captured now, or 202
 *                                                approval_pending (tip_review) over 25%, over $50 or 2 h late
 */
const STATES =
  /^(open|tipping|awaiting_tip|captured|walkout_captured|capture_failed|closed)(,(open|tipping|awaiting_tip|captured|walkout_captured|capture_failed|closed))*$/;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tabRoutes(
  app: FastifyInstance,
  options: { clock: Clock; pool: pg.Pool; stripe: () => StripeClient; receipts?: ReceiptDeps },
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

  // Close (M6-08): the tip on the reader, then the hold captured with it in one call.
  const tabParam = (t: string) => {
    if (!uuid.test(t)) throw new ApiError("not_found", "no such tab");
    return t;
  };
  const closing = async (request: FastifyRequest, tabId: string) =>
    request.inVenue(async (c) => {
      const k = await c.query("select 1 from tabs where venue_id = $1 and id = $2", [
        request.venueId,
        tabId,
      ]);
      if (k.rowCount === 0) throw new ApiError("not_found", "no such tab");
      const found = await latestClosing(c, request.venueId!, tabId);
      if (!found) throw new ApiError("not_found", "this tab hasn't been closed");
      return found;
    });
  const closed = async (request: FastifyRequest, tabId: string) =>
    request.inVenue(async (c) => {
      const found = await latestClosing(c, request.venueId!, tabId);
      if (!found) throw new ApiError("not_found", "this tab hasn't been closed");
      return closeView(c, request.venueId!, found);
    });
  const closeBody = z
    .object({ tip: z.enum(["reader", "slip", "none"]), reader_id: id.nullable().optional() })
    .strict();
  const closeRoute = route({
    principals: ["owner_manager", "staff"],
    module: "bar_tabs",
    action: "pos.use",
    idempotency: "required",
  });

  app.post<{ Params: { venueId: string; t: string }; Body: unknown }>(
    "/v1/venues/:venueId/tabs/:t/close",
    { config: closeRoute },
    async (request) => {
      const tabId = tabParam(request.params.t);
      const parsed = closeBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { tip: reader | slip | none, reader_id }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const venueId = request.venueId!;
      const payments = deps();
      // Another card declined on this tab (M6-11) is set aside first: the hold still guarantees it.
      for (const id of await request.inVenue((c) => declinedOnTab(c, venueId, tabId)))
        await cancelPayment(payments, venueId, id, "api");
      const started = await request.inVenue((c) =>
        startClose(c, venueId, tabId, {
          path: parsed.data.tip,
          readerDeviceId: parsed.data.reader_id ?? null,
          userId: p.userId,
          now: options.clock.now(),
          readerQuiet: quiet,
        }),
      );
      // The paper slip printed: the Close waits as `slip`, the tab as awaiting_tip (M6-09).
      if (started.kind === "slip") return closed(request, tabId);
      if (started.kind === "run") await driveClose(payments, venueId, started.paymentId);
      else {
        // The reader asks outside any transaction; one that can't puts the tab back to open.
        const asked = await askReader(payments, venueId, started.closingId);
        if (asked === "offline")
          throw new ApiError(
            "reader_offline",
            "the bar reader is offline: print the slip instead",
            {
              details: { reader_id: parsed.data.reader_id, slip: true },
            },
          );
        if (asked === "busy")
          throw new ApiError("reader_busy", "another payment is on the bar reader");
      }
      return closed(request, tabId);
    },
  );

  // Split (M6-10): evenly 2, 3 or 4 ways, kept on the server; each share pays through
  // POST /checks/{c}/payments with its share_id, and the held card's share by Close to the card, last.
  const splitBody = z.object({ shares: z.number().int().min(2).max(4) }).strict();
  app.post<{ Params: { venueId: string; t: string }; Body: unknown }>(
    "/v1/venues/:venueId/tabs/:t/split",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      const tabId = tabParam(request.params.t);
      const parsed = splitBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { shares: 2, 3 or 4 }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "splitting is a person's work");
      const split = await request.inVenue((c) =>
        splitTab(c, request.venueId!, tabId, parsed.data.shares, {
          userId: p.userId,
          now: options.clock.now(),
        }),
      );
      reply.code(201);
      return { split };
    },
  );

  app.get<{ Params: { venueId: string; t: string } }>(
    "/v1/venues/:venueId/tabs/:t/close",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
      }),
    },
    async (request) => {
      const tabId = tabParam(request.params.t);
      await closing(request, tabId);
      return closed(request, tabId);
    },
  );

  const closeStep = route({
    principals: ["owner_manager", "staff"],
    module: "bar_tabs",
    action: "pos.use",
    idempotency: "optional",
  });
  app.post<{ Params: { venueId: string; t: string } }>(
    "/v1/venues/:venueId/tabs/:t/close/check-status",
    { config: closeStep },
    async (request) => {
      const tabId = tabParam(request.params.t);
      const found = await closing(request, tabId);
      const venueId = request.venueId!;
      await checkClose({ ...deps(), receipts: options.receipts ?? null }, venueId, found.id);
      // A capture or raise that's unclear is read from Stripe too.
      await checkNow(deps(), venueId, found.payment_id, "api").catch(() => undefined);
      return closed(request, tabId);
    },
  );

  app.post<{ Params: { venueId: string; t: string } }>(
    "/v1/venues/:venueId/tabs/:t/close/cancel",
    { config: closeStep },
    async (request) => {
      const tabId = tabParam(request.params.t);
      const found = await closing(request, tabId);
      await cancelClose(deps(), request.venueId!, found.id);
      return closed(request, tabId);
    },
  );

  const receiptBody = z.object({ choice: z.enum(["text", "print", "none"]) }).strict();
  app.post<{ Params: { venueId: string; t: string }; Body: unknown }>(
    "/v1/venues/:venueId/tabs/:t/close/receipt",
    { config: closeStep },
    async (request) => {
      const tabId = tabParam(request.params.t);
      const parsed = receiptBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { choice: text | print | none }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      if (!options.receipts) throw new ApiError("internal", "receipts aren't set up here");
      const found = await closing(request, tabId);
      const venueId = request.venueId!;
      await request.inVenue((c) =>
        chooseReceipt(c, venueId, found.id, {
          choice: parsed.data.choice,
          receipts: options.receipts!,
          userId: p.userId,
          now: options.clock.now(),
        }),
      );
      if (parsed.data.choice === "text") {
        const asked = await askReader(deps(), venueId, found.id);
        if (asked === "offline")
          throw new ApiError("reader_offline", "the bar reader is offline: print it instead");
        if (asked === "busy")
          throw new ApiError("reader_busy", "another payment is on the bar reader");
      }
      return closed(request, tabId);
    },
  );
  // Tips to enter (M6-09): the tip from the signed paper slip, with its photo.
  const tipBody = z
    .object({
      tip_cents: z.number().int().min(0).max(99_999),
      photo_file_id: id.nullable().optional(),
    })
    .strict();
  app.post<{ Params: { venueId: string; t: string }; Body: unknown }>(
    "/v1/venues/:venueId/tabs/:t/tip",
    { config: closeRoute },
    async (request, reply) => {
      const tabId = tabParam(request.params.t);
      const parsed = tipBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { tip_cents, photo_file_id }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const venueId = request.venueId!;
      const entered = await request.inVenue((c) =>
        enterSlipTip(c, venueId, tabId, {
          tipCents: parsed.data.tip_cents,
          photoFileId: parsed.data.photo_file_id ?? null,
          userId: p.userId,
          deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
          now: options.clock.now(),
        }),
      );
      if (entered.kind === "approval") return reply.code(202).send(entered.pending);
      await driveClose(deps(), venueId, entered.paymentId);
      return closed(request, tabId);
    },
  );
}
