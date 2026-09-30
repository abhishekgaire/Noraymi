import { randomUUID } from "node:crypto";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Queryable, RequestContext } from "@west4/db";
import { formatInZone, type Clock } from "@west4/shared";
import { ApiError } from "./errors.js";
import {
  claimKey,
  finishKey,
  idempotencyKeyOf,
  PLATFORM_VENUE,
  replay,
  requestHash,
} from "./idempotency.js";
import { ANONYMOUS, principalId, principalIs, type Principal } from "./principal.js";
import { installRegistry, type RegisteredRoute, type RouteSpec } from "./registry.js";
import type { ModuleGate } from "./module-gate.js";
import type { PermissionGate } from "./permission-gate.js";
import { isAction } from "@west4/shared";

export type Authenticator = (request: FastifyRequest) => Promise<Principal | undefined>;

export interface ConventionsOptions {
  readonly clock: Clock;
  readonly timeZone: string;
  readonly minClientVersion: string;
  /** Each one may set the principal; the first that answers wins. Later tickets add theirs. */
  readonly authenticators?: readonly Authenticator[];
  /** Per venue on staff routes; the default is 600 a minute. */
  readonly staffRateLimit?: { max: number; windowMs: number };
  /** Whether the database is wired (tests of pure conventions may leave it out). */
  readonly db: boolean;
  /** The module gate; absent without a database. */
  readonly moduleGate?: ModuleGate;
  /** The role guard; absent without a database. */
  readonly permissionGate?: PermissionGate;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
    requestId: string;
    /** The venue from /v1/venues/:venueId, once the membership check passed. */
    venueId: string | undefined;
    /** The request's venue transaction: sets app.venue_id, app.user_id and app.request_id. */
    inVenue<T>(work: (client: Queryable) => Promise<T>): Promise<T>;
  }
  interface FastifyInstance {
    routes: RegisteredRoute[];
  }
}

/**
 * The API conventions (spec 08): the route registry, principals and 403,
 * the venue scope, the error shape, server_time and min_client_version on
 * every response, idempotency keys, rate limits and token-route headers.
 */
