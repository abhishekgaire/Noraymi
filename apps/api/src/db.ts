import pg from "pg";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { withOrgScope, withVenue, type RequestContext } from "@west4/db";

declare module "fastify" {
  interface FastifyInstance {
    db: {
      readonly pool: pg.Pool;
      withVenue<T>(context: RequestContext, work: Parameters<typeof withVenue<T>>[2]): Promise<T>;
      withOrgScope<T>(
        context: { userId: string; requestId?: string },
        work: Parameters<typeof withOrgScope<T>>[2],
      ): Promise<T>;
    };
  }
}

/**
 * The API's database access: a pool connected as app_rw, and the request
 * wrapper that runs each request in one short, walled transaction. Routes
 * never touch the pool directly.
 */
export const dbPlugin = fp(async (app: FastifyInstance, options: { databaseUrl: string }) => {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
  app.decorate("db", {
    pool,
    withVenue: (context, work) => withVenue(pool, context, work),
    withOrgScope: (context, work) => withOrgScope(pool, context, work),
  });
  app.addHook("onClose", async () => {
    await pool.end();
  });
});
