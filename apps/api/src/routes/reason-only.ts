import type { FastifyInstance } from "fastify";
import { readSetting, reasonOnlyUsed } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * `GET /v1/venues/{v}/reason-only?membership_id=` (M2-14): what a person has
 * used of the reason-only limit tonight and what's left ("$50 left this
 * shift"). Staff read their own; owners and managers can read anyone's.
 */
export function reasonOnlyRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string }; Querystring: { membership_id?: string } }>(
    "/v1/venues/:venueId/reason-only",
    { config: route({ principals: ["owner_manager", "staff"], module: "core" }) },
    async (request) => {
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "the limit is a person's");
      const venueId = request.venueId!;
      const me = p.memberships.find((m) => m.venueId === venueId)!;
      const asked = request.query.membership_id ?? me.membershipId;
      if (asked !== me.membershipId && me.role !== "owner" && me.role !== "manager")
        throw new ApiError("forbidden", "you can read only your own");
      return request.inVenue(async (c) => {
        const member = (
          await c.query<{ user_id: string }>(
            "select user_id from memberships where venue_id = $1 and id = $2",
            [venueId, asked],
          )
        ).rows[0];
        if (!member) throw new ApiError("not_found", "no such person at this venue");
        const venue = await venueClock(c, venueId);
        const date = businessDate(
          options.clock.now(),
          venue.timeZone,
          venue.dayCutover,
        ).businessDate;
        const pos = await readSetting(c, venueId, "pos", date);
        const limits = pos?.value.reasonOnly ?? { eachCents: 0, perShiftCents: 0 };
        const used = await reasonOnlyUsed(c, venueId, member.user_id, date.toString());
        return {
          membership_id: asked,
          business_date: date.toString(),
          used_cents: used,
          each_cents: limits.eachCents,
          per_shift_cents: limits.perShiftCents,
          left_cents: Math.max(0, limits.perShiftCents - used),
        };
      });
    },
  );
}