export const conventionsPlugin = fp(async (app: FastifyInstance, options: ConventionsOptions) => {
  const { routes } = installRegistry(app);
  app.decorate("routes", routes);
  // Fastify refuses object defaults on request decorators; the onRequest hook sets these on every request.
  (app.decorateRequest as (name: string, value: unknown) => void)("principal", null);
  app.decorateRequest("requestId", "");
  app.decorateRequest("forbidden", false);
  app.decorateRequest("venueId", undefined);
  (app.decorateRequest as (name: string, value: unknown) => void)("inVenue", null);

  // Staff routes get the per-venue rate limit unless the route turns it off.
  app.addHook("onRoute", (route) => {
    const spec = route.config?.route;
    if (!spec || spec.rateLimit === false) return;
    const staffRoute = spec.principals.some(
      (p) => p === "staff" || p === "owner_manager" || p === "shared_device",
    );
    if (!staffRoute && !spec.rateLimit) return;
    const limit = spec.rateLimit || options.staffRateLimit || { max: 600, windowMs: 60_000 };
    route.config = { ...route.config, rateLimit: { max: limit.max, timeWindow: limit.windowMs } };
  });

  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => request.venueId ?? request.ip,
  });

  // Every response: server_time and min_client_version, as headers and, on
  // JSON objects, as fields too (spec 08 · Money and time, Clients).
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Server-Time", formatInZone(options.clock.now(), options.timeZone));
    reply.header("X-Min-Client-Version", options.minClientVersion);
    reply.header("X-Request-Id", request.requestId);
    return payload;
  });
  app.addHook("preSerialization", async (_request, _reply, payload) => {
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      return {
        ...(payload as Record<string, unknown>),
        server_time: formatInZone(options.clock.now(), options.timeZone),
        min_client_version: options.minClientVersion,
      };
    }
    return payload;
  });

  // Who is calling, and may they call this route?
  app.addHook("onRequest", async (request, reply) => {
    request.requestId = randomUUID();
    request.principal = ANONYMOUS;
    for (const authenticate of options.authenticators ?? []) {
      const principal = await authenticate(request);
      if (principal) {
        request.principal = principal;
        break;
      }
    }
    const spec = specOf(request);
    if (!spec) return; // the 404 handler
    const params = request.params as { venueId?: string };
    const venueId = params.venueId;
    if (!spec.principals.some((name) => principalIs(request.principal, name, venueId))) {
      if (spec.websocket) {
        request.forbidden = true; // the socket handler closes with 4403
      } else {
        throw new ApiError("forbidden", "you can't call this");
      }
    }
    request.venueId = venueId;
    if (spec.tokenRoute) {
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("Cache-Control", "no-store");
    }
    const context: RequestContext = {
      venueId: venueId ?? PLATFORM_VENUE,
      userId: request.principal.kind === "user" ? request.principal.userId : undefined,
      requestId: request.requestId,
    };
    request.inVenue = (work) => {
      if (!options.db) throw new Error("no database in this app");
      return app.db.withVenue(context, work);
    };

    // Before every write, the caller's role is checked against role_permissions for the route's action (M1-14).
    const isWrite =
      request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
    if (
      isWrite &&
      venueId !== undefined &&
      spec.action !== undefined &&
      request.principal.kind === "user" &&
      options.permissionGate
    ) {
      if (!isAction(spec.action))
        throw new Error(
          `route ${request.method} ${request.routeOptions.url} declares an unknown action ${spec.action}`,
        );
      const membership = request.principal.memberships.find((m) => m.venueId === venueId);
      if (
        !membership ||
        !(await options.permissionGate.allows(venueId, membership.role, spec.action))
      ) {
        throw new ApiError("forbidden", "your role can't do this");
      }
    }

    // Every route of a module that's off answers 404 module_off (M1-13).
    if (venueId !== undefined && options.moduleGate && !spec.exemptWhenOff) {
      if (await options.moduleGate.blocks(venueId, spec.module, spec.createsNewWork === true)) {
        if (spec.websocket) {
          request.forbidden = true;
        } else {
          throw new ApiError("module_off", "this part of the system is off at this venue");
        }
      }
    }
  });

  // Idempotency-Key on POST and PATCH: claim before the work, store the answer after.
  app.addHook("preHandler", async (request, reply) => {
    const spec = specOf(request);
    if (
      !spec ||
      (request.method !== "POST" && request.method !== "PATCH") ||
      spec.idempotency === "none"
    )
      return;
    const key = idempotencyKeyOf(request);
    if (key === undefined) {
      if (spec.idempotency === "required")
        throw new ApiError("invalid_request", "Idempotency-Key is required on this route");
      return;
    }
    const outcome = await request.inVenue((c) =>
      claimKey(c, {
        venueId: request.venueId ?? PLATFORM_VENUE,
        principalId: principalId(request.principal),
        key,
        route: `${request.method} ${request.routeOptions.url ?? request.url}`,
        hash: requestHash(request),
      }),
    );
    if (outcome.kind === "replay") return replay(reply, outcome.response);
    request.idempotencyId = outcome.id;
  });
  app.decorateRequest("idempotencyId", undefined);
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.idempotencyId === undefined) return payload;
    const id = request.idempotencyId;
    request.idempotencyId = undefined;
    const ok = reply.statusCode < 500;
    const body = typeof payload === "string" ? safeJson(payload) : payload;
    await request.inVenue((c) => finishKey(c, id, ok ? { status: reply.statusCode, body } : null));
    return payload;
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send(error.toBody());
    const status = (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : String(error);
    if (status === 429) {
      return reply
        .code(429)
        .send(new ApiError("rate_limited", "too many requests for this venue; slow down").toBody());
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send(new ApiError("invalid_request", message, { status }).toBody());
    }
    request.log.error(error);
    return reply
      .code(500)
      .send(
        new ApiError("internal", "something went wrong on our side; it's safe to retry").toBody(),
      );
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(new ApiError("not_found", "no such route").toBody()),
  );
});

declare module "fastify" {
  interface FastifyRequest {
    idempotencyId: string | undefined;
    forbidden: boolean;
  }
}

function specOf(request: FastifyRequest): RouteSpec | undefined {
  return request.routeOptions.config?.route;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Sugar for a route's registry entry: app.get(url, { config: route({...}) }, handler). */
export function route(spec: RouteSpec): { route: RouteSpec } {
  return { route: spec };
}

export type { FastifyReply };
