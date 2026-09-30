import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { StoredClock } from "@west4/db";
import { Temporal, formatInZone, systemClock, type Clock } from "@west4/shared";
import { dbPlugin } from "./db.js";
import type { Config } from "./config.js";
import { conventionsPlugin, route, type Authenticator } from "./http/conventions.js";
import { eventsPlugin } from "./http/events.js";
import { settingsRoutes } from "./routes/settings.js";
import { closuresRoutes } from "./routes/closures.js";

export interface AppOptions {
  readonly logger?: boolean;
  readonly config?: Config;
  /** Tests pass a clock; otherwise it follows the config. */
  readonly clock?: Clock;
  readonly authenticators?: readonly Authenticator[];
  readonly staffRateLimit?: { max: number; windowMs: number };
  /** The relay's and the tail's poll interval; tests use a short one. */
  readonly eventsPollMs?: number;
  readonly drainMs?: number;
  /** Tests add fixture routes here, inside the routes plugin's scope. */
  readonly extraRoutes?: (app: FastifyInstance) => Promise<void> | void;
}

/** server_time is shown in New York time, the platform's home zone (spec conventions · Time zone). */
export const PLATFORM_TIME_ZONE = "America/New_York";

/** Build the API without listening, so tests can inject requests. */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  // forceCloseConnections: the events plugin drains WebSockets slowly first;
  // whatever is left (for example a refused upgrade) is cut so close() returns.
  const app = Fastify({ logger: options.logger ?? false, forceCloseConnections: true });
  const config = options.config;
  let clock: Clock = options.clock ?? systemClock;

  if (config) {
    void app.register(dbPlugin, { databaseUrl: config.databaseUrl });
    if (!options.clock && config.allowStagingFeatures) {
      const stored = new StoredClock(new pg.Pool({ connectionString: config.databaseUrl, max: 2 }));
      clock = stored;
      app.addHook("onRequest", async () => {
        await stored.refresh();
      });
    }
  }

  void app.register(conventionsPlugin, {
    clock,
    timeZone: PLATFORM_TIME_ZONE,
    minClientVersion: process.env["MIN_CLIENT_VERSION"] ?? "0.0.0",
    ...(options.authenticators ? { authenticators: options.authenticators } : {}),
    ...(options.staffRateLimit ? { staffRateLimit: options.staffRateLimit } : {}),
    db: config !== undefined,
  });

  // Live events need the database (M1-09).
  if (config) {
    void app.register(eventsPlugin, {
      clock,
      timeZone: PLATFORM_TIME_ZONE,
      ...(options.eventsPollMs !== undefined ? { pollMs: options.eventsPollMs } : {}),
      ...(options.drainMs !== undefined ? { drainMs: options.drainMs } : {}),
    });
  }

  // Every route is added after the conventions plugin, so its registry sees them all.
  void app.register(async (scope) => {
    // Operations route (M1-02): no venue data.
    scope.get(
      "/v1/health",
      { config: route({ principals: ["public"], module: "core", rateLimit: false }) },
      async () => ({ ok: true, server_time: formatInZone(clock.now(), PLATFORM_TIME_ZONE) }),
    );

    // Staging-only control that moves the simulated clock (M1-06). It doesn't
    // exist anywhere else: production answers 404 like any unknown route.
    if (config?.allowStagingFeatures && clock instanceof StoredClock) {
      const stored = clock;
      scope.post<{ Body: { server_time?: string | null } }>(
        "/v1/ops/clock",
        { config: route({ principals: ["public"], module: "core", idempotency: "none" }) },
        async (request, reply) => {
          const body = request.body ?? {};
          const at =
            body.server_time === null || body.server_time === undefined
              ? null
              : Temporal.Instant.from(body.server_time);
          await stored.set(at, "ops");
          return reply
            .code(200)
            .send({ ok: true, server_time: formatInZone(stored.now(), PLATFORM_TIME_ZONE) });
        },
      );
    }

    if (config) {
      settingsRoutes(scope, { clock });
      closuresRoutes(scope, { clock });
    }
    await options.extraRoutes?.(scope);
  });

  return app;
}
