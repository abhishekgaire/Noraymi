import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { emailRoomQr, printRoomQr } from "../rooms/room-qr.js";
import {
  checkIn,
  checkInPreview,
  markNoShow,
  seatWalkIn,
  type CheckInSettings,
} from "../rooms/checkin.js";

/**
 * Check-in (M2-11; spec 08 · Bookings, Board and sessions):
 *   GET  /v1/venues/{v}/check-in/preview?booking=&room=&party=   what the sheet shows
 *   POST /v1/venues/{v}/bookings/{b}/check-in   { party_size, ids_checked, room_id?, start_at?: "now" | "booked" }
 *   POST /v1/venues/{v}/bookings/{b}/no-show    after the grace (or a running-late hold, if later)
 *   POST /v1/venues/{v}/rooms/{r}/sessions      a walk-in: the check-in body plus minutes and the guest,
 *        and (P-04) a note, time ("pay_as_you_go" or "prepaid") and a package_id with a length
 */
const checkInBody = z
  .object({
    party_size: z.number().int().min(1),
    ids_checked: z.number().int().min(0),
    room_id: z.string().uuid().optional(),
    start_at: z.enum(["now", "booked"]).optional(),
    // Starting a room (P-04): a note shown on the tile and at close-out.
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

const walkInBody = z
  .object({
    party_size: z.number().int().min(1),
    ids_checked: z.number().int().min(0),
    minutes: z.number().int().min(15).max(720),
    guest: z
      .object({
        name: z.string().trim().min(1).max(80),
        phone_e164: z
          .string()
          .regex(/^\+[1-9]\d{6,14}$/)
          .nullable()
          .optional(),
        // The host's email (F-07): the room's QR goes to it.
        email: z.string().trim().email().max(254).nullable().optional(),
      })
      .strict()
      .optional(),
    // Starting a room (P-04): a note; pay as you go (the default) or a prepaid block of `minutes`;
    // or a package with a length, which sets the minutes and is the prepaid block.
    note: z.string().trim().max(200).nullable().optional(),
    time: z.enum(["pay_as_you_go", "prepaid"]).optional(),
    package_id: z.string().uuid().optional(),
  })
  .strict();

export function checkInRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; settings: CheckInSettings },
): void {
  const ctx = { pool: options.pool, clock: options.clock, settings: options.settings };
  const read = route({
    principals: ["owner_manager", "staff"],
    module: "rooms",
    action: "guests.checkin",
  });
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "rooms",
    action: "guests.checkin",
    idempotency: "optional",
    createsNewWork: true,
  });
  const userOf = (p: { kind: string; userId?: string }) => {
    if (p.kind !== "user" || !p.userId)
      throw new ApiError("forbidden", "check-in is a person's work");
    return p.userId;
  };

  app.get<{
    Params: { venueId: string };
    Querystring: { booking?: string; room?: string; party?: string };
  }>("/v1/venues/:venueId/check-in/preview", { config: read }, async (request) => {
    const party = request.query.party ? Number(request.query.party) : undefined;
    if (party !== undefined && (!Number.isInteger(party) || party < 1))
      throw new ApiError("invalid_request", "party is a whole number");
    if (!request.query.booking && !request.query.room)
      throw new ApiError("invalid_request", "send booking or room");
    return request.inVenue((c) =>
      checkInPreview(
        c,
        request.venueId!,
        {
          ...(request.query.booking ? { bookingId: request.query.booking } : {}),
          ...(request.query.room ? { roomId: request.query.room } : {}),
          ...(party ? { partySize: party } : {}),
        },
        options.clock.now(),
        { guestAppUrl: options.settings.guestAppUrl },
      ),
    );
  });

  app.post<{ Params: { venueId: string; bookingId: string }; Body: unknown }>(
    "/v1/venues/:venueId/bookings/:bookingId/check-in",
    { config: write },
    async (request, reply) => {
      const parsed = checkInBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { party_size, ids_checked, room_id?, start_at? }",
        );
      const seated = await checkIn(
        ctx,
        request.venueId!,
        request.params.bookingId,
        parsed.data,
        userOf(request.principal as never),
      );
      return reply.code(201).send(seated);
    },
  );

  app.post<{ Params: { venueId: string; bookingId: string } }>(
    "/v1/venues/:venueId/bookings/:bookingId/no-show",
    { config: write },
    async (request) =>
      markNoShow(
        ctx,
        request.venueId!,
        request.params.bookingId,
        userOf(request.principal as never),
      ),
  );

  app.post<{ Params: { venueId: string; r: string }; Body: unknown }>(
    "/v1/venues/:venueId/rooms/:r/sessions",
    { config: write },
    async (request, reply) => {
      const parsed = walkInBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { party_size, ids_checked, minutes, guest?, note?, time?, package_id? }",
        );
      const p = request.principal;
      const membership =
        p.kind === "user" ? p.memberships.find((m) => m.venueId === request.venueId) : undefined;
      const seated = await seatWalkIn(
        ctx,
        request.venueId!,
        request.params.r,
        parsed.data,
        userOf(request.principal as never),
        request.training,
        membership
          ? {
              membershipId: membership.membershipId,
              deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
            }
          : null,
      );
      return reply.code(201).send(seated);
    },
  );

  /**
   * Reprint QR and Email it again (F-07; D124): the room's current code, printed on the front
   * desk's receipt printer, and emailed to the host when `email` is asked and their email is known.
   * Each print is a print_jobs row on the record. Only while Ordering from the room is on.
   */
  const qrBody = z
    .object({ print: z.boolean().optional(), email: z.boolean().optional() })
    .strict();
  app.post<{ Params: { venueId: string; sessionId: string }; Body: unknown }>(
    "/v1/venues/:venueId/sessions/:sessionId/qr",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "room_ordering",
        action: "guests.checkin",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const parsed = qrBody.safeParse(request.body ?? {});
      if (!parsed.success) throw new ApiError("invalid_request", "send { print?, email? }");
      if (!z.string().uuid().safeParse(request.params.sessionId).success)
        throw new ApiError("not_found", "no such room session");
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const open = await c.query(
          "select 1 from room_sessions where venue_id = $1 and id = $2 and ended_at is null",
          [venueId, request.params.sessionId],
        );
        if (!open.rowCount) throw new ApiError("not_found", "no such room session");
        const printed =
          parsed.data.print === false
            ? null
            : await printRoomQr(c, venueId, request.params.sessionId, {
                now,
                guestAppUrl: options.settings.guestAppUrl,
              });
        const emailed = parsed.data.email
          ? await emailRoomQr(c, venueId, request.params.sessionId, {
              now,
              guestAppUrl: options.settings.guestAppUrl,
              email: options.settings.email ?? { allowList: null },
              again: true,
            })
          : null;
        return {
          printed: printed !== null,
          reprint_n: printed?.reprint_n ?? null,
          emailed: emailed?.to ?? null,
        };
      });
    },
  );
}
