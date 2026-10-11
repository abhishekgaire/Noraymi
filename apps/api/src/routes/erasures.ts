import { openWhileReadOnly } from "../http/plan-gate.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Clock } from "@west4/shared";
import {
  asRetention,
  enqueue,
  eraseGuest,
  eraseSinger,
  erasureOf,
  singerOwes,
  startErasure,
  type Erasure,
  type ErasureSubject,
  type Queryable,
} from "@west4/db";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { ERASE_KIND } from "../jobs/erase.js";

/**
 * Erasing a guest or a singer on request (M8-13; spec 12 · Erasing a guest;
 * spec 08 · Guests). Owners and managers, in a passkey session.
 *   POST /v1/venues/{v}/guests/{g}/erase    blank the guest's details and texts; the job detaches cards and redacts at Twilio
 *   POST /v1/venues/{v}/singers/{s}/erase   the same for a singer, once their tab owes nothing (409 balance_owed)
 *   GET  /v1/venues/{v}/guests?phone=|email= find the guest to erase by an exact phone or email (D104)
 * A guest with a booking still ahead is erased only with `confirm_upcoming: true` (409
 * upcoming_booking otherwise, with the count), since the booking then loses its contact details.
 * A second call answers with the same erasure. The erase itself runs as
 * app_retention, so its audit rows hold no values of the erased fields.
 */
const userOf = (request: FastifyRequest) =>
  request.principal.kind === "user" ? request.principal.userId : null;

const view = (e: Erasure) => ({
  id: e.id,
  subject: e.subject,
  subject_id: e.subject_id,
  state: e.state,
  requested_at: e.requested_at,
  done_at: e.done_at,
  held_messages: e.held_messages,
  removed: e.removed,
  pending_cards: e.pending.cards?.length ?? 0,
  pending_messages: e.pending.messages?.length ?? 0,
});

export function erasureRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  // Erasing on request stays open while Admin is read-only over our plan (M8-15).
  const write = openWhileReadOnly(
    route({
      principals: ["owner_manager"],
      module: "core",
      action: "admin.access",
      idempotency: "optional",
    }),
  );

  const erase = async (
    request: FastifyRequest,
    subject: ErasureSubject,
    subjectId: string,
    confirmUpcoming = false,
  ): Promise<Erasure> =>
    request.inVenue(async (c: Queryable) => {
      const venueId = request.venueId!;
      const table = subject === "guest" ? "guests" : "singers";
      const exists = await c.query(`select 1 from ${table} where venue_id = $1 and id = $2`, [
        venueId,
        subjectId,
      ]);
      if (exists.rowCount === 0) throw new ApiError("not_found", `no such ${subject}`);
      const before = await erasureOf(c, venueId, subject, subjectId);
      if (before) return before;
      if (subject === "guest" && !confirmUpcoming) {
        const ahead = await upcomingBookings(c, venueId, subjectId, options.clock.now().toString());
        if (ahead > 0)
          throw new ApiError(
            "upcoming_booking",
            "this guest has a booking still ahead; confirm to erase anyway",
            { details: { upcoming_bookings: ahead } },
          );
      }
      if (subject === "singer" && (await singerOwes(c, venueId, subjectId)))
        throw new ApiError(
          "balance_owed",
          "this singer's tab still owes money; erase once it's paid",
        );
      const now = options.clock.now();
      const erasureId = await startErasure(c, venueId, {
        subject,
        subjectId,
        requestedBy: userOf(request),
        now,
      });
      await enqueue(c, {
        venueId,
        kind: ERASE_KIND,
        pool: "normal",
        runAt: now,
        payload: { erasure_id: erasureId },
        dedupeKey: `erase:${erasureId}`,
      });
      await asRetention(c);
      if (subject === "guest") await eraseGuest(c, venueId, subjectId, erasureId, now);
      else await eraseSinger(c, venueId, subjectId, erasureId, now);
      await c.query("reset role");
      await c.query("reset statement_timeout");
      return (await erasureOf(c, venueId, subject, subjectId))!;
    });

  app.post<{
    Params: { venueId: string; guestId: string };
    Body: { confirm_upcoming?: boolean } | undefined;
  }>("/v1/venues/:venueId/guests/:guestId/erase", { config: write }, async (request) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.guestId))
      throw new ApiError("not_found", "no such guest");
    const confirm = request.body?.confirm_upcoming === true;
    return { erasure: view(await erase(request, "guest", request.params.guestId, confirm)) };
  });

  // Finding the guest to erase (D104): an exact phone (E.164, or ten US digits) or email, never a
  // partial search, so Admin can't browse the guest list. Erased guests aren't found.
  app.get<{ Params: { venueId: string }; Querystring: { phone?: string; email?: string } }>(
    "/v1/venues/:venueId/guests",
    {
      config: route({ principals: ["owner_manager"], module: "core", action: "admin.access" }),
    },
    async (request) => {
      const phone = normalPhone(request.query.phone);
      const email = request.query.email?.trim().toLowerCase() || null;
      if (!phone && !email)
        throw new ApiError("invalid_request", "send an exact phone (+1…) or email");
      return request.inVenue(async (c) => {
        const now = options.clock.now().toString();
        const found = await c.query<{
          id: string;
          name: string;
          phone_e164: string | null;
          email: string | null;
          last_seen_at: string | null;
        }>(
          `select id, name, phone_e164, email, last_seen_at from guests
            where venue_id = $1 and erased_at is null
              and (($2::text is not null and phone_e164 = $2) or ($3::text is not null and lower(email) = $3))
            order by created_at limit 10`,
          [request.venueId, phone, email],
        );
        const guests = [];
        for (const g of found.rows)
          guests.push({
            id: g.id,
            name: g.name,
            phone: g.phone_e164,
            email: g.email,
            last_seen_at: g.last_seen_at,
            upcoming_bookings: await upcomingBookings(c, request.venueId!, g.id, now),
          });
        return { guests };
      });
    },
  );

  app.post<{ Params: { venueId: string; s: string } }>(
    "/v1/venues/:venueId/singers/:s/erase",
    { config: write },
    async (request) => {
      if (!/^[0-9a-f-]{36}$/i.test(request.params.s))
        throw new ApiError("not_found", "no such singer");
      return { erasure: view(await erase(request, "singer", request.params.s)) };
    },
  );
}

/** "+12125550100", or ten US digits as +1…; null for anything else. */
function normalPhone(raw: string | undefined): string | null {
  const t = raw?.replace(/[\s().-]/g, "") ?? "";
  if (/^\+[1-9]\d{6,14}$/.test(t)) return t;
  if (/^\d{10}$/.test(t)) return `+1${t}`;
  if (/^1\d{10}$/.test(t)) return `+${t}`;
  return null;
}

/** The guest's bookings still ahead: pending, confirmed or checked in, and not yet ended. */
async function upcomingBookings(
  c: Queryable,
  venueId: string,
  guestId: string,
  now: string,
): Promise<number> {
  const r = await c.query<{ n: number }>(
    `select count(*)::int as n from bookings
      where venue_id = $1 and guest_id = $2 and status in ('pending', 'confirmed', 'checked_in')
        and ends_at > $3`,
    [venueId, guestId, now],
  );
  return r.rows[0]?.n ?? 0;
}
