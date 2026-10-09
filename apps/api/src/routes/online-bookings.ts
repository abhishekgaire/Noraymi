import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  payTokenHash,
  resolveVenueSlug,
  statesOf,
  venueForBookingToken,
  venueModules,
  withVenue,
  type Queryable,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import {
  depositPayLink,
  detailsBody,
  heldBooking,
  holdBooking,
  moreTime,
  onlineAvailability,
  saveDetails,
} from "../bookings/online.js";
import {
  changeBody,
  changeBooking,
  differencePayLink,
  linkedBooking,
  manageView,
} from "../bookings/manage.js";
import { guestCancels } from "../bookings/cancel.js";
import { loadTrustedProxyHops, publicIpOf } from "../router/ip-owner.js";

/**
 * Online booking, the Pick step (M5-07; API · Bookings):
 *   GET  /v1/public/venues/{slug}/availability?date=&guests=&hours=   start times with a free room, and the price
 *   POST /v1/public/venues/{slug}/bookings     { business_date, time, offset?, hours, party_size } → a 10-minute hold and its link
 *   GET  /v1/public/bookings/{token}/hold      the held booking, its countdown and its exact price
 *   POST /v1/public/bookings/{token}/more-time 10 more minutes, ten times
 *   POST /v1/public/bookings/{token}/details   { name, phone, email, marketing } (M5-08: the Details step)
 *   POST /v1/public/bookings/{token}/pay       Terms → Payment: a pay link to the booking's one deposit payment (M5-09),
 *                                              or, once confirmed, to a difference a change left owing (M5-11)
 *   DELETE /v1/public/bookings/{token}         the guest cancels, by the refund cut-off and the accepted policy (M5-12)
 *   PATCH /v1/public/bookings/{token}          the manage page: { party_size?, business_date?, time?, offset?,
 *                                              running_late?, accept_keep?, preview? } (M5-11)
 * The CAPTCHA and daily limits join POST with M5-05 (blocked on M2-27). The hold and more-time
 * routes are the cautious default (the API table names only availability and POST bookings).
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const holdBody = z
  .object({
    business_date: date,
    time: z.string().regex(/^\d{2}:\d{2}$/),
    offset: z
      .string()
      .regex(/^[+-]\d{2}:\d{2}$/)
      .optional(),
    hours: z.number().positive().max(24),
    party_size: z.number().int().min(1).max(500),
  })
  .strict();

export function onlineBookingRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; payAppUrl: string | null },
) {
  const proxyHops = loadTrustedProxyHops();
  const publicRoute = route({ principals: ["public"], module: "core", idempotency: "none" });
  const holdRoute = route({ principals: ["public"], module: "core", idempotency: "optional" });
  const payRoute = route({
    principals: ["public"],
    module: "core",
    tokenRoute: true,
    idempotency: "optional",
  });
  const tokenRoute = route({
    principals: ["public"],
    module: "core",
    tokenRoute: true,
    idempotency: "none",
  });

  /**
   * New bookings need Online booking & deposits on (M5-14; spec 03 · Modules):
   * off or stopping answers 404 module_off. The guest routes for existing
   * bookings (manage, change, cancel, refund status) never call this.
   */
  const takingNewBookings = async (c: Queryable, venueId: string) => {
    if (statesOf(await venueModules(c, venueId))["online_booking"] !== "on")
      throw new ApiError("module_off", "online booking is off at this venue", {
        details: { module: "online_booking" },
      });
  };

  /** A public route by slug: Online booking & deposits has to be on (checked here, in the venue). */
  const bookingVenue = async (slug: string, requestId: string) => {
    const venueId = await resolveVenueSlug(options.pool, slug);
    if (!venueId) throw new ApiError("not_found", "no such venue");
    return {
      venueId,
      run: <T>(fn: (c: Queryable) => Promise<T>) =>
        withVenue(options.pool, { venueId, requestId }, async (c) => {
          await takingNewBookings(c, venueId);
          return fn(c);
        }),
    };
  };

  app.get<{
    Params: { slug: string };
    Querystring: { date?: string; guests?: string; hours?: string };
  }>("/v1/public/venues/:slug/availability", { config: publicRoute }, async (request, reply) => {
    const guests = Number(request.query.guests ?? "");
    const hours = request.query.hours === undefined ? undefined : Number(request.query.hours);
    if (!Number.isInteger(guests) || guests < 1 || guests > 500)
      throw new ApiError("invalid_request", "guests is a whole number");
    if (hours !== undefined && !(hours > 0 && hours <= 24 && Number.isInteger(hours * 2)))
      throw new ApiError("invalid_request", "hours is a whole or half number");
    if (request.query.date !== undefined && !date.safeParse(request.query.date).success)
      throw new ApiError("invalid_request", "date is YYYY-MM-DD");
    const { run, venueId } = await bookingVenue(request.params.slug, request.requestId);
    const view = await run((c) =>
      onlineAvailability(c, venueId, options.clock.now(), {
        date: request.query.date,
        guests,
        hours,
      }),
    );
    reply.header("Cache-Control", "no-store");
    return view;
  });

  app.post<{ Params: { slug: string }; Body: unknown }>(
    "/v1/public/venues/:slug/bookings",
    { config: holdRoute },
    async (request, reply) => {
      const parsed = holdBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { business_date, time, offset?, hours, party_size }",
        );
      const { run, venueId } = await bookingVenue(request.params.slug, request.requestId);
      const now = options.clock.now();
      const held = await run(async (c) => {
        const { token } = await holdBooking(c, venueId, now, parsed.data);
        return { token, booking: await heldBooking(c, venueId, payTokenHash(token), now) };
      });
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send(held);
    },
  );

  const byToken = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new ApiError("not_found", "no such booking");
    const hash = payTokenHash(token);
    const venueId = await venueForBookingToken(options.pool, hash);
    if (!venueId) throw new ApiError("not_found", "no such booking");
    return { venueId, hash };
  };

  app.get<{ Params: { token: string } }>(
    "/v1/public/bookings/:token/hold",
    { config: tokenRoute },
    async (request) => {
      const { venueId, hash } = await byToken(request.params.token);
      return withVenue(options.pool, { venueId, requestId: request.requestId }, (c) =>
        heldBooking(c, venueId, hash, options.clock.now()),
      );
    },
  );

  app.post<{ Params: { token: string } }>(
    "/v1/public/bookings/:token/more-time",
    { config: tokenRoute },
    async (request) => {
      const { venueId, hash } = await byToken(request.params.token);
      const now = options.clock.now();
      return withVenue(options.pool, { venueId, requestId: request.requestId }, async (c) => {
        await takingNewBookings(c, venueId);
        const held = await heldBooking(c, venueId, hash, now);
        await moreTime(c, venueId, held.id, now);
        return heldBooking(c, venueId, hash, now);
      });
    },
  );

  app.post<{ Params: { token: string }; Body: unknown }>(
    "/v1/public/bookings/:token/details",
    { config: tokenRoute },
    async (request) => {
      const parsed = detailsBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { name, phone, email, marketing }: a US mobile number (+1), and an email",
          {
            details: {
              reason: parsed.error.issues.some((i) => i.path[0] === "phone") ? "phone" : "details",
            },
          },
        );
      const { venueId, hash } = await byToken(request.params.token);
      const now = options.clock.now();
      const ip = publicIpOf(request.ip, request.headers["x-forwarded-for"], proxyHops);
      return withVenue(options.pool, { venueId, requestId: request.requestId }, async (c) => {
        await takingNewBookings(c, venueId);
        await saveDetails(c, venueId, hash, now, parsed.data, ip);
        return heldBooking(c, venueId, hash, now);
      });
    },
  );

  app.post<{ Params: { token: string } }>(
    "/v1/public/bookings/:token/pay",
    { config: payRoute },
    async (request) => {
      const { venueId, hash } = await byToken(request.params.token);
      if (!options.payAppUrl)
        throw new ApiError("invalid_request", "the payment page isn't set up here (PAY_APP_URL)");
      const payAppUrl = options.payAppUrl;
      const now = options.clock.now();
      return withVenue(options.pool, { venueId, requestId: request.requestId }, async (c) => {
        // A confirmed booking that owes a difference after a change (M5-11) pays it on the payment page.
        const linked = await linkedBooking(c, venueId, hash, now);
        if (linked?.status === "confirmed")
          return differencePayLink(c, venueId, linked, now, payAppUrl);
        // A guest's own hold becomes a new booking here: not while booking is off or stopping.
        // A staff booking's payment link (M5-13) already sent is an existing booking's link and still pays.
        const source = linked
          ? (
              await c.query<{ source: string }>(
                "select source from bookings where venue_id = $1 and id = $2",
                [venueId, linked.id],
              )
            ).rows[0]?.source
          : undefined;
        if (source !== "staff") await takingNewBookings(c, venueId);
        return depositPayLink(c, venueId, hash, now, payAppUrl);
      });
    },
  );

  // The guest cancels (M5-12): by the refund cut-off and the accepted policy; works with the module off.
  app.delete<{ Params: { token: string } }>(
    "/v1/public/bookings/:token",
    { config: payRoute },
    async (request) => {
      const { venueId, hash } = await byToken(request.params.token);
      const now = options.clock.now();
      return withVenue(options.pool, { venueId, requestId: request.requestId }, async (c) => {
        const linked = await linkedBooking(c, venueId, hash, now, true);
        if (!linked) throw new ApiError("not_found", "no such booking");
        const outcome = await guestCancels(c, venueId, linked.id, now);
        return {
          refund_cents: outcome.refundCents,
          kept_cents: outcome.keptCents,
          booking: await manageView(c, venueId, (await linkedBooking(c, venueId, hash, now))!, now),
        };
      });
    },
  );

  // The manage page's changes (M5-11): time, date, party size, running late; `preview` writes nothing.
  app.patch<{ Params: { token: string }; Body: unknown }>(
    "/v1/public/bookings/:token",
    { config: payRoute },
    async (request) => {
      const parsed = changeBody.safeParse(request.body ?? {});
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { party_size?, business_date?, time?, offset?, running_late?, accept_keep?, preview? }",
        );
      const { venueId, hash } = await byToken(request.params.token);
      return withVenue(options.pool, { venueId, requestId: request.requestId }, (c) =>
        changeBooking(c, venueId, hash, options.clock.now(), parsed.data, options.payAppUrl),
      );
    },
  );
}
