import type pg from "pg";

/**
 * The request wrapper (spec 02 · The database walls): one short transaction
 * per request, with the venue, the user and the request id set first through
 * set_config(..., true), so they end with the transaction. Every query inside
 * runs behind the venue wall.
 */
export interface RequestContext {
  readonly venueId: string;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
}

export type Queryable = Pick<pg.PoolClient, "query">;

export async function withVenue<T>(
  pool: pg.Pool,
  context: RequestContext,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await setContext(client, context);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * An owner report: a read-only transaction marked app.scope = 'org', which
 * lets the org_read policies show every venue where the user is an active
 * owner. No venue is set, so anything without an org_read policy errors.
 */
export async function withOrgScope<T>(
  pool: pg.Pool,
  context: { readonly userId: string; readonly requestId?: string | undefined },
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await client.query("select set_config('app.scope', 'org', true)");
    await client.query("select set_config('app.user_id', $1, true)", [context.userId]);
    await client.query("select set_config('app.request_id', $1, true)", [context.requestId ?? ""]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function setContext(client: Queryable, context: RequestContext): Promise<void> {
  await client.query("select set_config('app.venue_id', $1, true)", [context.venueId]);
  await client.query("select set_config('app.user_id', $1, true)", [context.userId ?? ""]);
  await client.query("select set_config('app.request_id', $1, true)", [context.requestId ?? ""]);
}
