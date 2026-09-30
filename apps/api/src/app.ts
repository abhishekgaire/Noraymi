import Fastify, { type FastifyInstance } from "fastify";
import { Temporal } from "@west4/shared";

export interface AppOptions {
  readonly logger?: boolean;
}

/** Build the API without listening, so tests can inject requests. */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // Operations route (M1-02 wires it to staging's post-deploy check). It
  // returns no venue data; the route registry and API conventions come in M1-08.
  app.get("/v1/health", async () => ({
    ok: true,
    server_time: Temporal.Now.instant().toString(),
  }));

  return app;
}
