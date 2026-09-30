import type pg from "pg";
import { Temporal, SimulatedClock, systemClock, type Clock } from "@west4/shared";

/**
 * The shared simulated clock for staging and tests: the API, the workers and
 * the scheduler are separate processes, so the set point lives in the
 * clock_control row and each process re-reads it every few seconds.
 * Production never constructs this; it uses the system clock.
 */
export class StoredClock implements Clock {
  private simulated: SimulatedClock | undefined;
  private lastRead = 0;

  constructor(
    private readonly db: pg.Pool,
    private readonly refreshMs = 2000,
    private readonly real: Clock = systemClock,
  ) {}

  now(): Temporal.Instant {
    return this.simulated?.now() ?? this.real.now();
  }

  /** Re-read the control row (throttled). Call it from the request and worker loops. */
  async refresh(force = false): Promise<void> {
    const t = Date.now();
    if (!force && t - this.lastRead < this.refreshMs) return;
    this.lastRead = t;
    const row = await this.db.query<{ simulated_at: Date | null; real_at: Date | null }>(
      "select simulated_at, real_at from clock_control where id",
    );
    const r = row.rows[0];
    if (!r || r.simulated_at === null || r.real_at === null) {
      this.simulated = undefined;
      return;
    }
    // The stored point plus what has really passed since it was set.
    const setAt = Temporal.Instant.fromEpochMilliseconds(r.simulated_at.getTime());
    const realAt = Temporal.Instant.fromEpochMilliseconds(r.real_at.getTime());
    const clock = new SimulatedClock(setAt, this.real);
    clock.set(setAt.add(this.real.now().since(realAt)));
    this.simulated = clock;
  }

  /** Move the clock for every process. `at` null returns to real time. */
  async set(at: Temporal.Instant | null, setBy: string): Promise<void> {
    await this.db.query(
      "update clock_control set simulated_at = $1, real_at = $2, set_by = $3 where id",
      [
        at === null ? null : new Date(at.epochMilliseconds),
        at === null ? null : new Date(this.real.now().epochMilliseconds),
        setBy,
      ],
    );
    await this.refresh(true);
  }
}
