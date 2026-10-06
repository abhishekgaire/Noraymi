import type { FastifyInstance } from "fastify";
import {
  ROUTER_MAKERS,
  recordFailoverTest,
  routerFailoverTests,
  setRouterLink,
  venueRouters,
  type RouterMaker,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { failoverDue } from "../router/failover.js";

/**
 * The router's device page in Admin → Printers & devices (M8-02; spec 09 ·
 * Router; AdminDesk note 9):
 *   GET  /v1/venues/{v}/routers                      each router: backup internet, how it's read, failover tests
 *   PUT  /v1/venues/{v}/routers/{d}/link             the maker's API (ids, on or off) and the fallback's network owners
 *   POST /v1/venues/{v}/routers/{d}/failover-tests   keep a failover test's result
 */
type VenueParams = { venueId: string };

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s ? s : null));

const linkBody = z
  .object({
    maker: z.enum(ROUTER_MAKERS as [RouterMaker, ...RouterMaker[]]).nullable(),
    maker_org_id: text(100),
    maker_device_id: text(100),
    api_on: z.boolean(),
    wired_owner: text(100),
    lte_owner: text(100),
  })
  .strict();

const failoverBody = z
  .object({
    passed: z.boolean(),
    switch_seconds: z.number().int().min(0).max(86_400).nullable().optional(),
  })
  .strict();

const invalid = (error: z.ZodError) =>
  new ApiError(
    "invalid_request",
    error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  );

export function routerRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({ principals: ["owner_manager"], module: "core", action: "admin.access" });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    idempotency: "optional",
  });

  app.get<{ Params: VenueParams }>("/v1/venues/:venueId/routers", { config: read }, (request) =>
    request.inVenue(async (c) => {
      const venueId = request.venueId!;
      const v = await venueClock(c, venueId);
      const today = businessDate(options.clock.now(), v.timeZone, v.dayCutover).businessDate;
      const routers = await venueRouters(c, venueId);
      const out = [];
      // One client: one query at a time.
      for (const r of routers) {
        const tests = await routerFailoverTests(c, venueId, r.id);
        const backup = r.network?.["cellular_backup"];
        const source = r.network?.["source"];
        out.push({
          id: r.id,
          name: r.name,
          online: r.online,
          last_seen_at: r.last_seen_at,
          backup_internet: backup === true ? "on" : backup === false ? "off" : null,
          on_backup_now: r.network?.["on_backup_now"] === true,
          source: source === "maker_api" || source === "public_ip" ? source : null,
          link: r.link,
          failover: { ...failoverDue(tests[0]?.tested_on ?? null, today), tests },
        });
      }
      return { routers: out };
    }),
  );

  app.put<{ Params: VenueParams & { d: string }; Body: unknown }>(
    "/v1/venues/:venueId/routers/:d/link",
    { config: write },
    async (request) => {
      const parsed = linkBody.safeParse(request.body);
      if (!parsed.success) throw invalid(parsed.error);
      const link = await request.inVenue((c) =>
        setRouterLink(c, request.venueId!, request.params.d, parsed.data),
      );
      if (!link) throw new ApiError("not_found", "no such router");
      return { link };
    },
  );

  app.post<{ Params: VenueParams & { d: string }; Body: unknown }>(
    "/v1/venues/:venueId/routers/:d/failover-tests",
    { config: write },
    async (request) => {
      const parsed = failoverBody.safeParse(request.body);
      if (!parsed.success) throw invalid(parsed.error);
      const p = request.principal;
      const test = await request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const now = options.clock.now();
        const v = await venueClock(c, venueId);
        return recordFailoverTest(c, {
          venueId,
          deviceId: request.params.d,
          testedAt: new Date(now.epochMilliseconds),
          testedOn: businessDate(now, v.timeZone, v.dayCutover).businessDate.toString(),
          passed: parsed.data.passed,
          switchSeconds: parsed.data.switch_seconds ?? null,
          recordedBy: p.kind === "user" ? p.userId : null,
        });
      });
      if (!test) throw new ApiError("not_found", "no such router");
      return { test };
    },
  );
}
