import type pg from "pg";
import type { Clock } from "@west4/shared";
import { withVenue, type Queryable } from "../tenancy.js";
import { claim, complete, fail, type JobPool, type JobRow } from "./queue.js";

export interface JobContext {
  readonly job: JobRow;
  readonly clock: Clock;
  /** Run one step in its own short transaction with the job's venue set. */
  step<T>(work: (client: Queryable) => Promise<T>): Promise<T>;
}

export type JobHandler = (context: JobContext) => Promise<void>;

export interface WorkerOptions {
  readonly pool: JobPool;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly clock: Clock;
  readonly pollMs?: number;
  readonly leaseSeconds?: number;
  readonly batch?: number;
  readonly log?: (line: string) => void;
  readonly random?: () => number;
}

/**
 * One worker for one pool. It claims due jobs in a short transaction, then
 * runs each job's handler; every handler step is its own venue transaction,
 * so no Stripe or Twilio call can happen inside one (the guard throws).
 */
export class Worker {
  private stopped = false;
  private loop: Promise<void> | undefined;
  readonly ran: string[] = [];

  constructor(
    private readonly db: pg.Pool,
    private readonly options: WorkerOptions,
  ) {}

  start(): void {
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  /** Claim and run one batch. Returns how many jobs ran. Used by the loop and by tests. */
  async tick(): Promise<number> {
    const now = this.options.clock.now();
    const jobs = await claim(
      this.db,
      this.options.pool,
      now,
      this.options.leaseSeconds ?? 60,
      this.options.batch ?? 10,
    );
    for (const job of jobs) await this.runOne(job);
    return jobs.length;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let ran = 0;
      try {
        ran = await this.tick();
      } catch (error) {
        this.options.log?.(
          `worker ${this.options.pool}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (ran === 0) await sleep(this.options.pollMs ?? 1000);
    }
  }

  private async runOne(job: JobRow): Promise<void> {
    const handler = this.options.handlers[job.kind];
    const context: JobContext = {
      job,
      clock: this.options.clock,
      step: (work) =>
        withVenue(this.db, { venueId: job.venue_id, requestId: `job:${job.id}` }, work),
    };
    try {
      if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
      await handler(context);
      this.ran.push(job.id);
      await context.step((c) => complete(c, job.id, this.options.clock.now()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await context.step((c) =>
        fail(c, job, message, this.options.clock.now(), this.options.random),
      );
      this.options.log?.(
        `job ${job.kind} ${job.id} failed (${job.attempts}/${job.max_attempts}): ${message} → ${outcome.status}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
