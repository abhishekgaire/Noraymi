import type pg from "pg";
import type { Temporal } from "@west4/shared";
import type { Queryable } from "../tenancy.js";
import { retryDelaySeconds } from "./backoff.js";

export type JobPool = "critical" | "normal" | "bulk";
export type JobStatus = "queued" | "running" | "done" | "dead";

export interface JobRow {
  readonly id: string;
  readonly venue_id: string;
  readonly kind: string;
  readonly pool: JobPool;
  readonly dedupe_key: string | null;
  readonly priority: number;
  readonly payload: unknown;
  readonly run_at: Date;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly locked_until: Date | null;
  readonly last_error: string | null;
  readonly status: JobStatus;
}

export interface EnqueueOptions {
  readonly venueId: string;
  readonly kind: string;
  readonly pool: JobPool;
  readonly runAt: Temporal.Instant;
  readonly payload?: unknown;
  readonly dedupeKey?: string | undefined;
  readonly priority?: number | undefined;
  readonly maxAttempts?: number | undefined;
}

/**
 * Add a job inside a venue transaction (the venue must match app.venue_id).
 * A dedupe key makes the insert a no-op when that key exists already, which
 * is how a scheduled run happens once per venue per date. Returns the id, or
 * null when the key was taken.
 */
export async function enqueue(client: Queryable, options: EnqueueOptions): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `insert into jobs (venue_id, kind, pool, dedupe_key, priority, payload, run_at, max_attempts)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (dedupe_key) do nothing
     returning id`,
    [
      options.venueId,
      options.kind,
      options.pool,
      options.dedupeKey ?? null,
      options.priority ?? 0,
      JSON.stringify(options.payload ?? {}),
      new Date(options.runAt.epochMilliseconds),
      options.maxAttempts ?? 5,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/** Claim up to `limit` due jobs of a pool with a lease. One short transaction of its own. */
export async function claim(
  pool: pg.Pool,
  jobPool: JobPool,
  now: Temporal.Instant,
  leaseSeconds: number,
  limit: number,
): Promise<JobRow[]> {
  const result = await pool.query<JobRow>(
    "select * from claim_jobs($1, $2, make_interval(secs => $3), $4)",
    [jobPool, new Date(now.epochMilliseconds), leaseSeconds, limit],
  );
  return result.rows;
}

/** Mark a claimed job done. Runs inside the job's venue transaction. */
export async function complete(
  client: Queryable,
  jobId: string,
  now: Temporal.Instant,
): Promise<void> {
  await client.query(
    "update jobs set status = 'done', locked_until = null, finished_at = $2 where id = $1 and status = 'running'",
    [jobId, new Date(now.epochMilliseconds)],
  );
}

/**
 * Record a failed attempt: back off and queue again, or after max_attempts
 * send the job to the dead letters with its last error. Returns what happened.
 */
export async function fail(
  client: Queryable,
  job: Pick<JobRow, "id" | "attempts" | "max_attempts">,
  error: string,
  now: Temporal.Instant,
  random: () => number = Math.random,
): Promise<{ status: "queued" | "dead"; runAt: Temporal.Instant | null }> {
  if (job.attempts >= job.max_attempts) {
    await client.query(
      "update jobs set status = 'dead', locked_until = null, last_error = $2, finished_at = $3 where id = $1",
      [job.id, error, new Date(now.epochMilliseconds)],
    );
    return { status: "dead", runAt: null };
  }
  const runAt = now.add({ seconds: retryDelaySeconds(job.attempts, random) });
  await client.query(
    "update jobs set status = 'queued', locked_until = null, last_error = $2, run_at = $3 where id = $1",
    [job.id, error, new Date(runAt.epochMilliseconds)],
  );
  return { status: "queued", runAt };
}
