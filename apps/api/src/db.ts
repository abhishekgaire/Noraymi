import pg from "pg";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { withOrgScope, withVenue, type RequestContext } from "@west4/db";

declare module "fastify" {
  interface FastifyInstance {
    db: {
      readonly pool: pg.Pool;
      /** A report's read (M8-21): on the replica when there is one, else the primary. */
      withReports<T>(context: RequestContext, work: Parameters<typeof withVenue<T>>[2]): Promise<T>;
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
export const dbPlugin = fp(
  async (
    app: FastifyInstance,
    options: { databaseUrl: string; reportsDatabaseUrl?: string | null | undefined },
  ) => {
    const pool = new pg.Pool({
      connectionString: options.databaseUrl,
      max: 10,
      application_name: "west4-api",
    });
    // Reports on the read replica (spec 13 · Capacity), a few connections of their own, so a heavy
    // report never takes the connections orders and the alarm need.
    const reports = options.reportsDatabaseUrl
      ? new pg.Pool({
          connectionString: options.reportsDatabaseUrl,
          max: 4,
          application_name: "west4-api-reports",
        })
      : null;
    app.decorate("db", {
      pool,
      withVenue: (context, work) => withVenue(pool, context, work),
      withReports: (context, work) => withVenue(reports ?? pool, context, work),
      withOrgScope: (context, work) => withOrgScope(pool, context, work),
    });
    app.addHook("onClose", async () => {
      await pool.end();
      await reports?.end();
    });
  },
);
