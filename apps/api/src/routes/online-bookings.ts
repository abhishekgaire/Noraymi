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
import { heldBooking, holdBooking, moreTime, onlineAvailability } from "../bookings/online.js";

/**
 * Online booking, the Pick step (M5-07; API · Bookings):
 *   GET  /v1/public/venues/{slug}/availability?date=&guests=&hours=   start times with a free room, and the price
 *   POST /v1/public/venues/{slug}/bookings     { business_date, time, offset?, hours, party_size } → a 10-minute hold and its link
 *   GET  /v1/public/bookings/{token}/hold      the held booking, its countdown and its exact price
 *   POST /v1/public/bookings/{token}/more-time 10 more minutes, ten times
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
  options: { pool: pg.Pool; clock: Clock },
) {
  const publicRoute = route({ principals: ["public"], module: "core", idempotency: "none" });
  const holdRoute = route({ principals: ["public"], module: "core", idempotency: "optional" });
  const tokenRoute = route({
    principals: ["public"],
    module: "core",
    tokenRoute: true,
    idempotency: "none",
  });

  /** A public route by slug: Online booking & deposits has to be on (checked here, in the venue). */
  const bookingVenue = async (slug: string, requestId: string) => {
    const venueId = await resolveVenueSlug(options.pool, slug);
    if (!venueId) throw new ApiError("not_found", "no such venue");
    return {
      venueId,
      run: <T>(fn: (c: Queryable) => Promise<T>) =>
        withVenue(options.pool, { venueId, requestId }, async (c) => {
          if (statesOf(await venueModules(c, venueId))["online_booking"] !== "on")
            throw new ApiError("not_found", "online booking is off", {
              details: { reason: "booking_off" },
            });
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
        const held = await heldBooking(c, venueId, hash, now);
        await moreTime(c, venueId, held.id, now);
        return heldBooking(c, venueId, hash, now);
      });
    },
  );
}
