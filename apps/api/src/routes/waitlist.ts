import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  conversationFor,
  emitEvent,
  resolveVenueSlug,
  resolveWaitlistToken,
  setWaitlistQuote,
  waitlistEntry,
  withVenue,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { endEntry, guestView, hashToken, joinWaitlist, staffWaitlist } from "../rooms/waitlist.js";

/**
 * The waitlist (M2-25; spec 08 · Waitlist).
 * Staff:
 *   GET   /v1/venues/{v}/waitlist                  the live list
 *   POST  /v1/venues/{v}/waitlist                  { name, phone, party_size, quoted_min? } from the drawer
 *   PATCH /v1/venues/{v}/waitlist/{w}              { quoted_min } (staff set quotes)
 *   POST  /v1/venues/{v}/waitlist/{w}/remove
 *   POST  /v1/venues/{v}/waitlist/{w}/text         the entry's conversation, to open in Messages
 * Public, the door QR and the guest's link:
 *   POST  /v1/public/venues/{slug}/waitlist        { name, phone, party_size } → a link token
 *   GET   /v1/public/waitlist/{token}              the place in line
 *   PATCH /v1/public/waitlist/{token}              { action: "leave" | "decline" }
 */
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/);
const staffBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    phone,
    party_size: z.number().int().min(1).max(500),
    quoted_min: z.number().int().min(0).max(600).nullable().optional(),
  })
  .strict();
const doorBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    phone,
    party_size: z.number().int().min(1).max(500),
  })
  .strict();

export function waitlistRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock },
): void {
  const read = route({
    principals: ["owner_manager", "staff", "shared_device"],
    module: "waitlist",
  });
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "waitlist",
    action: "waitlist.manage",
    idempotency: "optional",
  });
  const bad = () => new ApiError("invalid_request", "send { name, phone, party_size }");

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/waitlist",
    { config: read },
    async (request) => ({
      entries: await request.inVenue((c) =>
        staffWaitlist(c, request.venueId!, options.clock.now()),
      ),
    }),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/waitlist",
    { config: write },
    async (request, reply) => {
      const parsed = staffBody.safeParse(request.body);
      if (!parsed.success) throw bad();
      const venueId = request.venueId!;
      const entry = await request.inVenue(async (c) => {
        const { entryId } = await joinWaitlist(c, venueId, {
          name: parsed.data.name,
          phone: parsed.data.phone,
          partySize: parsed.data.party_size,
          quotedMin: parsed.data.quoted_min ?? null,
          source: "staff",
          now: options.clock.now(),
        });
        return waitlistEntry(c, venueId, entryId);
      });
      return reply.code(201).send({ entry });
    },
  );

  app.patch<{ Params: { venueId: string; w: string }; Body: unknown }>(
    "/v1/venues/:venueId/waitlist/:w",
    { config: write },
    async (request) => {
      const parsed = z
        .object({ quoted_min: z.number().int().min(0).max(600).nullable() })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { quoted_min }");
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        if (!(await setWaitlistQuote(c, venueId, request.params.w, parsed.data.quoted_min)))
          throw new ApiError("not_found", "no such party waiting");
        await emitEvent(c, {
          venueId,
          type: "waitlist.updated",
          entityId: request.params.w,
          entityVersion: 0,
        });
        return { entry: await waitlistEntry(c, venueId, request.params.w) };
      });
    },
  );

  app.post<{ Params: { venueId: string; w: string } }>(
    "/v1/venues/:venueId/waitlist/:w/remove",
    { config: write },
    async (request) => {
      await request.inVenue((c) =>
        endEntry(c, request.venueId!, request.params.w, "left", options.clock.now()),
      );
      return { removed: true };
    },
  );

  app.post<{ Params: { venueId: string; w: string } }>(
    "/v1/venues/:venueId/waitlist/:w/text",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "guest_texts",
        action: "texts.send",
      }),
    },
    async (request) => {
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const entry = await waitlistEntry(c, venueId, request.params.w);
        if (!entry) throw new ApiError("not_found", "no such party on the waitlist");
        if (!entry.phone_e164) throw new ApiError("invalid_request", "this party left no number");
        return {
          conversation_id: await conversationFor(c, venueId, {
            phoneE164: entry.phone_e164,
            guestId: entry.guest_id,
            contextKind: "waitlist",
            contextId: entry.id,
          }),
        };
      });
    },
  );

  // The door QR and the guest's own link.
  const publicRoute = route({ principals: ["public"], module: "waitlist", idempotency: "none" });
  const tokenRoute = route({
    principals: ["public"],
    module: "waitlist",
    idempotency: "none",
    tokenRoute: true,
  });

  app.post<{ Params: { slug: string }; Body: unknown }>(
    "/v1/public/venues/:slug/waitlist",
    { config: publicRoute },
    async (request, reply) => {
      const parsed = doorBody.safeParse(request.body);
      if (!parsed.success) throw bad();
      const venueId = await resolveVenueSlug(options.pool, request.params.slug);
      if (!venueId) throw new ApiError("not_found", "no such venue");
      const now = options.clock.now();
      const result = await withVenue(
        options.pool,
        { venueId, requestId: request.requestId },
        async (c) => {
          const { entryId, token } = await joinWaitlist(c, venueId, {
            name: parsed.data.name,
            phone: parsed.data.phone,
            partySize: parsed.data.party_size,
            quotedMin: null,
            source: "door",
            now,
          });
          return { token: token!, spot: await guestView(c, venueId, entryId, now) };
        },
      );
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send(result);
    },
  );

  const byToken = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token))
      throw new ApiError("not_found", "no such waitlist spot");
    const found = await resolveWaitlistToken(
      options.pool,
      hashToken(token),
      options.clock.now().toString(),
    );
    if (!found) throw new ApiError("not_found", "no such waitlist spot");
    return found;
  };

  app.get<{ Params: { token: string } }>(
    "/v1/public/waitlist/:token",
    { config: tokenRoute },
    async (request) => {
      const { venueId, entryId } = await byToken(request.params.token);
      return {
        spot: await withVenue(options.pool, { venueId, requestId: request.requestId }, (c) =>
          guestView(c, venueId, entryId, options.clock.now()),
        ),
      };
    },
  );

  app.patch<{ Params: { token: string }; Body: unknown }>(
    "/v1/public/waitlist/:token",
    { config: tokenRoute },
    async (request) => {
      const parsed = z
        .object({ action: z.enum(["leave", "decline"]) })
        .strict()
        .safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { action: 'leave' | 'decline' }");
      const { venueId, entryId } = await byToken(request.params.token);
      const now = options.clock.now();
      return {
        spot: await withVenue(
          options.pool,
          { venueId, requestId: request.requestId },
          async (c) => {
            await endEntry(
              c,
              venueId,
              entryId,
              parsed.data.action === "leave" ? "left" : "declined",
              now,
            );
            return guestView(c, venueId, entryId, now);
          },
        ),
      };
    },
  );
}
