import type { JobContext, JobHandler, Schedule } from "@west4/db";
import { REPLAY_DAYS } from "../http/idempotency.js";

/** A finished request replays its answer for 7 days; this daily job clears older keys (spec 08 · Idempotency). */
export const IDEMPOTENCY_CLEANUP_KIND = "idempotency.clear_old";

export const idempotencyCleanupSchedule: Schedule = {
  kind: IDEMPOTENCY_CLEANUP_KIND,
  at: "06:20",
  pool: "bulk",
};

export const idempotencyCleanupHandler: JobHandler = async ({ clock, step }: JobContext) => {
  const before = clock.now().subtract({ hours: 24 * REPLAY_DAYS });
  await step((c) =>
    c.query("select clear_idempotency_keys($1)", [new Date(before.epochMilliseconds)]),
  );
};
