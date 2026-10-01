import type { FastifyInstance } from "fastify";
import { rulePackVersions } from "@west4/db";
import { businessDate } from "@west4/rules";
import { rulePackChanges, Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * `GET /v1/venues/{v}/rule-pack` (M1-36; spec 12 · 11): the version the venue
 * runs on tonight and, when one is published for a later business date, the
 * next one with what it changes and when. Admin shows it before it applies;
 * the version itself takes over at the first business-date boundary on or
 * after `effective_on` (M1-10).
 */
export function rulePackRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/rule-pack",
    { config: route({ principals: ["owner_manager"], module: "core", action: "admin.access" }) },
    async (request) => {
      const venue = await request.inVenue(async (c) => {
        const r = await c.query<{
          time_zone: string;
          day_cutover: string;
          rule_pack_id: string | null;
        }>(
          "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover, rule_pack_id from venues where id = $1",
          [request.venueId],
        );
        if (!r.rows[0]) throw new ApiError("not_found", "no such venue");
        return r.rows[0];
      });
      const packId = venue.rule_pack_id ?? "us-ny-new-york-county";
      const today = businessDate(
        options.clock.now(),
        venue.time_zone,
        venue.day_cutover,
      ).businessDate;
      const versions = await request.inVenue((c) => rulePackVersions(c, packId));
      const current = [...versions]
        .filter((v) => Temporal.PlainDate.compare(v.effectiveOn, today) <= 0)
        .sort((a, b) => Temporal.PlainDate.compare(b.effectiveOn, a.effectiveOn))[0];
      const next = versions
        .filter((v) => Temporal.PlainDate.compare(v.effectiveOn, today) > 0)
        .sort((a, b) => Temporal.PlainDate.compare(a.effectiveOn, b.effectiveOn))[0];
      return {
        pack_id: packId,
        business_date: today.toString(),
        current: current ? { version: current.version, effective_on: current.effectiveOn } : null,
        next: next
          ? {
              version: next.version,
              effective_on: next.effectiveOn,
              changes: current ? rulePackChanges(current.pack, next.pack) : [],
            }
          : null,
      };
    },
  );
}
