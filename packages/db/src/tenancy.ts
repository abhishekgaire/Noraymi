import type pg from "pg";
import { runInTransactionScope } from "./outside-calls.js";

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
  /** An emergency action (M8-11): every audit row names it and its second approver on our side. */
  readonly emergency?: { readonly actionId: string; readonly approverId: string } | undefined;
}

export type Queryable = Pick<pg.PoolClient, "query">;

/**
 * Work that runs at the end of a venue transaction, just before it commits (D124: an approval the
 * venue doesn't ask for runs after the code that asked for it has written its own rows). Only a
 * withVenue transaction runs them; elsewhere `beforeCommit` answers false and the caller runs now.
 */
const commitHooks = new WeakMap<object, (() => Promise<void>)[]>();

export function beforeCommit(client: Queryable, work: () => Promise<void>): boolean {
  const hooks = commitHooks.get(client);
  if (!hooks) return false;
  hooks.push(work);
  return true;
}

export async function withVenue<T>(
  pool: pg.Pool,
  context: RequestContext,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await setContext(client, context);
    const hooks: (() => Promise<void>)[] = [];
    commitHooks.set(client, hooks);
    const result = await runInTransactionScope("venue transaction", async () => {
      const r = await work(client);
      for (let hook = hooks.shift(); hook; hook = hooks.shift()) await hook();
      return r;
    });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    commitHooks.delete(client);
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
    const result = await runInTransactionScope("org-scope transaction", () => work(client));
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
  if (context.emergency) {
    await client.query("select set_config('app.emergency_action_id', $1, true)", [
      context.emergency.actionId,
    ]);
    await client.query("select set_config('app.approver_id', $1, true)", [
      context.emergency.approverId,
    ]);
  }
}
