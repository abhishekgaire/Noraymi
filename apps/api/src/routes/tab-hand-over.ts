import type { FastifyInstance } from "fastify";
import { emitEvent } from "@west4/db";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * Hand a bar tab over at clock-out (M7-11; spec 08 · Bar tabs `/hand-over`;
 * spec 10 · Shifts): `POST /v1/venues/{v}/tabs/{t}/hand-over { to }` gives an
 * open tab to someone still on the clock. Its owner (or an owner or manager)
 * hands it over; the drinks the owner rang and hasn't sent go with it, to the
 * person taking it, and are never sent by themselves.
 */
const body = z.object({ to: z.string().uuid() }).strict();

export function tabHandOverRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.post<{ Params: { venueId: string; t: string }; Body: unknown }>(
    "/v1/venues/:venueId/tabs/:t/hand-over",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.t).success)
        throw new ApiError("not_found", "no such tab");
      const parsed = body.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { to }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "a person hands a tab over");
      const m = p.memberships.find((x) => x.venueId === request.venueId);
      if (!m) throw new ApiError("forbidden", "not at this venue");
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const tab = (
          await c.query<{ owner_id: string | null; check_id: string; state: string; name: string }>(
            "select owner_id, check_id, state, name from tabs where venue_id = $1 and id = $2 for update",
            [venueId, request.params.t],
          )
        ).rows[0];
        if (!tab) throw new ApiError("not_found", "no such tab");
        if (tab.state !== "open")
          throw new ApiError("version_conflict", `this tab is ${tab.state}`);
        if (tab.owner_id !== p.userId && m.role !== "owner" && m.role !== "manager")
          throw new ApiError("forbidden", "only the tab's owner or a manager hands it over");
        if (parsed.data.to === tab.owner_id)
          throw new ApiError("invalid_request", "hand it to someone else");
        // Someone still on the clock.
        const to = (
          await c.query<{ membership_id: string; name: string }>(
            `select m.id as membership_id, u.name from memberships m join users u on u.id = m.user_id
               join shifts s on s.venue_id = m.venue_id and s.membership_id = m.id and s.ended_at is null
              where m.venue_id = $1 and m.user_id = $2 and m.status = 'active'`,
            [venueId, parsed.data.to],
          )
        ).rows[0];
        if (!to)
          throw new ApiError("invalid_request", "hand it to someone who's still on the clock", {
            details: { reason: "not_on_clock" },
          });
        await c.query("update tabs set owner_id = $3 where venue_id = $1 and id = $2", [
          venueId,
          request.params.t,
          parsed.data.to,
        ]);
        // The owner's unsent drinks on it go with it: added to the new owner's own, or as theirs.
        const from = tab.owner_id
          ? (
              await c.query<{ id: string; lines: unknown[] }>(
                `select d.id, d.lines from order_drafts d join memberships m on m.venue_id = d.venue_id and m.id = d.membership_id
                  where d.venue_id = $1 and m.user_id = $2 and d.check_id = $3 and jsonb_array_length(d.lines) > 0`,
                [venueId, tab.owner_id, tab.check_id],
              )
            ).rows[0]
          : undefined;
        let moved = 0;
        if (from) {
          moved = from.lines.length;
          const theirs = await c.query<{ id: string }>(
            "select id from order_drafts where venue_id = $1 and membership_id = $2 and check_id = $3 for update",
            [venueId, to.membership_id, tab.check_id],
          );
          if (theirs.rows[0])
            await c.query(
              `update order_drafts set lines = lines || $3::jsonb, version = version + 1, updated_at = $4
                where venue_id = $1 and id = $2`,
              [
                venueId,
                theirs.rows[0].id,
                JSON.stringify(from.lines),
                options.clock.now().toString(),
              ],
            );
          else
            await c.query(
              `insert into order_drafts (venue_id, membership_id, check_id, lines, updated_at) values ($1, $2, $3, $4, $5)`,
              [
                venueId,
                to.membership_id,
                tab.check_id,
                JSON.stringify(from.lines),
                options.clock.now().toString(),
              ],
            );
          await c.query(
            "update order_drafts set lines = '[]', version = version + 1, updated_at = $3 where venue_id = $1 and id = $2",
            [venueId, from.id, options.clock.now().toString()],
          );
        }
        await emitEvent(c, { venueId, type: "tab.updated", entityId: request.params.t });
        return {
          tab_id: request.params.t,
          owner: { user_id: parsed.data.to, name: to.name },
          drinks_moved: moved,
        };
      });
    },
  );
}
