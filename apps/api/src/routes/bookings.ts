import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addBlock,
  bookingById,
  bookingsOn,
  emitEvent,
  findOrCreateGuest,
  insertBooking,
  listRooms,
  moveBlock,
  readSetting,
  releaseBlock,
  RoomNotFree,
  updateBooking,
  type Queryable,
} from "@west4/db";
import { bookingGrid, businessDate, deposit, resolveStart } from "@west4/rules";
import { Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { assignBooking, nightHours, venueClock } from "../rooms/assignment.js";

/**
 * Staff bookings (M2-06; spec 04 · bookings, Room assignment; spec 08 · Bookings):
 *   GET   /v1/venues/{v}/bookings?business_date=     the night's bookings, with their rooms
 *   GET   /v1/venues/{v}/bookings/grid?business_date= start times, both 1:00 AMs on the fall-back night
 *   POST  /v1/venues/{v}/bookings                    a staff booking: a real room, the deposit, pending or confirmed
 *   PATCH /v1/venues/{v}/bookings/{b}                reassign the room, change the party, or cancel
 * Every booking gets a real room; guests see only its size tier. A booking
 * that owes a deposit saves as pending with a hold block until M5's payment
 * link collects it; with deposits off it confirms at once.
 */
interface VenueParams {
  venueId: string;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const createBody = z
  .object({
    guest: z
      .object({
        name: z.string().trim().min(1).max(80),
        phone_e164: z
          .string()
          .regex(/^\+[1-9]\d{6,14}$/)
          .nullable()
          .optional(),
        email: z.string().trim().email().max(254).nullable().optional(),
        locale: z.enum(["en", "es"]).optional(),
      })
      .strict(),
    party_size: z.number().int().min(1),
    business_date: date,
    time: z.string().regex(/^\d{2}:\d{2}$/, "a time as HH:MM"),
    /** Picks one of the two 1:00 AMs on the fall-back night, "-04:00" or "-05:00". */
    offset: z
      .string()
      .regex(/^[+-]\d{2}:\d{2}$/)
      .optional(),
    hours: z.number().positive().multipleOf(0.5),
    room_id: z.string().uuid().optional(),
  })
  .strict();

const patchBody = z
  .object({
    room_id: z.string().uuid().optional(),
    party_size: z.number().int().min(1).optional(),
    status: z.literal("cancelled").optional(),
  })
  .strict();

const bad = (issues: z.ZodIssue[]) =>
  new ApiError(
    "invalid_request",
    issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  );

async function settings(c: Queryable, venueId: string, on: Temporal.PlainDate) {
  const [prices, rule] = await Promise.all([
    readSetting(c, venueId, "prices", on),
    readSetting(c, venueId, "deposit", on),
  ]);
  if (!prices || !rule)
    throw new ApiError("invalid_request", "prices and the deposit rule aren't set for this venue");
  return { prices: prices.value, rule: rule.value };
}

async function blockOf(c: Queryable, venueId: string, bookingId: string) {
  const r = await c.query<{ id: string }>(
    "select id from room_blocks where venue_id = $1 and ref_id = $2 and kind in ('booking', 'hold') limit 1",
    [venueId, bookingId],
  );
  return r.rows[0]?.id ?? null;
}

export function bookingsRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({
    principals: ["owner_manager", "staff"],
    module: "rooms",
    action: "bookings.manage",
  });
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "rooms",
    action: "bookings.manage",
    idempotency: "optional",
    createsNewWork: true,
  });
  const today = async (c: Queryable, venueId: string) => {
    const v = await venueClock(c, venueId);
    return businessDate(options.clock.now(), v.timeZone, v.dayCutover).businessDate;
  };

  app.get<{ Params: VenueParams; Querystring: { business_date?: string } }>(
    "/v1/venues/:venueId/bookings",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => {
        const on = request.query.business_date ?? (await today(c, request.venueId!)).toString();
        if (!date.safeParse(on).success)
          throw new ApiError("invalid_request", "business_date is YYYY-MM-DD");
        return { business_date: on, bookings: await bookingsOn(c, request.venueId!, on) };
      }),
  );

  app.get<{ Params: VenueParams; Querystring: { business_date?: string } }>(
    "/v1/venues/:venueId/bookings/grid",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const venue = await venueClock(c, venueId);
        const on = request.query.business_date
          ? Temporal.PlainDate.from(request.query.business_date)
          : await today(c, venueId);
        const hours = await nightHours(c, venueId, venue, on);
        if (!hours) return { business_date: on.toString(), closed: true, slots: [] };
        const { prices } = await settings(c, venueId, on);
        const now = options.clock.now();
        const slots = bookingGrid({
          opens: hours.opens,
          closes: hours.closes,
          minHours: prices.booking.minHours,
          startSlots: prices.booking.startSlots,
          timeZone: venue.timeZone,
        }).filter((s) => Temporal.Instant.compare(s.start, now) >= 0);
        return {
          business_date: on.toString(),
          closed: false,
          slots: slots.map((s) => ({
            start: s.start.toString(),
            time: s.time,
            zone: s.zone,
            offset: s.offset,
          })),
        };
      }),
  );

  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/bookings",
    { config: write },
    async (request, reply) => {
      const parsed = createBody.safeParse(request.body);
      if (!parsed.success) throw bad(parsed.error.issues);
      const b = parsed.data;
      const venueId = request.venueId!;
      const now = options.clock.now();
      const booking = await request.inVenue(async (c) => {
        const venue = await venueClock(c, venueId);
        const on = Temporal.PlainDate.from(b.business_date);
        const resolved = resolveStart(on, b.time, venue.timeZone, venue.dayCutover, b.offset);
        if ("refused" in resolved)
          throw new ApiError(
            "invalid_request",
            resolved.refused === "does_not_exist"
              ? "that time doesn't exist that night: the clocks skip it"
              : resolved.refused === "ambiguous"
                ? "that time happens twice that night: send its offset (EDT or EST)"
                : "time is HH:MM",
            { details: { reason: resolved.refused } },
          );
        const start = resolved.start;
        if (Temporal.Instant.compare(start, now) < 0)
          throw new ApiError("invalid_request", "that time has passed", {
            details: { reason: "past" },
          });
        const { prices, rule } = await settings(c, venueId, on);
        const limits = prices.booking;
        if (b.hours < limits.minHours || b.hours > limits.maxHours)
          throw new ApiError(
            "invalid_request",
            `a booking is ${limits.minHours} to ${limits.maxHours} hours`,
          );
        if (b.party_size > limits.maxGuests)
          throw new ApiError("invalid_request", `a booking is at most ${limits.maxGuests} guests`);
        const hours = await nightHours(c, venueId, venue, on);
        if (!hours) throw new ApiError("invalid_request", "the venue is closed that night");
        const onGrid = bookingGrid({
          opens: hours.opens,
          closes: hours.closes,
          minHours: limits.minHours,
          startSlots: limits.startSlots,
          timeZone: venue.timeZone,
        }).some((s) => s.start.equals(start));
        if (!onGrid)
          throw new ApiError("invalid_request", "that isn't one of the night's start times", {
            details: { reason: "off_grid" },
          });
        const end = start.add({ minutes: Math.round(b.hours * 60) });
        if (Temporal.Instant.compare(end, hours.closes) > 0)
          throw new ApiError("invalid_request", "a booking must end by the night's close", {
            details: { reason: "past_close" },
          });

        const owed = deposit(b.party_size, on, rule, prices).depositCents;
        const status = owed > 0 ? "pending" : "confirmed";
        const kind = owed > 0 ? "hold" : "booking";
        const guestId = await findOrCreateGuest(c, venueId, {
          name: b.guest.name,
          phoneE164: b.guest.phone_e164 ?? null,
          email: b.guest.email ?? null,
          ...(b.guest.locale ? { locale: b.guest.locale } : {}),
        });

        // The room: the one staff picked (it must fit and be free), or the smallest free one that fits.
        let roomId: string;
        let blockId: string;
        if (b.room_id) {
          const room = (await listRooms(c, venueId)).find((r) => r.id === b.room_id);
          if (!room) throw new ApiError("not_found", "no such room");
          if (room.state === "out_of_service")
            throw new ApiError("room_not_free", "that room is out of service");
          if (b.party_size > room.capacity_max)
            throw new ApiError("invalid_request", "the party doesn't fit that room");
          try {
            const block = await addBlock(c, {
              venueId,
              roomId: room.id,
              kind,
              from: start,
              to: end,
              refId: null,
            });
            roomId = room.id;
            blockId = block.id;
          } catch (e) {
            if (e instanceof RoomNotFree)
              throw new ApiError("room_not_free", "that room is taken at that time");
            throw e;
          }
        } else {
          const block = await assignBooking(c, venueId, {
            party: b.party_size,
            from: start,
            to: end,
            refId: null,
            kind,
          });
          roomId = block.room_id;
          blockId = block.id;
        }
        const room = (await listRooms(c, venueId)).find((r) => r.id === roomId)!;
        const id = await insertBooking(c, venueId, {
          guestId,
          roomId,
          sizeTier: room.size_tier,
          partySize: b.party_size,
          startsAt: start.toString(),
          endsAt: end.toString(),
          businessDate: on.toString(),
          status,
          source: "staff",
          depositCents: owed,
          refundCutoffAt:
            owed > 0
              ? start.subtract({ minutes: Math.round(rule.refundHours * 60) }).toString()
              : null,
        });
        await c.query("update room_blocks set ref_id = $3 where venue_id = $1 and id = $2", [
          venueId,
          blockId,
          id,
        ]);
        await emitEvent(c, { venueId, type: "booking.updated", entityId: id, entityVersion: 0 });
        return bookingById(c, venueId, id);
      });
      return reply.code(201).send({ booking });
    },
  );

  app.patch<{ Params: VenueParams & { bookingId: string }; Body: unknown }>(
    "/v1/venues/:venueId/bookings/:bookingId",
    { config: write },
    async (request) => {
      const parsed = patchBody.safeParse(request.body);
      if (!parsed.success) throw bad(parsed.error.issues);
      const b = parsed.data;
      if (Object.keys(b).length === 0) throw new ApiError("invalid_request", "nothing to change");
      const venueId = request.venueId!;
      const p = request.principal;
      return request.inVenue(async (c) => {
        const booking = await bookingById(c, venueId, request.params.bookingId);
        if (!booking) throw new ApiError("not_found", "no such booking");
        if (booking.status !== "pending" && booking.status !== "confirmed")
          throw new ApiError(
            "invalid_request",
            `a ${booking.status} booking can't be changed here`,
          );
        const blockId = await blockOf(c, venueId, booking.id);
        if (b.status === "cancelled") {
          if (blockId) await releaseBlock(c, blockId);
          await updateBooking(c, venueId, booking.id, {
            status: "cancelled",
            cancelledBy: p.kind === "user" ? p.userId : null,
          });
        } else {
          const rooms = await listRooms(c, venueId);
          const party = b.party_size ?? booking.party_size;
          const target = rooms.find((r) => r.id === (b.room_id ?? booking.room_id));
          if (!target) throw new ApiError("not_found", "no such room");
          if (party > target.capacity_max)
            throw new ApiError("invalid_request", "the party doesn't fit that room");
          if (b.room_id && b.room_id !== booking.room_id) {
            if (target.state === "out_of_service")
              throw new ApiError("room_not_free", "that room is out of service");
            try {
              if (blockId) await moveBlock(c, venueId, blockId, target.id);
            } catch (e) {
              if (e instanceof RoomNotFree)
                throw new ApiError("room_not_free", "that room is taken at that time");
              throw e;
            }
          }
          await updateBooking(c, venueId, booking.id, {
            ...(b.room_id ? { roomId: target.id, sizeTier: target.size_tier } : {}),
            ...(b.party_size ? { partySize: b.party_size } : {}),
          });
        }
        await emitEvent(c, {
          venueId,
          type: "booking.updated",
          entityId: booking.id,
          entityVersion: 0,
        });
        return { booking: await bookingById(c, venueId, booking.id) };
      });
    },
  );
}
