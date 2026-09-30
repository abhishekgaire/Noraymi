import type pg from "pg";
import type { Temporal } from "@west4/shared";
import { type Clock } from "@west4/shared";
import { businessDate, wallClock } from "@west4/rules";
import { withVenue } from "../tenancy.js";
import { enqueue, type JobPool } from "./queue.js";

/** A daily job at a wall-clock time of the venue's business date. */
export interface Schedule {
  readonly kind: string;
  /** "HH:MM" on the business date; a time before the cutover lands on the next calendar day. */
  readonly at: string;
  readonly pool: JobPool;
  readonly maxAttempts?: number;
}

export interface VenueClock {
  readonly id: string;
  readonly timeZone: string;
  /** "HH:MM" */
  readonly dayCutover: string;
}

/**
 * The run instant of a schedule on one business date, resolved in the
 * venue's zone with Temporal's compatible rule: a 1:30 AM job on Nov 1, 2026
 * gets the first 1:30; a 2:30 AM job on Mar 14, 2027 gets 3:30 AM EDT.
 */
export function runInstant(
  schedule: Schedule,
  venue: VenueClock,
  date: Temporal.PlainDate,
): Temporal.Instant {
  return wallClock(date, schedule.at, venue.timeZone, venue.dayCutover);
}

export function dedupeKey(schedule: Schedule, venueId: string, date: Temporal.PlainDate): string {
  return `${schedule.kind}:${venueId}:${date.toString()}`;
}

/**
 * Which (schedule, date) pairs should exist at `now`: today's business date
 * and the next one, so a job is queued well before it is due and each
 * (kind, venue, date) is queued exactly once through its dedupe key.
 */
export function plannedRuns(
  schedules: readonly Schedule[],
  venue: VenueClock,
  now: Temporal.Instant,
): { schedule: Schedule; date: Temporal.PlainDate; runAt: Temporal.Instant; key: string }[] {
  const today = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const runs = [];
  for (const schedule of schedules) {
    for (const date of [today, today.add({ days: 1 })]) {
      runs.push({
        schedule,
        date,
        runAt: runInstant(schedule, venue, date),
        key: dedupeKey(schedule, venue.id, date),
      });
    }
  }
  return runs;
}

const LEADER_LOCK_KEY = 0x77_34_73_63; // "w4sc"

/**
 * Work the leader does every so often between schedule ticks: a check that
 * has no run time of its own, such as the quiet-device sweep (M1-16). One
 * sweep's error is logged and never costs the leadership.
 */
export interface Sweep {
  readonly name: string;
  readonly everyMs: number;
  run(now: Temporal.Instant): Promise<void>;
}

export interface SchedulerOptions {
  readonly schedules: readonly Schedule[];
  readonly sweeps?: readonly Sweep[];
  readonly clock: Clock;
  readonly tickMs?: number;
  readonly log?: (line: string) => void;
}

/**
 * One scheduler leads at a time: it holds a session-level advisory lock on
 * its own connection, so if the process dies the lock goes with the
 * connection and another scheduler takes over on its next try. It runs in
 * UTC (instants) and works each run time out per venue and date.
 */
export class Scheduler {
  private client: pg.PoolClient | undefined;
  private stopped = false;
  private loop: Promise<void> | undefined;
  leader = false;

  constructor(
    private readonly db: pg.Pool,
    private readonly options: SchedulerOptions,
  ) {}

  start(): void {
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    await this.releaseLeadership();
  }

  /** Try to become leader; true when this scheduler holds the lock. */
  async tryLead(): Promise<boolean> {
    if (this.leader) return true;
    this.client ??= await this.db.connect();
    const result = await this.client.query<{ ok: boolean }>(
      "select pg_try_advisory_lock($1) as ok",
      [LEADER_LOCK_KEY],
    );
    this.leader = result.rows[0]?.ok === true;
    return this.leader;
  }

  async releaseLeadership(): Promise<void> {
    if (this.client) {
      if (this.leader)
        await this.client.query("select pg_advisory_unlock($1)", [LEADER_LOCK_KEY]).catch(() => {});
      this.client.release();
      this.client = undefined;
    }
    this.leader = false;
  }

  /** Simulate this process dying: drop the connection without unlocking. */
  async crash(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      this.client.release(new Error("crashed"));
      this.client = undefined;
    }
    this.leader = false;
    await this.loop;
  }

  /** One pass: for every venue, queue today's and tomorrow's runs. Returns how many were added. */
  async tick(): Promise<number> {
    const now = this.options.clock.now();
    const venues = await this.db.query<{ id: string; time_zone: string; day_cutover: string }>(
      "select id, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues_for_scheduler()",
    );
    let added = 0;
    for (const v of venues.rows) {
      const venue: VenueClock = { id: v.id, timeZone: v.time_zone, dayCutover: v.day_cutover };
      for (const run of plannedRuns(this.options.schedules, venue, now)) {
        const id = await withVenue(this.db, { venueId: venue.id, requestId: "scheduler" }, (c) =>
          enqueue(c, {
            venueId: venue.id,
            kind: run.schedule.kind,
            pool: run.schedule.pool,
            runAt: run.runAt,
            dedupeKey: run.key,
            maxAttempts: run.schedule.maxAttempts,
          }),
        );
        if (id !== null) added += 1;
      }
    }
    return added;
  }

  private readonly sweptAt = new Map<string, number>();

  /** Runs every sweep that is due at `now`. Returns the names run. */
  async runSweeps(now: Temporal.Instant = this.options.clock.now()): Promise<string[]> {
    const ran: string[] = [];
    for (const sweep of this.options.sweeps ?? []) {
      const last = this.sweptAt.get(sweep.name);
      if (last !== undefined && Date.now() - last < sweep.everyMs) continue;
      this.sweptAt.set(sweep.name, Date.now());
      try {
        await sweep.run(now);
        ran.push(sweep.name);
      } catch (error) {
        this.options.log?.(
          `sweep ${sweep.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return ran;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (await this.tryLead()) {
          await this.tick();
          await this.runSweeps();
        }
      } catch (error) {
        this.options.log?.(`scheduler: ${error instanceof Error ? error.message : String(error)}`);
        await this.releaseLeadership().catch(() => {});
      }
      await sleep(this.options.tickMs ?? 15_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
