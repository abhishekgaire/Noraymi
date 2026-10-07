import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  decideSupportGrant,
  reprintJob,
  revokeSupportGrant,
  SupportGrantClosed,
  supportGrant,
  supportGrantState,
  supportGrants,
  supportSnapshot,
  withSupport,
  withSupportAction,
  type SupportGrantRow,
} from "@west4/db";
import { isSupportAction, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * Support access (M8-10; spec 02 · Support access; spec 08 · Support access;
 * screens N39). The venue's side, the owner alone in a passkey session (the
 * spec's API table also names a manager; the ticket, spec 02 and Console note
 * 3 say owner only):
 *   GET  /v1/venues/{v}/support-grants                 waiting, open and past grants
 *   POST /v1/venues/{v}/support-grants/{g}/approve     opens it now, for its minutes
 *   POST /v1/venues/{v}/support-grants/{g}/decline
 *   POST /v1/venues/{v}/support-grants/{g}/revoke      ends it at once ("End now")
 * The support session's side, as the support principal (a Console session
 * carrying an open grant):
 *   GET  /v1/venues/{v}/support/view                   the masked views, in a read-only transaction
 *   POST /v1/venues/{v}/support/actions/{action}       a write grant's one named action, once
 */
export interface SupportGrantOut extends SupportGrantRow {
  readonly state: ReturnType<typeof supportGrantState>;
  readonly seconds_left: number | null;
}

export function grantOut(g: SupportGrantRow, atMs: number): SupportGrantOut {
  const state = supportGrantState(g, atMs);
  const ends = g.ends_at ? Date.parse(g.ends_at) : null;
  return {
    ...g,
    state,
    seconds_left:
      state === "open" && ends !== null ? Math.max(0, Math.ceil((ends - atMs) / 1000)) : null,
  };
}

function ownerOnly(request: FastifyRequest): { venueId: string; userId: string } {
  const venueId = request.venueId!;
  const p = request.principal;
  const here = p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId) : undefined;
  if (p.kind !== "user" || here?.role !== "owner")
    throw new ApiError("forbidden", "Console is the owner's section");
  return { venueId, userId: p.userId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function supportGrantRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock },
): void {
  const owner = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.console",
    assurance: "passkey",
  });
  const ownerWrite = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.console",
    assurance: "passkey",
    idempotency: "optional",
  });
  const support = route({ principals: ["support"], module: "core" });
  const supportWrite = route({ principals: ["support"], module: "core", idempotency: "optional" });
  const nowMs = () => options.clock.now().epochMilliseconds;

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/support-grants",
    { config: owner },
    async (request) => {
      const { venueId } = ownerOnly(request);
      const rows = await request.inVenue((c) => supportGrants(c, venueId));
      const at = nowMs();
      return { support_grants: rows.map((g) => grantOut(g, at)) };
    },
  );

  for (const verb of ["approve", "decline", "revoke"] as const) {
    app.post<{ Params: { venueId: string; grantId: string } }>(
      `/v1/venues/:venueId/support-grants/:grantId/${verb}`,
      { config: ownerWrite },
      async (request) => {
        const { venueId, userId } = ownerOnly(request);
        const id = request.params.grantId;
        if (!UUID.test(id)) throw new ApiError("not_found", "no such support grant");
        const at = options.clock.now().toString();
        const out = await request.inVenue(async (c) => {
          const before = await supportGrant(c, venueId, id);
          if (!before) throw new ApiError("not_found", "no such support grant");
          const after =
            verb === "revoke"
              ? await revokeSupportGrant(c, { venueId, id, by: userId, side: "venue", at })
              : await decideSupportGrant(c, { venueId, id, decision: verb, userId, at });
          if (!after)
            throw new ApiError(
              "version_conflict",
              verb === "revoke"
                ? "this grant has already ended"
                : "this request was already answered",
              { details: { state: supportGrantState(before, nowMs()) } },
            );
          return after;
        });
        return { support_grant: grantOut(out, nowMs()) };
      },
    );
  }

  const supportOf = (request: FastifyRequest) => {
    const p = request.principal;
    if (p.kind !== "support" || p.venueId !== request.venueId)
      throw new ApiError("forbidden", "you can't call this");
    return {
      venueId: p.venueId,
      staffId: p.staffId,
      grantId: p.grantId,
      requestId: request.requestId,
      at: options.clock.now().toString(),
    };
  };
  const closed = (e: unknown): never => {
    if (e instanceof SupportGrantClosed)
      throw new ApiError("forbidden", "the support grant isn't open, or its action was used");
    throw e;
  };

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/support/view",
    { config: support },
    async (request) => {
      const ctx = supportOf(request);
      return withSupport(options.pool, ctx, (c) => supportSnapshot(c)).catch(closed);
    },
  );

  app.post<{ Params: { venueId: string; action: string }; Body: { job_id?: unknown } }>(
    "/v1/venues/:venueId/support/actions/:action",
    { config: supportWrite },
    async (request) => {
      const ctx = supportOf(request);
      const action = request.params.action;
      if (!isSupportAction(action))
        throw new ApiError("not_found", `no support action "${action}"`);
      const jobId = request.body?.job_id;
      if (typeof jobId !== "string" || !UUID.test(jobId))
        throw new ApiError("invalid_request", "send { job_id }");
      const done = await withSupportAction(options.pool, { ...ctx, action }, async (c) => {
        const job = await reprintJob(c, ctx.venueId, jobId, ctx.at);
        if (!job) throw new ApiError("not_found", "no such print job");
        return job;
      }).catch(closed);
      return { action, print_job: done };
    },
  );
}
