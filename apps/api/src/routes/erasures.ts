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
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    idempotency: "optional",
  });

  const erase = async (
    request: FastifyRequest,
    subject: ErasureSubject,
    subjectId: string,
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

  app.post<{ Params: { venueId: string; guestId: string } }>(
    "/v1/venues/:venueId/guests/:guestId/erase",
    { config: write },
    async (request) => {
      if (!/^[0-9a-f-]{36}$/i.test(request.params.guestId))
        throw new ApiError("not_found", "no such guest");
      return { erasure: view(await erase(request, "guest", request.params.guestId)) };
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
