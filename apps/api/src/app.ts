import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { StoredClock } from "@west4/db";
import { Temporal, formatInZone, systemClock, type Clock } from "@west4/shared";
import { dbPlugin } from "./db.js";
import type { Config } from "./config.js";

export interface AppOptions {
  readonly logger?: boolean;
  readonly config?: Config;
  /** Tests pass a clock; otherwise it follows the config. */
  readonly clock?: Clock;
}

/** server_time is shown in New York time, the platform's home zone (spec conventions · Time zone). */
export const PLATFORM_TIME_ZONE = "America/New_York";

/** Build the API without listening, so tests can inject requests. */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
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

  // Operations route (M1-02): no venue data.
  app.get("/v1/health", async () => ({
    ok: true,
    server_time: formatInZone(clock.now(), PLATFORM_TIME_ZONE),
  }));

  // Staging-only control that moves the simulated clock (M1-06). It doesn't
  // exist anywhere else: production answers 404 like any unknown route.
  if (config?.allowStagingFeatures && clock instanceof StoredClock) {
    const stored = clock;
    app.post<{ Body: { server_time?: string | null } }>("/v1/ops/clock", async (request, reply) => {
      const body = request.body ?? {};
      const at =
        body.server_time === null || body.server_time === undefined
          ? null
          : Temporal.Instant.from(body.server_time);
      await stored.set(at, "ops");
      return reply
        .code(200)
        .send({ ok: true, server_time: formatInZone(stored.now(), PLATFORM_TIME_ZONE) });
    });
  }

  return app;
}
