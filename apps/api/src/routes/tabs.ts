import type { FastifyInstance } from "fastify";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { listTabs } from "../tabs/tabs.js";
import { repeatRound } from "../tabs/repeat.js";

/**
 * Bar tabs (M6-02; API · Bar tabs):
 *   GET /v1/venues/{v}/tabs?state=   open tabs in the order opened and tonight's closed ones;
 *                                    ?state=awaiting_tip (and other states, comma-separated) filters
 *   POST /v1/venues/{v}/tabs/{t}/repeat-round   the last round into the caller's unsent drinks (M6-03)
 * Opening, closing and the rest of the tab routes come with M6-06 onwards.
 */
const STATES =
  /^(open|tipping|awaiting_tip|captured|walkout_captured|capture_failed|closed)(,(open|tipping|awaiting_tip|captured|walkout_captured|capture_failed|closed))*$/;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tabRoutes(app: FastifyInstance, options: { clock: Clock }): void {
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
}
