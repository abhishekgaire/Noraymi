import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FrozenClock, Temporal } from "@west4/shared";
import { assertOutsideTransaction } from "../outside-calls.js";
import { withVenue } from "../tenancy.js";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "../test-helpers.js";
import { StoredClock } from "./clock-store.js";
import { claim, enqueue, type JobRow } from "./queue.js";
import { Scheduler } from "./scheduler.js";
import { Worker } from "./worker.js";

let db: TestDatabase;
let pool: pg.Pool;
let v: TwoVenues;
const clock = new FrozenClock(Temporal.Instant.from("2026-09-26T02:41:00Z"));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

async function jobById(id: string, venueId: string): Promise<JobRow> {
  return withVenue(
    pool,
    { venueId },
    async (c) => (await c.query<JobRow>("select * from jobs where id = $1", [id])).rows[0]!,
  );
}

async function drain(worker: Worker): Promise<void> {
  while ((await worker.tick()) > 0) {
    /* keep claiming until the pool is empty */
  }
}

describe("jobs", () => {
  it("a failing job retries about 5 seconds later, backs off, and dies with last_error after max_attempts", async () => {
    const id = await withVenue(pool, { venueId: v.venueA }, (c) =>
      enqueue(c, {
        venueId: v.venueA,
        kind: "always.fails",
        pool: "normal",
        runAt: clock.now(),
        maxAttempts: 3,
      }),
    );
    const worker = new Worker(pool, {
      pool: "normal",
      clock,
      random: () => 0.5,
      handlers: {
        "always.fails": async () => {
          throw new Error("boom");
        },
      },
    });

    expect(await worker.tick()).toBe(1);
    let job = await jobById(id!, v.venueA);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBe("boom");
    expect(job.run_at.getTime() - clock.now().epochMilliseconds).toBe(5_000);

    expect(await worker.tick()).toBe(0);
    clock.advance(Temporal.Duration.from({ seconds: 5 }));
    expect(await worker.tick()).toBe(1);
    job = await jobById(id!, v.venueA);
    expect(job.attempts).toBe(2);
    expect(job.run_at.getTime() - clock.now().epochMilliseconds).toBe(10_000);

    clock.advance(Temporal.Duration.from({ seconds: 10 }));
    expect(await worker.tick()).toBe(1);
    job = await jobById(id!, v.venueA);
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(3);
    expect(job.last_error).toBe("boom");
    expect(await worker.tick()).toBe(0);
  });

  it("two workers claiming 100 jobs never run one twice, and a lost lease is picked up", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const venueId = i % 2 === 0 ? v.venueA : v.venueB;
      const id = await withVenue(pool, { venueId }, (c) =>
        enqueue(c, {
          venueId,
          kind: "count",
          pool: "critical",
          runAt: clock.now(),
          payload: { i },
        }),
      );
      ids.push(id!);
    }
    const seen: string[] = [];
    const handlers = {
      count: async ({ job }: { job: JobRow }) => {
        seen.push(job.id);
      },
    };
    const a = new Worker(pool, { pool: "critical", clock, handlers, batch: 7 });
    const b = new Worker(pool, { pool: "critical", clock, handlers, batch: 7 });
    await Promise.all([drain(a), drain(b)]);
    expect(seen.length).toBe(100);
    expect(new Set(seen).size).toBe(100);
    expect(new Set(ids)).toEqual(new Set(seen));

    const stuck = await withVenue(pool, { venueId: v.venueA }, (c) =>
      enqueue(c, { venueId: v.venueA, kind: "count", pool: "critical", runAt: clock.now() }),
    );
    const claimed = await claim(pool, "critical", clock.now(), 60, 1);
    expect(claimed.map((j) => j.id)).toEqual([stuck]);
    expect(await claim(pool, "critical", clock.now(), 60, 1)).toEqual([]);
    clock.advance(Temporal.Duration.from({ seconds: 61 }));
    const again = await claim(pool, "critical", clock.now(), 60, 1);
    expect(again.map((j) => j.id)).toEqual([stuck]);
    expect(again[0]?.attempts).toBe(2);
  });

  it("each handler step runs behind the venue wall, and an outside call inside a step throws", async () => {
    const id = await withVenue(pool, { venueId: v.venueA }, (c) =>
      enqueue(c, {
        venueId: v.venueA,
        kind: "walled",
        pool: "bulk",
        runAt: clock.now(),
        maxAttempts: 1,
      }),
    );
    let sawOwnVenue = false;
    let guardMessage = "";
    const worker = new Worker(pool, {
      pool: "bulk",
      clock,
      handlers: {
        walled: async ({ step }) => {
          const rows = await step((c) =>
            c.query<{ venue_id: string }>("select distinct venue_id from jobs"),
          );
          sawOwnVenue = rows.rowCount === 1 && rows.rows[0]?.venue_id === v.venueA;
          try {
            await step(async () => assertOutsideTransaction("stripe"));
          } catch (error) {
            guardMessage = (error as Error).message;
          }
          assertOutsideTransaction("stripe");
        },
      },
    });
    await worker.tick();
    expect(sawOwnVenue).toBe(true);
    expect(guardMessage).toMatch(/refusing to call stripe inside an open database transaction/);
    expect((await jobById(id!, v.venueA)).status).toBe("done");
  });

  it("only one scheduler leads at a time, and a crashed leader is replaced on the next try", async () => {
    const one = new Scheduler(pool, { schedules: [], clock });
    const two = new Scheduler(pool, { schedules: [], clock });
    expect(await one.tryLead()).toBe(true);
    expect(await two.tryLead()).toBe(false);
    await one.crash();
    expect(await two.tryLead()).toBe(true);
    await two.stop();
  });

  it("the scheduler queues each daily run once per venue and date, at the venue's wall-clock instant", async () => {
    const scheduler = new Scheduler(pool, {
      schedules: [{ kind: "nightly.close", at: "04:30", pool: "critical" }],
      clock,
    });
    expect(await scheduler.tryLead()).toBe(true);
    expect(await scheduler.tick()).toBe(4);
    expect(await scheduler.tick()).toBe(0);
    const rows = await withVenue(
      pool,
      { venueId: v.venueA },
      async (c) =>
        (
          await c.query<{ dedupe_key: string; run_at: Date }>(
            "select dedupe_key, run_at from jobs where kind = 'nightly.close' order by run_at",
          )
        ).rows,
    );
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      `nightly.close:${v.venueA}:2026-09-25`,
      `nightly.close:${v.venueA}:2026-09-26`,
    ]);
    expect(rows[0]?.run_at.toISOString()).toBe("2026-09-26T08:30:00.000Z");
    await scheduler.stop();
  });

  it("the stored clock is shared: set once, every process reads Friday 10:41 PM and it ticks", async () => {
    const real = new FrozenClock(Temporal.Instant.from("2030-01-01T00:00:00Z"));
    const api = new StoredClock(pool, 0, real);
    const worker = new StoredClock(pool, 0, real);
    await api.set(Temporal.Instant.from("2026-09-26T02:41:00Z"), "test");
    await worker.refresh(true);
    expect(worker.now().toString()).toBe("2026-09-26T02:41:00Z");
    real.advance(Temporal.Duration.from({ seconds: 30 }));
    expect(worker.now().toString()).toBe("2026-09-26T02:41:30Z");
    await api.set(null, "test");
    await worker.refresh(true);
    expect(worker.now().toString()).toBe(real.now().toString());
  });
});
